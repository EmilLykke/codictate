/**
 * The socket half of the command line: a Unix domain socket on macOS and Linux, a named
 * pipe on Windows, both through `node:net`. One connection per command, UTF-8 NDJSON both
 * ways. Everything a connection means is `session.ts`; this file only moves lines.
 *
 * Starting the server is also how the app claims to be the only instance
 * (`single-instance.ts`): a second instance asks the first to show its window and quits.
 */

import { chmodSync, lstatSync, rmSync } from 'node:fs'
import net from 'node:net'
import {
  CONTRACT_VERSION,
  encodeLine,
  errorEvent,
  isTerminalEvent,
  type CommandRequest,
} from '../../shared/command-line-protocol'
import {
  prepareRunDir,
  prepareSocketDir,
  type CommandLineEndpoint,
} from './endpoint'
import { LineTooLongError, NdjsonLineSplitter } from './line-splitter'
import { createCommandLineSession, type CommandHandlers } from './session'
import {
  acquireInstanceLock,
  claimSingleInstance,
  type InstanceClaimSteps,
  type ListenOutcome,
} from './single-instance'

/**
 * A client that stops reading is not worth buffering progress for. Past this many unsent
 * bytes, progress events are dropped; the terminal event is always written.
 */
const PROGRESS_HIGH_WATER_BYTES = 64 * 1024

export interface CommandLineServer {
  /**
   * Stop listening, drop open connections, remove the socket file and release the instance
   * lock. Synchronous, for quit.
   */
  close(): void
}

export type CommandLineStart =
  | { status: 'serving'; server: CommandLineServer }
  /** Another Codictate owns the endpoint and was asked to show its window. Quit. */
  | { status: 'another-instance' }
  /** This is the only instance, but the command line could not start. Keep running. */
  | { status: 'unavailable'; error: unknown }

export interface CommandLineLog {
  (message: string, data?: Record<string, unknown>): void
}

function connect(
  endpoint: CommandLineEndpoint,
  timeoutMs: number
): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint.path)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(null)
    })
  })
}

/**
 * Whether another Codictate with this identifier is running, and if so, ask it to show its
 * window. Any listener on the endpoint counts as running, whether or not it answers in
 * time: two apps must never share one.
 */
export async function findRunningApp(
  endpoint: CommandLineEndpoint,
  { connectTimeoutMs = 1_000, answerTimeoutMs = 2_000, show = true } = {}
): Promise<boolean> {
  const socket = await connect(endpoint, connectTimeoutMs)
  if (!socket) return false
  // A hidden launch that lost the race only checks the winner is there: the command line
  // never opens a window.
  const request: CommandRequest = {
    contractVersion: CONTRACT_VERSION,
    command: show ? 'app.show' : 'status',
    args: {},
    caller: { name: 'Codictate', pid: process.pid },
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    }
    const timer = setTimeout(done, answerTimeoutMs)
    const splitter = new NdjsonLineSplitter()
    socket.on('data', (chunk: Buffer) => {
      try {
        if (splitter.push(chunk).length > 0) done()
      } catch {
        done()
      }
    })
    socket.once('close', done)
    socket.once('error', done)
    socket.write(encodeLine(request))
  })
  return true
}

/**
 * Windows: `\\.\pipe\<identifier>.<username>`. UNVERIFIED: Bun's `node:net` documents named
 * pipe support, but this has not been run on Windows hardware. libuv creates the first pipe
 * instance with `FILE_FLAG_FIRST_PIPE_INSTANCE` and reports a taken name as EADDRINUSE; whether
 * Bun's pipe server does the same is unverified, so a taken name is also asked for first
 * (`claimSingleInstance`), and EACCES counts as taken too: ERROR_ACCESS_DENIED is what
 * `CreateNamedPipe` itself returns for that conflict. The pipe is created with Windows'
 * default security descriptor.
 */
const PIPE_IN_USE_CODES = new Set(['EADDRINUSE', 'EACCES'])
const SOCKET_IN_USE_CODES = new Set(['EADDRINUSE'])

