/**
 * The one background load of Parakeet, and the single place that decides when it runs.
 *
 * Before Parakeet (FluidAudio) can transcribe anything, its weights have to be fitted to this
 * device: a Parakeet Preparation, which on the Mac is the Neural Engine compiling the encoder
 * and takes 12 to 19 s. Loading weights that are already prepared takes about 0.15 s. Which of
 * the two a load will be cannot be known ahead of it: a Preparation is needed again when
 * another installed copy of Codictate (another release channel, a development build) has used
 * the same weights, after a system update, or when the system frees disk space. So there is
 * no "already prepared" fact to keep, and no separate slow-load case to handle - every slow
 * load measured was a Preparation.
 *
 * What this module does instead is load the Dictation's Speech Model in the background, while
 * it is Parakeet and its weights are installed, at the moments a Preparation is most likely to
 * be due: once at launch, when Parakeet becomes the selection, and when its download finishes.
 * Usually that is the 0.15 s load and nobody notices; when it is a Preparation, it is paid here
 * instead of inside the user's next Dictation. File Transcription Settings choosing Parakeet
 * starts nothing - a File Transcription pays any Preparation in its own Processing Time.
 *
 * Two rules make that safe:
 *
 * - **One background load at a time.** Selection changes fire repeatedly, and boot, a settings
 *   write and a finished download can all arrive at once, so a load is held in a single
 *   in-flight promise and this module never starts a second one beside it.
 * - **A Batch Dictation started mid-load waits for it.** `awaitParakeetWarmup` is what the
 *   batch run path calls before it spawns the helper. Its recording is already over and was
 *   made by a separate recorder, so waiting loses nothing - the wait *is* the load, which the
 *   run would have paid for itself anyway - and it never starts a second Preparation.
 *   Live Transcription does not wait: its helper opens the microphone before it loads, so a
 *   wait would lose speech. Two helpers preparing the same weights at once both finish (just
 *   slower), so spawning beside the background load is safe.
 *
 * See docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import { unlinkSync } from 'node:fs'
import {
  PARAKEET_ENGINE_ID,
  getSpeechModel,
  type SpeechEngineId,
} from '../../../shared/speech-models'
import { getPlatform } from '../../platform'
import { requireRuntimeBinary } from '../../platform/binaries'
import { getPlatformCapabilities } from '../../platform/runtime'
import { modelManager } from './model-manager'
import { log } from '../logger'
import { decodeEngineStderr } from './engines/drain-stream'
import {
  ENGINE_PROCESS_CLEANUP_GRACE_MS,
  ENGINE_PROCESS_TIMEOUT_MS,
  superviseProcess,
} from './engines/process-supervisor'

/**
 * How long the run path waits for an in-flight load before spawning regardless.
 *
 * Generous, because a Preparation genuinely takes seconds. The bound exists only so a wedged
 * helper process cannot wedge every later Dictation with it: past it the Dictation spawns and
 * does its own loading, which costs one slow Dictation instead of all of them.
 */
const WARMUP_WAIT_TIMEOUT_MS =
  ENGINE_PROCESS_TIMEOUT_MS + ENGINE_PROCESS_CLEANUP_GRACE_MS

/**
 * How long a load runs before Settings says Parakeet is preparing.
 *
 * A load of prepared weights is done in about 0.15 s, so a load still running after a second
 * is a Parakeet Preparation. Saying "preparing" from the first millisecond would flash the
 * line on every launch for a load nobody waits on.
 */
export const PARAKEET_PREPARING_AFTER_MS = 1000

/**
 * Everything the "should we load right now" decision depends on, as plain values so the
 * decision can be tested without a spawn, a filesystem or a platform probe.
 */
export interface ParakeetLoadState {
  /** Engine of the Dictation's selected Speech Model, or null when the catalog has never heard of it. */
  selectedEngineId: SpeechEngineId | null
  /** The selected Speech Model's weights are on disk. */
  weightsInstalled: boolean
  /** This platform ships the Parakeet Native Helper at all (Linux does not). */
  helperSupported: boolean
  /**
   * The same Speech Model was already selected and installed at the previous settle in this
   * process. False at launch, after it becomes the selection and after its download finishes:
   * the three moments a load is for.
   */
  alreadyLoadable: boolean
  /** A load started earlier has not finished yet. */
  loadInFlight: boolean
}

/** Parakeet is the Dictation's selection, its weights are installed, and its helper ships here. */
export function isParakeetLoadable(
  state: Pick<
    ParakeetLoadState,
    'selectedEngineId' | 'weightsInstalled' | 'helperSupported'
  >
): boolean {
  return (
    state.helperSupported &&
    state.selectedEngineId === PARAKEET_ENGINE_ID &&
    state.weightsInstalled
  )
}

