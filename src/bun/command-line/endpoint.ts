/**
 * Where the command line finds the running app, and the hidden-launch marker the client
 * leaves before starting it. docs/CLI.md, "Wire protocol".
 *
 * Every path is keyed by the app's bundle identifier, so stable, canary and dev each have
 * their own socket and never answer for each other.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  type Stats,
} from 'node:fs'
import { join, posix } from 'node:path'

export type CommandLineEndpoint =
  | {
      kind: 'unix-socket'
      path: string
      /** `<data>/run`: the instance lock and the hidden-launch marker live here, always. */
      runDir: string
      /**
       * Where the socket lives: `runDir`, or `/tmp/codictate-<uid>` when the socket path in
       * `runDir` is longer than a Unix socket path may be.
       */
      socketDir: string
      /** The single-instance lock file, held for the app's lifetime (`single-instance.ts`). */
      lockPath: string
      /** The user the socket belongs to; `socketDir` under /tmp must be theirs. */
      uid: number
    }
  | { kind: 'named-pipe'; path: string }

/**
 * `sun_path` is 104 bytes on macOS, NUL included. The client (native/codictate-cli,
 * `app::socket_path`) applies the same limit, in UTF-8 bytes, so both sides pick one path.
 */
export const MAX_SOCKET_PATH_BYTES = 103

export function commandLineRunDir(appDataDir: string): string {
  return join(appDataDir, 'run')
}

/** The fallback socket directory, shared by every Codictate channel the user runs. */
export function sharedSocketDir(uid: number): string {
  return `/tmp/codictate-${uid}`
}

export function commandLineEndpoint(options: {
  platform: NodeJS.Platform
  appDataDir: string
  identifier: string
  username: string
  /** `process.getuid()`; unused on Windows. */
  uid: number
}): CommandLineEndpoint {
  if (options.platform === 'win32') {
    return {
      kind: 'named-pipe',
      path: `\\\\.\\pipe\\${options.identifier}.${options.username}`,
    }
  }
  const runDir = posix.join(options.appDataDir, 'run')
  const socketName = `${options.identifier}.sock`
  const preferred = posix.join(runDir, socketName)
  const socketDir =
    Buffer.byteLength(preferred, 'utf8') > MAX_SOCKET_PATH_BYTES
      ? sharedSocketDir(options.uid)
      : runDir
  return {
    kind: 'unix-socket',
    runDir,
    socketDir,
    path: posix.join(socketDir, socketName),
    lockPath: posix.join(runDir, `${options.identifier}.lock`),
    uid: options.uid,
  }
}

/**
 * Make the socket's directory private, and refuse it if it is not. `<data>/run` is ours to
 * create and tighten. The shared `/tmp/codictate-<uid>` is only created, never fixed up:
 * anyone can create a name in /tmp, so an existing one is used only when it is a real
 * directory (not a symlink), owned by `uid`, with mode exactly 0700. The client applies the
 * same check before it connects.
 */
export function prepareSocketDir(
  endpoint: Extract<CommandLineEndpoint, { kind: 'unix-socket' }>
): void {
  prepareRunDir(endpoint.runDir)
  if (endpoint.socketDir === endpoint.runDir) return
  let created = false
  try {
    mkdirSync(endpoint.socketDir, { mode: 0o700 })
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  // Ours and just made: only the umask stands between it and 0700.
  if (created) chmodSync(endpoint.socketDir, 0o700)
  const problem = privateDirProblem(endpoint.socketDir, endpoint.uid)
  if (problem) throw new Error(problem)
}

/** `<data>/run`, private to the user. */
export function prepareRunDir(runDir: string): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  chmodSync(runDir, 0o700)
}

/** Why `dir` is not a private directory of `uid`, or null when it is (or does not exist). */
export function privateDirProblem(dir: string, uid: number): string | null {
  let stats: Stats
  try {
    stats = lstatSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (!stats.isDirectory()) return `Refusing ${dir}: not a directory`
  if (stats.uid !== uid) {
    return `Refusing ${dir}: owned by uid ${stats.uid}, not ${uid}`
  }
  const mode = stats.mode & 0o7777
  if (mode !== 0o700) {
    return `Refusing ${dir}: mode ${mode.toString(8).padStart(4, '0')}, not 0700`
  }
  return null
}

export function hiddenLaunchMarkerPath(
  appDataDir: string,
  identifier: string
): string {
  return join(commandLineRunDir(appDataDir), `${identifier}.hidden-launch`)
}

/** How long a marker counts: the client waits 30 s for the app, so 60 s is generous. */
export const HIDDEN_LAUNCH_MAX_AGE_MS = 60_000

/** True when the marker holds a millisecond timestamp less than 60 s old. */
export function isFreshHiddenLaunchMarker(
  contents: string,
  nowMs: number
): boolean {
  const trimmed = contents.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const age = nowMs - Number(trimmed)
  // A little slack for a timestamp a hair ahead of ours; the client and the app share a clock.
  return age > -5_000 && age < HIDDEN_LAUNCH_MAX_AGE_MS
}

/**
 * Whether this launch was the command line's, which means: do not open the window. Read
 * without deleting, because two command-line calls racing to start the app can start two
 * instances, and the one that loses must see the marker too, or it asks the winner to show its
 * window. The winner removes it shortly after boot (`removeHiddenLaunchMarker`), and it ages out
 * regardless.
 */
export function readHiddenLaunchMarker(path: string, nowMs: number): boolean {
  try {
    return isFreshHiddenLaunchMarker(readFileSync(path, 'utf8'), nowMs)
  } catch {
    return false
  }
}

export function removeHiddenLaunchMarker(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* unreadable directory: the marker stays, and ages out */
  }
}
