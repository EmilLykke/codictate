/**
 * A Batch Dictation's Parakeet Native Helper, spawned when recording starts so the model
 * loads while the user speaks.
 *
 * Loading Parakeet takes about 0.15 s when its weights are already prepared for this device,
 * and 12 to 19 s on the Mac when they are not (a Parakeet Preparation). Nobody can tell
 * which ahead of the load. Spawned after the recording stops, a Preparation is paid in full
 * while the user waits for their text. Spawned when it starts, most of it is paid while they
 * are still speaking, and nothing loads when nobody dictates. iOS does the same, and Live
 * Transcription always has: its helper opens the microphone and loads in one process.
 *
 * The helper runs `transcribe-session <modelDir>` (`src/shared/parakeet-session-protocol.ts`):
 * it loads the model, writes `ready`, then answers one `{id, audioPath}` line with a `final`
 * that carries the same text and `timing` as the one-shot `transcribe`. Closing its stdin
 * makes it exit.
 *
 * One session is one Dictation. Its owner either calls `transcribe` once, after which the
 * session closes itself on every path, or `discard`, which kills the helper at once: a
 * cancelled, discarded or too-short recording never leaves a helper running. App quit kills
 * whatever is left (`killParakeetSessions`).
 *
 * Two bounds, and neither is the recording's length:
 * - **The load** has `PARAKEET_SESSION_LOAD_TIMEOUT_MS` from the spawn. A helper still not
 *   ready by then is wedged, and is killed even while the user is still speaking.
 * - **The request** has the Request's `timeoutMs`, from the moment it is written. A
 *   recording can last minutes, so a deadline from the spawn would kill a healthy helper.
 *
 * No fallback: a session that failed to load fails the Dictation with a typed reason. It
 * never spawns a second helper behind the user's back. ADR-0005, ADR-0006.
 */

import { existsSync } from 'node:fs'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import {
  PARAKEET_TRANSCRIBE_SESSION_COMMAND,
  encodeParakeetSessionRequest,
  parseParakeetSessionResponse,
} from '../../../../shared/parakeet-session-protocol'
import { PARAKEET_ENGINE_ID } from '../../../../shared/speech-models'
import type { RunnableDictationPlan } from '../../../../shared/dictation-plan'
import { requireRuntimeBinary } from '../../../platform/binaries'
import { log } from '../../logger'
import { parseParakeetFinal, type ParakeetFinal } from './parakeet-output'
import { lowerProcessPriority } from './process-priority'
import {
  ENGINE_PROCESS_CLEANUP_GRACE_MS,
  ENGINE_PROCESS_TIMEOUT_MS,
  type ProcessSupervisorClock,
} from './process-supervisor'
import {
  failedTranscription,
  type FailedTranscription,
  type ParakeetTranscriptionRequest,
} from './transcription'

/**
 * How long a session may take to load before it counts as wedged, measured from the spawn.
 * The same three minutes a one-shot run gets, which covers a Parakeet Preparation many times.
 */
export const PARAKEET_SESSION_LOAD_TIMEOUT_MS = ENGINE_PROCESS_TIMEOUT_MS

/** The one request id a Dictation's session ever sees. */
const DICTATION_REQUEST_ID = 1

const STDERR_TAIL_CHARS = 4_000

/** A Batch Dictation spawns a session at record start exactly when its plan runs on Parakeet. */
export function spawnsParakeetSessionAtRecordStart(
  plan: RunnableDictationPlan
): boolean {
  return plan.mode === 'batch' && plan.engineId === PARAKEET_ENGINE_ID
}

// ── Process I/O, shared with the benchmark's session ────────────────────────────

interface SessionInput {
  write(data: string | Uint8Array): unknown
  flush?(): unknown
  end(): unknown
}

/** What a session needs of a spawned helper. `Bun.spawn` with three pipes satisfies it. */
export interface ParakeetSessionProcess {
  readonly pid?: number
  readonly stdin: SessionInput
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr?: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

/** Reads a helper's stdout one line at a time, strict UTF-8. */
export class NdjsonLineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private buffered = ''
  private ended = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  /** The next line without its newline, or `null` at end of stream. */
  async nextLine(): Promise<string | null> {
    while (true) {
      const newline = this.buffered.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/, '')
        this.buffered = this.buffered.slice(newline + 1)
        return line
      }