/**
 * Whether this settle calls for a background load.
 *
 * Every arm below is a reason a spawn would be wasted or harmful, which is why this is a
 * function and not an inline condition at three call sites - that arrangement is what let
 * boot, a settings write and a finished download each answer it slightly differently.
 */
export function shouldStartParakeetLoad(state: ParakeetLoadState): boolean {
  if (!isParakeetLoadable(state)) return false
  // Nothing happened to Parakeet since the last settle. Settings writes are frequent - every
  // language, duration and toggle change is one - so loading on each would respawn the helper
  // for nothing, and respawn a broken one indefinitely after a failed load. A failed load is
  // tried again only when the user selects or downloads Parakeet again, or on the next launch.
  if (state.alreadyLoadable) return false
  if (state.loadInFlight) return false
  return true
}

/**
 * The single in-flight load and the "preparing" fact derived from how long it has run.
 *
 * A factory rather than module state so the threshold and the settings pushes it drives can
 * be tested with a fake load instead of a spawned helper.
 */
export interface ParakeetLoadTracker {
  /** The load running right now, or null. Never rejects. */
  readonly inFlight: Promise<void> | null
  /** The load running right now has run past the threshold: a Parakeet Preparation. */
  readonly preparing: boolean
  /** Start `run` as the in-flight load. Returns false, starting nothing, when one is running. */
  start(run: () => Promise<unknown>): boolean
}

export function createParakeetLoadTracker(options: {
  preparingAfterMs: number
  /** Called when `preparing` turns true and when it turns false again. */
  onPreparingChanged: () => void
}): ParakeetLoadTracker {
  let inFlight: Promise<void> | null = null
  let preparing = false

  const track = async (run: () => Promise<unknown>): Promise<void> => {
    const timer = setTimeout(() => {
      preparing = true
      options.onPreparingChanged()
    }, options.preparingAfterMs)
    try {
      await run()
    } catch (err) {
      log('parakeet', 'background model load failed', { err: String(err) })
    } finally {
      clearTimeout(timer)
      // Cleared before the push, so the settings it carries already say the load is over.
      inFlight = null
      if (preparing) {
        preparing = false
        options.onPreparingChanged()
      }
    }
  }

  return {
    get inFlight() {
      return inFlight
    },
    get preparing() {
      return preparing
    },
    start(run) {
      if (inFlight !== null) return false
      inFlight = track(run)
      return true
    },
  }
}

/**
 * The state this module cannot see for itself. `AppConfig` owns the selection and `index.ts`
 * owns the window, so both arrive as callbacks rather than as imports - which is also what
 * keeps `AppConfig` free of any knowledge that a load spawns a process.
 */
export interface ParakeetWarmupHost {
  /** The Speech Model the Dictation has selected right now. */
  getSelectedSpeechModelId(): string
  /**
   * `isParakeetPreparing()` changed. Pushes settings to the window, so Settings states the
   * Preparation once it has run past the threshold and drops the line when it ends.
   */
  onPreparingChanged(): void
}

let host: ParakeetWarmupHost | null = null
let tracker: ParakeetLoadTracker | null = null
/** The Speech Model that was selected and installed at the previous settle, or null. */
let loadableModelId: string | null = null

/** Wired once, from `index.ts`, before the first `ensureParakeetWarm`. */
export function installParakeetWarmup(next: ParakeetWarmupHost): void {
  host = next
  tracker = createParakeetLoadTracker({
    preparingAfterMs: PARAKEET_PREPARING_AFTER_MS,
    onPreparingChanged: () => next.onPreparingChanged(),
  })
}

/**
 * A background load has run for more than `PARAKEET_PREPARING_AFTER_MS`. Read by `AppConfig`
 * for `DictationReadiness.parakeetPreparing`; the readiness check adds that Parakeet is still
 * the selection.
 */
export function isParakeetPreparing(): boolean {
  return tracker?.preparing ?? false
}

/**
 * Start a background load if this settle calls for one. Safe to call on every settings settle:
 * it is a cheap check, and it never starts a second load beside a running one.
 */
export function ensureParakeetWarm(): void {
  const current = host
  const loads = tracker
  if (current === null || loads === null) return
  const speechModelId = current.getSelectedSpeechModelId()
  const state = {
    selectedEngineId: getSpeechModel(speechModelId)?.engine ?? null,
    weightsInstalled: modelManager.isModelAvailable(speechModelId),
    // The same flag `AppConfig.dictationAvailability()` reads. It answers "does this platform
    // have the Parakeet Native Helper", which is a packaging fact, not a Live Transcription
    // setting - a Batch Dictation on Parakeet needs the load just as much.
    helperSupported: getPlatformCapabilities().supportsStreamMode,
    alreadyLoadable: loadableModelId === speechModelId,
    loadInFlight: loads.inFlight !== null,
  }
  loadableModelId = isParakeetLoadable(state) ? speechModelId : null
  if (!shouldStartParakeetLoad(state)) return
  // `runParakeetWarmup` turns every failure into a log line, and the tracker logs
  // anything that still escapes, so the in-flight promise never rejects.
  loads.start(() => runParakeetWarmup(speechModelId))
}