function listen(
  server: net.Server,
  path: string,
  inUseCodes: ReadonlySet<string>
): Promise<ListenOutcome> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      resolve(
        err.code && inUseCodes.has(err.code)
          ? { status: 'in-use' }
          : { status: 'failed', error: err }
      )
    }
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolve({ status: 'listening' })
    })
  })
}

function claimSteps(
  server: net.Server,
  endpoint: CommandLineEndpoint,
  showRunningApp: boolean
): InstanceClaimSteps {
  const common = {
    askRunningApp: () => findRunningApp(endpoint, { show: showRunningApp }),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
  if (endpoint.kind === 'named-pipe') {
    return {
      ...common,
      lock: null,
      prepare: () => {},
      socketFileExists: () => false,
      removeSocketFile: () => {},
      listen: () => listen(server, endpoint.path, PIPE_IN_USE_CODES),
    }
  }
  return {
    ...common,
    lock: async () => {
      try {
        prepareRunDir(endpoint.runDir)
      } catch (error) {
        return { status: 'failed', error }
      }
      return acquireInstanceLock(endpoint.lockPath)
    },
    prepare: () => prepareSocketDir(endpoint),
    socketFileExists: () => {
      try {
        lstatSync(endpoint.path)
        return true
      } catch {
        return false
      }
    },
    removeSocketFile: () => rmSync(endpoint.path, { force: true }),
    listen: async () => {
      const outcome = await listen(server, endpoint.path, SOCKET_IN_USE_CODES)
      if (outcome.status !== 'listening') return outcome
      try {
        chmodSync(endpoint.path, 0o600)
      } catch (error) {
        server.close()
        rmSync(endpoint.path, { force: true })
        return { status: 'failed', error }
      }
      return outcome
    },
  }
}

/**
 * Claim the endpoint and serve on it. Run before anything else boots: an
 * `another-instance` answer means quit at once.
 */
export async function startCommandLineServer(
  endpoint: CommandLineEndpoint,
  handlers: CommandHandlers,
  log: CommandLineLog = () => {},
  { showRunningApp = true }: { showRunningApp?: boolean } = {}
): Promise<CommandLineStart> {
  const sockets = new Set<net.Socket>()
  // Half-open so a peer's FIN does not close our side before we answer; we treat it as the
  // client going away ourselves, below.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    let ended = false
    const session = createCommandLineSession(
      handlers,
      {
        send(event) {
          if (ended || socket.destroyed) return
          if (
            !isTerminalEvent(event) &&
            socket.writableLength > PROGRESS_HIGH_WATER_BYTES
          ) {
            return
          }
          socket.write(encodeLine(event))
        },
        end() {
          ended = true
          socket.end()
        },
      },
      (command, err) => log('command failed', { command, err: String(err) })
    )
    const splitter = new NdjsonLineSplitter()
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = splitter.push(chunk)
      } catch (err) {
        if (!(err instanceof LineTooLongError)) throw err
        session.fail(errorEvent('usage', err.message))
        return
      }
      for (const line of lines) session.receiveLine(line)
    })
    // The client closing (or half-closing) before its answer is a cancel (docs/CLI.md).
    socket.on('end', () => {
      session.disconnected()
      if (!ended) socket.end()
    })
    socket.on('error', (err) => {
      log('connection error', { err: String(err) })
      session.disconnected()
      socket.destroy()
    })
    socket.on('close', () => {
      sockets.delete(socket)
      session.disconnected()
    })
  })

  const claim = await claimSingleInstance(
    claimSteps(server, endpoint, showRunningApp)
  )
  if (claim.status !== 'serving') return claim
  log('listening', { endpoint: endpoint.path })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (endpoint.kind === 'unix-socket') {
      // Ours: a later instance finds it live and leaves it alone, lock or no lock.
      try {
        rmSync(endpoint.path, { force: true })
      } catch {
        /* already gone */
      }
    }
    claim.release()
  }
  return { status: 'serving', server: { close } }
}
