/**
 * One command-line connection, without the socket.
 *
 * The transport feeds it lines and tells it when the peer went away; it answers through a
 * sink. Everything docs/CLI.md promises about a connection lives here: the first line is the
 * request, later lines are control lines, closing early is a cancel, and the connection ends
 * with exactly one `result` or `error`.
 */

import {
  errorEvent,
  parseControlLine,
  parseRequestLine,
  type CommandName,
  type CommandRequest,
  type CommandRequestOf,
  type CommandResults,
  type ErrorEvent,
  type ProgressLikeEvent,
  type ServerEvent,
} from '../../shared/command-line-protocol'

export interface CommandLineSink {
  send(event: ServerEvent): void
  /** Close the connection. Called once, right after the terminal event. */
  end(): void
}

export interface HandlerContext {
  /** A non-terminal event for the client. Dropped once the connection has its answer. */
  emit(event: ProgressLikeEvent): void
  /** Aborted on a `cancel` control line or when the client goes away. */
  signal: AbortSignal
  /**
   * `{"type":"stop"}` from the client. Only `dictate` is sent these. A stop that arrived
   * before the listener was added is delivered to it at once, so a quick Enter is not lost
   * while the handler is still starting.
   */
  onStop(listener: () => void): void
}

export type CommandHandler<C extends CommandName> = (
  request: CommandRequestOf<C>,
  context: HandlerContext
) => CommandResults[C] | ErrorEvent | Promise<CommandResults[C] | ErrorEvent>

export type CommandHandlers = { [C in CommandName]: CommandHandler<C> }

export interface CommandLineSession {
  receiveLine(line: string): void
  /** The peer closed the connection, or it broke. A command still running is cancelled. */
  disconnected(): void
  /** End the connection with this error, cancelling whatever runs. */
  fail(error: ErrorEvent): void
}

type SessionState = 'awaiting-request' | 'running' | 'finished'

export function createCommandLineSession(
  handlers: CommandHandlers,
  sink: CommandLineSink,
  onHandlerError: (command: CommandName, err: unknown) => void = () => {}
): CommandLineSession {
  let state: SessionState = 'awaiting-request'
  let command: CommandName | null = null
  const abort = new AbortController()
  const stopListeners: (() => void)[] = []
  let stopReceived = false

  const finish = (event: CommandResults[CommandName] | ErrorEvent) => {
    if (state === 'finished') return
    state = 'finished'
    sink.send(event)
    sink.end()
  }

  const context: HandlerContext = {
    emit: (event) => {
      if (state === 'running') sink.send(event)
    },
    signal: abort.signal,
    onStop: (listener) => {
      stopListeners.push(listener)
      if (stopReceived) listener()
    },
  }

  const run = (request: CommandRequest) => {
    state = 'running'
    command = request.command
    // The handler map is keyed by the request's own command, so this pairing is sound; TS
    // cannot correlate the two members of a union through an index.
    const handler = handlers[request.command] as CommandHandler<CommandName>
    Promise.resolve()
      .then(() => handler(request as CommandRequestOf<CommandName>, context))
      .then(finish, (err: unknown) => {
        onHandlerError(request.command, err)
        finish(errorEvent('internal', `${request.command} failed`))
      })
  }

  const receiveControl = (line: string) => {
    const control = parseControlLine(line)
    if (control === null) return
    if (control.type === 'cancel') {
      abort.abort()
      finish(errorEvent('cancelled', 'Cancelled'))
      return
    }
    if (command === 'dictate') {
      stopReceived = true
      for (const listener of stopListeners) listener()
    }
  }

  return {
    receiveLine(line) {
      if (state === 'finished') return
      if (state === 'running') {
        receiveControl(line)
        return
      }
      const parsed = parseRequestLine(line)
      if (!parsed.ok) {
        finish(parsed.error)
        return
      }
      run(parsed.request)
    },
    disconnected() {
      if (state === 'finished') return
      state = 'finished'
      abort.abort()
    },
    fail(error) {
      if (state === 'finished') return
      abort.abort()
      finish(error)
    },
  }
}
