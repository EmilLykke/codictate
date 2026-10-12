/**
 * Codictate runs once per user and bundle identifier. Two full instances would mean two
 * keyboard hooks, two trays and every Dictation twice, so this decides, before anything else
 * boots, whether this process is the one, and never guesses in its own favour.
 *
 * Unix: an exclusive `flock` on `<data>/run/<identifier>.lock`, held for the app's lifetime.
 * The kernel drops it when the process dies, however it dies, so there is no stale lock to
 * recover and no pid to outlive its process (a pid file with `kill(pid, 0)` recovery can be
 * fooled by a reused pid, and two processes recovering the same stale file can both win).
 * Only the holder may remove a socket file: a stale one left by a crash is removed under the
 * lock, so two launches can no longer each delete the other's live socket.
 *
 * Windows: the pipe name is the lock. Whoever listens on it is the running app; a listen that
 * fails because the name is taken means another instance has it, or is about to.
 *
 * The decision is `claimSingleInstance`, over injected steps, so it is tested without a socket.
 */

import {
  closeSync,
  constants,
  ftruncateSync,
  openSync,
  writeSync,
} from 'node:fs'

export type LockOutcome =
  | { status: 'acquired'; release(): void }
  /** Another process holds it: a running or starting Codictate. */
  | { status: 'held' }
  /** The lock could not be taken for some other reason (file system, platform). */
  | { status: 'failed'; error: unknown }

export type ListenOutcome =
  | { status: 'listening' }
  /** The address is taken: another instance is listening. */
  | { status: 'in-use' }
  | { status: 'failed'; error: unknown }

export type InstanceClaim =
  /** This is the app. `release` drops the lock; call it only on the way out. */
  | { status: 'serving'; release(): void }
  /** Another instance owns the command line (and was asked to show its window): quit. */
  | { status: 'another-instance' }
  /**
   * This is the app, but the command line cannot start for a reason unrelated to another
   * instance. Keep running without it; the lock, if any, stays held.
   */
  | { status: 'unavailable'; error: unknown }

