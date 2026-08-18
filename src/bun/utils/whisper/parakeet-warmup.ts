/**
 * Parakeet's one-time on-device preparation, and the single place that decides when it runs.
 *
 * Parakeet (FluidAudio) compiles its weights for the machine that will run them before the
 * first transcription can start, and that compile takes a minute or two. It used to be the
 * user's problem: a readiness reason nobody could act on, a Settings hint warning that the
 * app "may look stuck", and three uncoordinated callers each deciding for themselves whether
 * to prepare. ADR-0005 takes it out of the user-facing set - preparation starts as soon as
 * Parakeet becomes the selected Speech Model, so nobody is asked to wait for something they
 * were never told had started.
 *
 * Two rules make that safe:
 *
 * - **One preparation at a time.** Selection changes fire repeatedly, and boot, a settings
 *   write and a finished download can all want a preparation at once. Two overlapping
 *   compiles are two processes racing over the same files, so `ensureParakeetWarm` is
 *   idempotent: it joins the in-flight preparation rather than starting a second one.
 * - **A Dictation started mid-preparation waits for it.** `awaitParakeetWarmup` is what the
 *   run path calls before it spawns the helper. Waiting is honest here - the wait *is* the
 *   compile, which the run would have paid for itself anyway - and serialising it is what
 *   stops a press racing the preparation and coming back with nothing.
 *
 * See docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import {
  PARAKEET_ENGINE_ID,
  getSpeechModel,
  type SpeechEngineId,
} from '../../../shared/speech-models'
import { getPlatform } from '../../platform'
import { getPlatformCapabilities } from '../../platform/runtime'
import { modelManager } from './model-manager'
import { log } from '../logger'

/**
 * How long the run path waits for an in-flight preparation before spawning regardless.
 *
 * Generous, because the compile it waits for genuinely takes a minute or two. The bound
 * exists only so a wedged helper process cannot wedge every later Dictation with it: past
 * it the Dictation spawns and does its own loading, which costs one slow Dictation instead
 * of all of them.
 */
const WARMUP_WAIT_TIMEOUT_MS = 180_000

/**
 * Everything the "should we prepare right now" decision depends on, as plain values so the
 * decision can be tested without a spawn, a filesystem or a platform probe.
 */
export interface ParakeetWarmupState {
  /** Engine of the selected Speech Model, or null when the catalog has never heard of it. */
  selectedEngineId: SpeechEngineId | null
  /** The selected Speech Model's weights are on disk. */
  weightsInstalled: boolean
  /** This platform ships the Parakeet Native Helper at all (Linux does not). */
  helperSupported: boolean
  /** Preparation has already completed on this device. */
  alreadyPrepared: boolean
  /** A preparation started earlier has not finished yet. */
  preparationInFlight: boolean
  /** Preparing these weights already failed once in this process. */
  previousAttemptFailed: boolean
}

/**
 * Whether selection has just made a preparation worth starting.
 *
 * Every arm below is a reason a spawn would be wasted or harmful, which is why this is a
 * function and not an inline condition at three call sites - that arrangement is what let
 * boot, a settings write and a finished download each answer it slightly differently.
 */
export function shouldStartParakeetWarmup(state: ParakeetWarmupState): boolean {
  if (!state.helperSupported) return false
  if (state.selectedEngineId !== PARAKEET_ENGINE_ID) return false
  if (!state.weightsInstalled) return false
  if (state.alreadyPrepared) return false
  if (state.preparationInFlight) return false
  // A failed preparation is not retried by the next settings write. Settings writes are
  // frequent - every language, duration and toggle change is one - so retrying on each would
  // respawn a broken helper indefinitely. The next launch tries again, and a real Dictation
  // still prepares the weights as a side effect of running them.
  if (state.previousAttemptFailed) return false
  return true
}

/**
 * The state this module cannot see for itself. `AppConfig` owns the selection and the
 * persisted "already prepared" flag, and `index.ts` owns the window and the tray, so both
 * arrive as callbacks rather than as imports - which is also what keeps `AppConfig` free of
 * any knowledge that a preparation spawns a process.
 */
export interface ParakeetWarmupHost {
  /** The Speech Model the user has selected right now. */
  getSelectedSpeechModelId(): string
  /** Whether preparation has already completed on this device. */
  isPrepared(): boolean
  /** Persist that preparation is done, so nothing keeps mentioning the wait. */
  markPrepared(): Promise<void>
  /**
   * Called after `markPrepared`. This is the "no restart" half of the feature: it pushes
   * settings to the window and resyncs the tray, so Live Transcription becomes available on
   * its own the moment the compile finishes.
   */
  onPrepared(): void
}