      if (this.ended) {
        if (this.buffered === '') return null
        const line = this.buffered.replace(/\r$/, '')
        this.buffered = ''
        return line
      }

      const { done, value } = await this.reader.read()
      if (done) {
        this.buffered += this.decoder.decode()
        this.ended = true
      } else if (value) {
        this.buffered += this.decoder.decode(value, { stream: true })
      }
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel()
    } catch {
      // The process may have closed the pipe in the same turn.
    }
  }
}

export interface StderrCollector {
  readonly completed: Promise<void>
  tail(): string
  cancel(): Promise<void>
}

/** Drains stderr as it arrives, so the helper never blocks on a full pipe, and keeps the tail. */
export function collectStderr(
  stream?: ReadableStream<Uint8Array>
): StderrCollector {
  if (!stream) {
    return {
      completed: Promise.resolve(),
      tail: () => '',
      cancel: async () => {},
    }
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const completed = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        text = (text + decoder.decode(value, { stream: true })).slice(
          -STDERR_TAIL_CHARS
        )
      }
      text = (text + decoder.decode()).slice(-STDERR_TAIL_CHARS)
    } catch {
      // Cancellation is normal during a deadline or protocol failure.
    }
  })()

  return {
    completed,
    tail: () => text.trim(),
    cancel: async () => {
      try {
        await reader.cancel()
      } catch {
        // The process may have closed the pipe in the same turn.
      }
    },
  }
}

// ── The Dictation's session ─────────────────────────────────────────────────────

/** What a session's one request produced: the helper's `final`, or why there is none. */
export type ParakeetSessionRun =
  { status: 'final'; final: ParakeetFinal } | FailedTranscription

export interface ParakeetSession {
  /**
   * Send the recording, after waiting for the load if it is still running, and read the
   * `final`. Called at most once. The session closes itself afterwards, whatever happened.
   */
  transcribe(request: ParakeetTranscriptionRequest): Promise<ParakeetSessionRun>
  /**
   * This Dictation will not be transcribed: kill the helper now. Idempotent, and a no-op once
   * `transcribe` has been called, because `transcribe` owns the cleanup from then on.
   */
  discard(): void
}

export interface ParakeetSessionDeps {
  /** The Native Helper's path. Throws when it is not in the installation. */
  resolveHelperBinary: () => string
  modelDirExists: (modelDir: string) => boolean
  spawn: (argv: string[]) => ParakeetSessionProcess
  clock: ProcessSupervisorClock
  lowerPriority: (pid: number) => void
  loadTimeoutMs: number
  cleanupGraceMs: number
}

const systemClock: ProcessSupervisorClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const realDeps: ParakeetSessionDeps = {
  resolveHelperBinary: () => requireRuntimeBinary('parakeet'),
  modelDirExists: existsSync,
  spawn: (argv) =>
    Bun.spawn(argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    }) as unknown as ParakeetSessionProcess,
  clock: systemClock,
  lowerPriority: (pid) => {
    lowerProcessPriority(pid, 'parakeet')
  },
  loadTimeoutMs: PARAKEET_SESSION_LOAD_TIMEOUT_MS,
  cleanupGraceMs: ENGINE_PROCESS_CLEANUP_GRACE_MS,
}

/** Every session helper that has not exited yet, for app quit. */
const liveProcesses = new Set<ParakeetSessionProcess>()

/**
 * App quit: kill every session helper still running. Synchronous, so it can run from
 * `process.on('exit')`.
 */