/**
 * Hold a Batch Dictation until the in-flight load finishes. Returns immediately when there is
 * none, which is the overwhelmingly common case, and within about 0.15 s when the load finds
 * the weights prepared.
 *
 * Called from the batch run path after recording has ended and the indicator says
 * "transcribing", so the wait is visible and loses nothing. Never call it before a Live
 * Transcription spawn: that helper opens the microphone, and a wait in front of it is speech
 * lost.
 */
export async function awaitParakeetWarmup(): Promise<void> {
  const pending = tracker?.inFlight ?? null
  if (pending === null) return
  log('parakeet', 'dictation waiting for in-flight model load')
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log('parakeet', 'stopped waiting for model load, spawning anyway', {
        waitedMs: WARMUP_WAIT_TIMEOUT_MS,
      })
      resolve()
    }, WARMUP_WAIT_TIMEOUT_MS)
  })
  try {
    await Promise.race([pending, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The load itself: run the weights once against half a second of silence, so whatever loading
 * them costs - 0.15 s, or a whole Parakeet Preparation - is paid here instead of inside the
 * user's next Dictation.
 *
 * Correct on Windows as-is - `CodictateWindowsHelper transcribe <wav> <modelDir>` takes the
 * same arguments as the macOS helper - and inert on Linux, where resolving the helper throws
 * and the catch below turns that into a logged, skipped load rather than a crash. Never
 * rejects.
 */
async function runParakeetWarmup(speechModelId: string): Promise<void> {
  if (!modelManager.isModelAvailable(speechModelId)) return
  let warmupPath: string | undefined
  try {
    const helper = requireRuntimeBinary('parakeet')
    const modelDir = modelManager.getParakeetInstallDir(speechModelId)
    warmupPath = getPlatform().getTempPath('codictate-warmup.wav')
    await Bun.write(warmupPath, createSilentWav())
    log('parakeet', 'loading model in the background', {
      speechModelId,
      modelDir,
    })
    const startedAt = performance.now()
    // stderr is captured rather than ignored. The helper reports its phases there, and
    // discarding them is what let a mismatched model directory read as a freeze: FluidAudio
    // was re-downloading 461 MB on every attempt and saying so to nobody.
    const proc = Bun.spawn([helper, 'transcribe', warmupPath, modelDir], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    })
    const supervised = await superviseProcess(proc, { stderr: proc.stderr })
    const stderr = decodeEngineStderr(supervised.stderr).trim()
    const timedOut = supervised.status === 'timed_out'
    const exitCode = timedOut ? null : supervised.exitCode
    const failed =
      timedOut ||
      (supervised.status === 'exited' &&
        (!supervised.outputComplete || supervised.exitCode !== 0))
    log(
      'parakeet',
      failed
        ? 'background model load failed'
        : 'background model load complete',
      {
        exitCode,
        // About 150 ms for prepared weights; seconds means this load was a Parakeet Preparation.
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(timedOut ? { timeoutMs: ENGINE_PROCESS_TIMEOUT_MS } : {}),
        ...(stderr === '' ? {} : { stderr: stderr.slice(-2000) }),
      }
    )
  } catch (err) {
    log('parakeet', 'background model load error', { err: String(err) })
  } finally {
    if (warmupPath) {
      try {
        unlinkSync(warmupPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('parakeet', 'could not remove background load audio', {
            path: warmupPath,
            err: String(err),
          })
        }
      }
    }
  }
}

function createSilentWav(): Uint8Array {
  const sampleRate = 16000
  const numSamples = Math.floor(sampleRate * 0.5)
  const dataSize = numSamples * 2
  const buf = new Uint8Array(44 + dataSize)
  const view = new DataView(buf.buffer)
  buf[0] = 0x52
  buf[1] = 0x49
  buf[2] = 0x46
  buf[3] = 0x46 // RIFF
  view.setUint32(4, 36 + dataSize, true)
  buf[8] = 0x57
  buf[9] = 0x41
  buf[10] = 0x56
  buf[11] = 0x45 // WAVE
  buf[12] = 0x66
  buf[13] = 0x6d
  buf[14] = 0x74
  buf[15] = 0x20 // fmt
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  buf[36] = 0x64
  buf[37] = 0x61
  buf[38] = 0x74
  buf[39] = 0x61 // data
  view.setUint32(40, dataSize, true)
  return buf
}