let host: ParakeetWarmupHost | null = null
let inFlight: Promise<void> | null = null
const failedModelIds = new Set<string>()

/** Wired once, from `index.ts`, before the first `ensureParakeetWarm`. */
export function installParakeetWarmup(next: ParakeetWarmupHost): void {
  host = next
}

async function prepare(
  current: ParakeetWarmupHost,
  speechModelId: string
): Promise<void> {
  try {
    const prepared = await runParakeetWarmup(speechModelId)
    if (!prepared) {
      failedModelIds.add(speechModelId)
      return
    }
    await current.markPrepared()
    current.onPrepared()
  } catch (err) {
    log('parakeet', 'model preparation failed', { err: String(err) })
    failedModelIds.add(speechModelId)
  } finally {
    inFlight = null
  }
}

/**
 * Start a preparation if the selection now calls for one. Safe to call on every settings
 * settle: it is a cheap check, and it never starts a second concurrent compile.
 */
export function ensureParakeetWarm(): void {
  const current = host
  if (current === null) return
  const speechModelId = current.getSelectedSpeechModelId()
  const decision: ParakeetWarmupState = {
    selectedEngineId: getSpeechModel(speechModelId)?.engine ?? null,
    weightsInstalled: modelManager.isModelAvailable(speechModelId),
    // The same flag `AppConfig.dictationAvailability()` reads. It answers "does this platform
    // have the Parakeet Native Helper", which is a packaging fact, not a Live Transcription
    // setting - a batch Parakeet Dictation needs the preparation just as much.
    helperSupported: getPlatformCapabilities().supportsStreamMode,
    alreadyPrepared: current.isPrepared(),
    preparationInFlight: inFlight !== null,
    previousAttemptFailed: failedModelIds.has(speechModelId),
  }
  if (!shouldStartParakeetWarmup(decision)) return
  inFlight = prepare(current, speechModelId)
}

/**
 * Hold a Dictation until the in-flight preparation finishes. Returns immediately when there
 * is none, which is the overwhelmingly common case.
 *
 * Called from the run path *after* the press has already been acknowledged - the start chime
 * has played and the recording indicator is up - so the wait is never a silent press. What it
 * buys is that a Dictation during the preparation window does not spawn a second helper
 * against half-compiled weights and exit with nothing to show for it.
 */
export async function awaitParakeetWarmup(): Promise<void> {
  const pending = inFlight
  if (pending === null) return
  log('parakeet', 'dictation waiting for in-flight model preparation')
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(
        'parakeet',
        'stopped waiting for model preparation, spawning anyway',
        {
          waitedMs: WARMUP_WAIT_TIMEOUT_MS,
        }
      )
      resolve()
    }, WARMUP_WAIT_TIMEOUT_MS)
  })
  try {
    // `pending` never rejects: `prepare` swallows everything into the failed set.
    await Promise.race([pending, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The preparation itself: load the weights once against half a second of silence, so the
 * compile happens here instead of inside the user's first Dictation.
 *
 * Same routine that used to live in speech2text.ts, with one change: the Speech Model id is
 * a parameter. It was the last hardcoded Speech Model id on the run path.
 *
 * Correct on Windows as-is - `CodictateWindowsHelper transcribe <wav> <modelDir>` takes the
 * same arguments as the macOS helper - and inert on Linux, where resolving the helper throws
 * and the catch below turns that into a skipped preparation rather than a crash.
 */
async function runParakeetWarmup(speechModelId: string): Promise<boolean> {
  if (!modelManager.isModelAvailable(speechModelId)) return false
  try {
    const helper = getPlatform().findParakeetHelperBinary()
    const modelDir = modelManager.getParakeetInstallDir(speechModelId)
    const warmupPath = getPlatform().getTempPath('codictate-warmup.wav')
    await Bun.write(warmupPath, createSilentWav())
    log('parakeet', 'starting model warmup', { speechModelId, modelDir })
    // stderr is captured rather than ignored. The helper reports its phases there, and
    // discarding them is what let a mismatched model directory read as a freeze: FluidAudio
    // was re-downloading 461 MB on every attempt and saying so to nobody.
    const proc = Bun.spawn([helper, 'transcribe', warmupPath, modelDir], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    })
    const stderr = (await new Response(proc.stderr).text()).trim()
    await proc.exited
    const failed = proc.exitCode !== 0
    log('parakeet', failed ? 'model warmup failed' : 'model warmup complete', {
      exitCode: proc.exitCode,
      ...(stderr === '' ? {} : { stderr: stderr.slice(-2000) }),
    })
    return !failed
  } catch (err) {
    log('parakeet', 'model warmup error', { err: String(err) })
    return false
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