export interface InstanceClaimSteps {
  /** Unix: take the lock file. `null` on Windows, where the pipe name is the lock. */
  lock: (() => Promise<LockOutcome>) | null
  /** Unix: create and check the socket's directory. Throws when it is unusable. */
  prepare(): void
  /** Unix: whether something (a live socket or a crashed app's) sits at the socket path. */
  socketFileExists(): boolean
  removeSocketFile(): void
  listen(): Promise<ListenOutcome>
  /** `findRunningApp`: true when something answers on the endpoint; it was asked to show. */
  askRunningApp(): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

export interface InstanceClaimTiming {
  /** How long to wait for an instance that holds the lock or the address to answer. */
  waitForOwnerMs: number
  retryEveryMs: number
}

const DEFAULT_TIMING: InstanceClaimTiming = {
  waitForOwnerMs: 5_000,
  retryEveryMs: 250,
}

export async function claimSingleInstance(
  steps: InstanceClaimSteps,
  timing: InstanceClaimTiming = DEFAULT_TIMING
): Promise<InstanceClaim> {
  const lock = steps.lock ? await steps.lock() : null
  const release = () => {
    if (lock?.status === 'acquired') lock.release()
  }
  const anotherInstance = (): InstanceClaim => {
    release()
    return { status: 'another-instance' }
  }

  /**
   * Someone owns the lock or the address but may still be booting: give it a moment to
   * answer (so the user's window comes up), then quit whether or not it did. Never become a
   * second instance because the first was slow.
   */
  const waitForOwner = async (): Promise<InstanceClaim> => {
    const deadline = steps.now() + timing.waitForOwnerMs
    while (!(await steps.askRunningApp()) && steps.now() < deadline) {
      await steps.sleep(timing.retryEveryMs)
    }
    return anotherInstance()
  }

  if (lock?.status === 'held') return waitForOwner()

  try {
    steps.prepare()
  } catch (error) {
    return { status: 'unavailable', error }
  }

  if (lock === null) {
    // Windows: a second listen on a taken pipe name may succeed, so ask first.
    if (await steps.askRunningApp()) return anotherInstance()
  } else if (steps.socketFileExists()) {
    // A live socket without the lock is a build that predates it; a dead one is a crash's.
    if (await steps.askRunningApp()) return anotherInstance()
    if (lock.status !== 'acquired') {
      return {
        status: 'unavailable',
        error: new Error(
          'A stale command-line socket is in the way and the instance lock could not be taken to remove it'
        ),
      }
    }
    steps.removeSocketFile()
  }

  const listened = await steps.listen()
  switch (listened.status) {
    case 'listening':
      return { status: 'serving', release }
    case 'in-use':
      return waitForOwner()
    case 'failed':
      return { status: 'unavailable', error: listened.error }
  }
}

// ── The Unix lock file ─────────────────────────────────────────────────────

const LOCK_EX = 2
const LOCK_NB = 4

/** macOS `open(2)` flags: take an exclusive flock atomically with the open, without waiting. */
const DARWIN_O_EXLOCK = 0x20
const DARWIN_O_NONBLOCK = 0x4

interface LinuxFlock {
  flock(fd: number, operation: number): number
  errno(): number
}

let linuxFlock: LinuxFlock | null = null

/** Linux has no `O_EXLOCK`; `flock(2)` from libc through `bun:ffi`. */
async function loadLinuxFlock(): Promise<LinuxFlock> {
  if (linuxFlock) return linuxFlock
  const { dlopen, FFIType, read } = await import('bun:ffi')
  const libc = dlopen('libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  linuxFlock = {
    flock: (fd, operation) => libc.symbols.flock(fd, operation),
    errno: () => {
      const location = libc.symbols.__errno_location()
      return location === null ? 0 : read.i32(location, 0)
    },
  }
  return linuxFlock
}

const LINUX_EINTR = 4
/**
 * The errnos that mean "flock cannot work here" (EBADF, EINVAL, ENOLCK, EOPNOTSUPP). Any other
 * failure, EWOULDBLOCK included, reads as held: errno is read in a second call, and guessing
 * wrong in that direction costs a launch, while the other way costs a second instance.
 */
const LINUX_FLOCK_UNSUPPORTED = new Set([9, 22, 37, 95])

function writePid(fd: number) {
  // For whoever looks at the file; the lock, not the pid, decides.
  try {
    ftruncateSync(fd, 0)
    writeSync(fd, `${process.pid}\n`, 0)
  } catch {
    /* the lock is what matters */
  }
}

function acquired(fd: number): LockOutcome {
  writePid(fd)
  let released = false
  return {
    status: 'acquired',
    release() {
      if (released) return
      released = true
      // Never unlinked: removing a locked file lets a third process lock a new inode at the
      // same path while a second still waits on the old one.
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    },
  }
}

/**
 * Take `path`'s exclusive lock without waiting. The file is created if missing and never
 * deleted. Hold the returned lock for the life of the process; the OS releases it on exit.
 */
export async function acquireInstanceLock(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<LockOutcome> {
  const flags = constants.O_RDWR | constants.O_CREAT
  try {
    if (platform === 'darwin') {
      try {
        return acquired(
          openSync(path, flags | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK, 0o600)
        )
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK')
          return { status: 'held' }
        throw err
      }
    }
    const libc = await loadLinuxFlock()
    const fd = openSync(path, flags, 0o600)
    for (;;) {
      if (libc.flock(fd, LOCK_EX | LOCK_NB) === 0) return acquired(fd)
      const errno = libc.errno()
      if (errno === LINUX_EINTR) continue
      closeSync(fd)
      if (!LINUX_FLOCK_UNSUPPORTED.has(errno)) return { status: 'held' }
      return {
        status: 'failed',
        error: new Error(`flock(${path}) failed with errno ${errno}`),
      }
    }
  } catch (error) {
    return { status: 'failed', error }
  }
}