export function killParakeetSessions(): void {
  for (const proc of liveProcesses) {
    try {
      proc.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  liveProcesses.clear()
}

/**
 * The pre-spawn race check, both halves: the Native Helper is still in the installation, and
 * the weights are still on disk. Whether that directory is *complete* was answered when the
 * plan was built; what a race can change is whether it is there at all. Shared by the
 * one-shot spawn and the session spawn, so the two cannot answer it differently.
 */
export function checkParakeetRuntime(
  speechModelId: string,
  modelDir: string,
  deps: Pick<
    ParakeetSessionDeps,
    'resolveHelperBinary' | 'modelDirExists'
  > = realDeps
): { helper: string } | FailedTranscription {
  let helper: string
  try {
    helper = deps.resolveHelperBinary()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log('parakeet', 'helper binary missing at spawn time', { err: detail })
    return failedTranscription('engine_runtime_missing', speechModelId, detail)
  }
  if (!deps.modelDirExists(modelDir)) {
    log('parakeet', 'weights missing at spawn time', {
      modelId: speechModelId,
      modelDir,
    })
    return failedTranscription(
      'engine_runtime_missing',
      speechModelId,
      `weights not on disk: ${modelDir}`
    )
  }
  return { helper }
}

function deadline(
  clock: ProcessSupervisorClock,
  delayMs: number
): { promise: Promise<void>; cancel(): void } {
  let handle: unknown
  const promise = new Promise<void>((resolve) => {
    handle = clock.setTimeout(resolve, Math.max(0, delayMs))
  })
  return { promise, cancel: () => clock.clearTimeout(handle) }
}

function aborted(signal: AbortSignal | undefined): {
  promise: Promise<void>
  dispose(): void
} {
  if (signal === undefined) {
    return { promise: new Promise<void>(() => {}), dispose: () => {} }
  }
  let onAbort = () => {}
  const promise = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  }
}

/** A session that never spawned: its one answer is the reason. */
function failedSession(failure: FailedTranscription): ParakeetSession {
  return {
    transcribe: async () => failure,
    discard: () => {},
  }
}

type LineWait =
  | { kind: 'line'; line: string | null }
  | { kind: 'read_error'; error: unknown }
  | { kind: 'exited' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

/**
 * Spawn the helper for one Batch Dictation and start its load. Returns at once: the load
 * runs while the user speaks, and `transcribe` waits for whatever is left of it.
 */
export function startParakeetSession(
  target: { speechModelId: string; modelDir: string },
  overrides: Partial<ParakeetSessionDeps> = {}
): ParakeetSession {
  const deps: ParakeetSessionDeps = { ...realDeps, ...overrides }
  const { speechModelId, modelDir } = target

  const checked = checkParakeetRuntime(speechModelId, modelDir, deps)
  if ('status' in checked) return failedSession(checked)

  let proc: ParakeetSessionProcess
  try {
    proc = deps.spawn([
      checked.helper,
      PARAKEET_TRANSCRIBE_SESSION_COMMAND,
      modelDir,
    ])
  } catch (err) {
    log('parakeet', 'could not spawn session helper', { err: String(err) })
    return failedSession(
      failedTranscription(
        'engine_exited_nonzero',
        speechModelId,
        `could not spawn the Parakeet session: ${String(err)}`
      )
    )
  }
  const spawnedAt = performance.now()
  log('parakeet', 'session spawned at record start', {
    helper: checked.helper,
    modelDir,
    pid: proc.pid,
  })

  liveProcesses.add(proc)
  let exitCode: number | null = null
  const exited = proc.exited.then(
    (code) => code,
    () => -1
  )
  void exited.then((code) => {
    exitCode = code
    liveProcesses.delete(proc)
  })
  const stdout = new NdjsonLineReader(proc.stdout)
  const stderr = collectStderr(proc.stderr)

  /** `transcribe` was called: from then on it owns the cleanup. */
  let used = false
  /** The owner said this Dictation will not transcribe. */
  let discarded = false

  const diagnostic = (detail: string) => {
    const tail = stderr.tail()
    return tail === '' ? detail : `${detail}: ${tail}`
  }

  const waitForExit = async (): Promise<boolean> => {
    if (exitCode !== null) return true
    const grace = deadline(deps.clock, deps.cleanupGraceMs)
    const done = await Promise.race([
      exited.then(() => true),
      grace.promise.then(() => false),
    ])
    grace.cancel()
    return done
  }

  const cancelReaders = async () => {
    const grace = deadline(deps.clock, deps.cleanupGraceMs)
    await Promise.race([
      Promise.all([stdout.cancel(), stderr.cancel()]),
      grace.promise,
    ])
    grace.cancel()
  }

  /** SIGTERM, then SIGKILL after the grace period. Bounded, and safe to call twice. */
  const terminate = async () => {
    if (exitCode === null) {
      try {
        proc.kill('SIGTERM')
      } catch {
        // It may already have exited.
      }
      if (!(await waitForExit())) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Cleanup stays bounded if a second signal is rejected.
        }
      }
    }
    liveProcesses.delete(proc)
    await cancelReaders()
  }

  /** After the `final`: close stdin so the helper exits on its own, and make sure it did. */
  const closeGracefully = async () => {
    try {
      proc.stdin.end()
    } catch {
      // Fall through to the bounded termination path.
    }
    if (!(await waitForExit())) await terminate()
    else {
      liveProcesses.delete(proc)
      await cancelReaders()
    }
  }

  /**
   * The next stdout line, unless something else happens first. Exit is noticed through end of
   * stream; the grace period after it covers a pipe some other process still holds open.
   */
  const nextLine = (
    until: Promise<void>,
    signal: Promise<void>
  ): Promise<LineWait> =>
    Promise.race<LineWait>([
      stdout.nextLine().then(
        (line) => ({ kind: 'line', line }),
        (error) => ({ kind: 'read_error', error })
      ),
      exited
        .then(() => deadline(deps.clock, deps.cleanupGraceMs).promise)
        .then(() => ({ kind: 'exited' })),
      until.then(() => ({ kind: 'timeout' })),
      signal.then(() => ({ kind: 'aborted' })),
    ])

  /** Why the helper stopped answering, once its stdout has ended. */
  const failureAfterEnd = async (
    phase: 'load' | 'request'
  ): Promise<FailedTranscription> => {
    await waitForExit()
    const grace = deadline(deps.clock, deps.cleanupGraceMs)
    await Promise.race([stderr.completed, grace.promise])
    grace.cancel()
    return failedTranscription(
      exitCode === 0 && phase === 'request'
        ? 'parakeet_no_final_line'
        : 'engine_exited_nonzero',
      speechModelId,
      diagnostic(
        phase === 'load'
          ? `exited with code ${exitCode ?? 'unknown'} before it was ready`
          : `exited with code ${exitCode ?? 'unknown'} before its final line`
      )
    )
  }

  // The load, from the spawn. It never rejects, and it kills a wedged helper on its own.
  const loadDeadline = deadline(deps.clock, deps.loadTimeoutMs)
  const never = new Promise<void>(() => {})
  const loaded: Promise<FailedTranscription | null> = (async () => {
    try {
      while (true) {
        const waited = await nextLine(loadDeadline.promise, never)
        if (waited.kind === 'line' && waited.line !== null) {
          const response = parseParakeetSessionResponse(waited.line)
          // Anything that is not a protocol line is noise from the model runtime, skipped
          // as the one-shot reader skips it.
          if (response === null) continue
          if (response.kind === 'ready') {
            log('parakeet', 'session ready', {
              // About 150 ms for prepared weights; seconds means a Parakeet Preparation.
              loadMs: Math.round(performance.now() - spawnedAt),
            })
            return null
          }
          void terminate()
          return failedTranscription(
            'engine_output_unreadable',
            speechModelId,
            diagnostic(`expected ready, received ${waited.line}`)
          )
        }
        if (waited.kind === 'timeout') {
          log('parakeet', 'session did not load in time, killing it', {
            loadTimeoutMs: deps.loadTimeoutMs,
          })
          const failure = failedTranscription(
            'engine_timed_out',
            speechModelId,
            diagnostic(`not ready within ${deps.loadTimeoutMs} ms of the spawn`)
          )
          await terminate()
          return failure
        }
        if (waited.kind === 'read_error') {
          void terminate()
          return failedTranscription(
            'engine_output_unreadable',
            speechModelId,
            diagnostic(`could not read the ready line: ${String(waited.error)}`)
          )
        }
        // End of stream or exit: the load failed.
        const failure = await failureAfterEnd('load')
        log('parakeet', 'session failed to load', {
          exitCode,
          diagnostic: failure.diagnostic,
        })
        void terminate()
        return failure
      }
    } catch (err) {
      void terminate()
      return failedTranscription(
        'engine_exited_nonzero',
        speechModelId,
        diagnostic(String(err))
      )
    } finally {
      loadDeadline.cancel()
    }
  })()

  return {
    discard() {
      if (used || discarded) return
      discarded = true
      log('parakeet', 'session discarded: the Dictation will not transcribe')
      void terminate()
    },

    async transcribe(request) {
      if (used) {
        return failedTranscription(
          'engine_output_unreadable',
          speechModelId,
          'a Parakeet session answers one request'
        )
      }
      used = true
      if (discarded) return failedTranscription('cancelled', speechModelId)

      const signal = aborted(request.signal)
      try {
        const cancelled = async () => {
          log('parakeet', 'helper cancelled', { modelId: speechModelId })
          await terminate()
          return failedTranscription('cancelled', speechModelId)
        }
        if (request.signal?.aborted) return await cancelled()

        // The load: usually long over by now. When it is not, this wait is the rest of it,
        // and the indicator already says transcribing.
        const load = await Promise.race([
          loaded,
          signal.promise.then(() => 'aborted' as const),
        ])
        if (load === 'aborted') return await cancelled()
        if (load !== null) return load

        if (request.lowPriority && proc.pid !== undefined) {
          deps.lowerPriority(proc.pid)
        }

        try {
          proc.stdin.write(
            `${encodeParakeetSessionRequest({
              id: DICTATION_REQUEST_ID,
              audioPath: request.audioPath,
            })}\n`
          )
          await proc.stdin.flush?.()
        } catch (err) {
          const failure = failedTranscription(
            'engine_exited_nonzero',
            speechModelId,
            diagnostic(`could not write the request: ${String(err)}`)
          )
          await terminate()
          return failure
        }

        // The request's deadline starts now, not at the spawn.
        const requestDeadline = deadline(deps.clock, request.timeoutMs)
        try {
          while (true) {
            const waited = await nextLine(
              requestDeadline.promise,
              signal.promise
            )
            if (waited.kind === 'aborted') return await cancelled()
            if (waited.kind === 'timeout') {
              log('parakeet', 'helper timed out', {
                timeoutMs: request.timeoutMs,
              })
              const failure = failedTranscription(
                'engine_timed_out',
                speechModelId,
                diagnostic(`deadline ${request.timeoutMs} ms`)
              )
              await terminate()
              return failure
            }
            if (waited.kind === 'read_error') {
              const failure = failedTranscription(
                'engine_output_unreadable',
                speechModelId,
                diagnostic(`could not read stdout: ${String(waited.error)}`)
              )
              await terminate()
              return failure
            }
            if (waited.kind === 'exited' || waited.line === null) {
              const failure = await failureAfterEnd('request')
              await terminate()
              return failure
            }

            const response = parseParakeetSessionResponse(waited.line)
            if (response === null) continue
            const final =
              response.kind === 'final' && response.id === DICTATION_REQUEST_ID
                ? parseParakeetFinal(waited.line)
                : null
            if (final === null) {
              const failure = failedTranscription(
                'engine_output_unreadable',
                speechModelId,
                diagnostic(`unexpected session response: ${waited.line}`)
              )
              await terminate()
              return failure
            }

            const tail = stderr.tail()
            if (tail !== '') log('parakeet', 'helper stderr', { text: tail })
            // Not awaited: the text goes to the user now, and the exit is bounded anyway.
            void closeGracefully()
            return { status: 'final', final }
          }
        } finally {
          requestDeadline.cancel()
        }
      } finally {
        signal.dispose()
      }
    },
  }
}
