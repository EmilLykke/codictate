import { drainReadableStream } from './drain-stream'

/** Three minutes covers normal local inference and Parakeet's first-device compilation. */
export const ENGINE_PROCESS_TIMEOUT_MS = 180_000

/** Time allowed for SIGTERM and for process pipes to close before cleanup stops waiting. */
export const ENGINE_PROCESS_CLEANUP_GRACE_MS = 2_000

/**
 * Give long recordings time in proportion to the work they contain.
 *
 * The one-minute fixed allowance covers process startup and model loading. Three times the
 * audio duration permits a real-time factor of 3 on a slow machine. The three-minute floor
 * keeps short clips and warmup tolerant of a cold model load. A supported 30-minute capture
 * therefore receives 91 minutes rather than being killed by the short-clip floor.
 */
export function engineProcessTimeoutMs(audioDurationMs?: number): number {
  if (
    audioDurationMs === undefined ||
    !Number.isFinite(audioDurationMs) ||
    audioDurationMs < 0
  ) {
    return ENGINE_PROCESS_TIMEOUT_MS
  }
  return Math.max(ENGINE_PROCESS_TIMEOUT_MS, 60_000 + audioDurationMs * 3)
}

interface SupervisableProcess {
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

export interface ProcessSupervisorClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ProcessSupervisionOptions {
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  timeoutMs?: number
  cleanupGraceMs?: number
  /** Test seam for advancing deadlines without sleeping. */
  clock?: ProcessSupervisorClock
}

export type SupervisedProcessResult =
  | {
      status: 'exited'
      exitCode: number
      stdout: Uint8Array
      stderr: Uint8Array
      /** False when a pipe did not close cleanly within the bounded drain period. */
      outputComplete: boolean
    }
  | {
      status: 'timed_out'
      stdout: Uint8Array
      stderr: Uint8Array
    }

const systemClock: ProcessSupervisorClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function deadline(
  clock: ProcessSupervisorClock,
  delayMs: number
): {
  promise: Promise<void>
  cancel: () => void
} {
  let handle: unknown
  const promise = new Promise<void>((resolve) => {
    handle = clock.setTimeout(resolve, delayMs)
  })
  return { promise, cancel: () => clock.clearTimeout(handle) }
}

interface CapturedStream {
  bytes: Uint8Array
  failed: boolean
}

function capture(
  stream: ReadableStream<Uint8Array> | undefined,
  signal: AbortSignal
): Promise<CapturedStream> {
  return drainReadableStream(stream, signal).then(
    (bytes) => ({ bytes, failed: false }),
    () => ({ bytes: new Uint8Array(0), failed: true })
  )
}

/**
 * Run one already-spawned engine process under a deadline and drain both pipes concurrently.
 *
 * At the deadline the process receives SIGTERM, its pipe readers are cancelled, and exit is
 * awaited only for `cleanupGraceMs`. A process that ignores SIGTERM receives SIGKILL, after
 * which this function returns without trusting `proc.exited` to settle. The same bound also
 * covers pipes that remain open after an otherwise normal process exit.
 */
export async function superviseProcess(
  proc: SupervisableProcess,
  options: ProcessSupervisionOptions = {}
): Promise<SupervisedProcessResult> {
  const timeoutMs = options.timeoutMs ?? ENGINE_PROCESS_TIMEOUT_MS
  const cleanupGraceMs =
    options.cleanupGraceMs ?? ENGINE_PROCESS_CLEANUP_GRACE_MS
  const clock = options.clock ?? systemClock
  const drainsAbort = new AbortController()
  const stdout = capture(options.stdout, drainsAbort.signal)
  const stderr = capture(options.stderr, drainsAbort.signal)
  const exited = proc.exited.then((exitCode) => ({ exitCode }))
  const processDeadline = deadline(clock, timeoutMs)

  const first = await Promise.race([
    exited.then((value) => ({ kind: 'exited' as const, ...value })),
    processDeadline.promise.then(() => ({ kind: 'timed_out' as const })),
  ])
  processDeadline.cancel()

  if (first.kind === 'timed_out') {
    try {
      proc.kill('SIGTERM')
    } catch {
      // The process may have exited in the same turn as the deadline.
    }
    drainsAbort.abort()

    const terminationDeadline = deadline(clock, cleanupGraceMs)
    const terminated = await Promise.race([
      exited.then(() => true),
      terminationDeadline.promise.then(() => false),
    ])
    terminationDeadline.cancel()
    if (!terminated) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Cleanup remains bounded even when the process handle rejects a second signal.
      }
    }

    const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr])
    return {
      status: 'timed_out',
      stdout: stdoutResult.bytes,
      stderr: stderrResult.bytes,
    }
  }

  const drainDeadline = deadline(clock, cleanupGraceMs)
  const drains = Promise.all([stdout, stderr])
  const outputComplete = await Promise.race([
    drains.then(() => true),
    drainDeadline.promise.then(() => false),
  ])
  drainDeadline.cancel()
  if (!outputComplete) drainsAbort.abort()
  const [stdoutResult, stderrResult] = await drains

  return {
    status: 'exited',
    exitCode: first.exitCode,
    stdout: stdoutResult.bytes,
    stderr: stderrResult.bytes,
    outputComplete:
      outputComplete && !stdoutResult.failed && !stderrResult.failed,
  }
}
