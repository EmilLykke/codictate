/**
 * The Speech Engine Adapter contract: a **Transcription Request** in, a **Transcription
 * Result** out.
 *
 * One interface, two implementations (crispasr and the Parakeet Native Helper) and two
 * callers (the Dictation pipeline and the benchmark). It knows nothing about the Dictionary,
 * Formatting Modes, history or the clipboard, and it takes its audio as a parameter rather
 * than reading `RECORDING_PATH` - which is what stopped a Benchmark Run from copying every
 * Sample over the running app's recording buffer.
 *
 * A Request is deliberately not a Dictation Plan. AGENTS.md keeps the benchmark away from
 * settings, availability healing and the plan, and a Request keeps that true without giving
 * the benchmark a private entry point: the app derives one from its plan through
 * `transcriptionRequestFromPlan` below, the benchmark constructs one by hand.
 *
 * This module is pure - no spawn, no filesystem, no platform probe - so the derivation and
 * the failure sentences are covered by the default `bun test` run. The spawning lives in
 * `crispasr-engine.ts` and `parakeet-engine.ts`.
 *
 * Live Transcription is outside this interface on purpose: the Parakeet Native Helper
 * captures, transcribes and pastes for itself, so there is no result to return. See
 * docs/adr/0006-dictation-returns-an-outcome.md.
 */

import type { CrispasrBackendId } from '../../../../shared/asr-harness'
import {
  modelLabel,
  type RunnableDictationPlan,
} from '../../../../shared/dictation-plan'
import {
  PARAKEET_ENGINE_ID,
  type SpeechEngineId,
} from '../../../../shared/speech-models'

/**
 * A Whisper or hviske run on the crispasr ASR Harness.
 *
 * `crispasrBackend` and `translateToEnglish` travel together because ADR-0002's Harness
 * seam owns the invariant between them: `buildWhisperHarnessCommand` refuses the pair, and
 * this adapter still calls it rather than assembling argv of its own.
 */
export interface HarnessTranscriptionRequest {
  engineId: Exclude<SpeechEngineId, typeof PARAKEET_ENGINE_ID>
  /**
   * Which Speech Model this is. Not used to resolve anything - the paths are already
   * resolved below - but a failure has to name the Speech Model in its sentence, and the
   * log line has to name it too.
   */
  speechModelId: string
  audioPath: string
  /** Absolute path to the weights file. */
  modelPath: string
  /** The whisper.cpp language token, or `null` for automatic detection. */
  languageCode: string | null
  translateToEnglish: boolean
  /** crispasr `--backend` to pin, or `null` for the default backend. hviske needs `cohere`. */
  crispasrBackend: CrispasrBackendId | null
}

/**
 * A batch run on the Parakeet Native Helper.
 *
 * No language, no translate and no backend: Parakeet detects the language itself, takes no
 * language argument, and is not run by a Harness. A flat Request with those fields present
 * and ignored is a Request a caller can fill in wrongly and never find out.
 */
export interface ParakeetTranscriptionRequest {
  engineId: typeof PARAKEET_ENGINE_ID
  speechModelId: string
  audioPath: string
  /** Absolute path to the Parakeet install directory (Core ML on macOS, ONNX on Windows). */
  modelDir: string
}

export type TranscriptionRequest =
  HarnessTranscriptionRequest | ParakeetTranscriptionRequest

/**
 * Why a Speech Engine produced no transcript. Closed union, engine-only: nothing about
 * settings, the Dictionary or the Formatting Backend belongs here.
 *
 * `TRANSCRIPTION_FAILURE_MESSAGES` below is an exhaustive `Record` over it, so a fifth
 * failure mode does not compile until it has a sentence - the same device ADR-0005 used for
 * `DictationBlockedReason`.
 */
export type TranscriptionFailureReason =
  /**
   * The engine process exited non-zero. This used to be logged and its stdout returned
   * anyway, so a crashed Harness pasted an empty transcript over the user's cursor, wrote it
   * to history and counted it in stats.
   */
  | 'engine_exited_nonzero'
  /**
   * The binary or the weights were gone at spawn time. The plan said they were there, and
   * the gap between building a plan and spawning is where a Finder delete or a
   * cloud-storage eviction lands.
   */
  | 'engine_runtime_missing'
  /**
   * The Parakeet Native Helper emitted no `final` NDJSON line. Not the same as a `final`
   * line carrying an empty string, which is a silent Dictation and a success.
   */
  | 'parakeet_no_final_line'
  /** The engine wrote bytes that are not the UTF-8 it was asked for. */
  | 'engine_output_unreadable'

/**
 * A Speech Engine run that produced nothing, and the sentence to say so.
 *
 * Plain data with no functions, for the same reason `BlockedDictationPlan` is: it reaches
 * the user through a native notification or an in-window banner, which means it crosses the
 * Electrobun RPC bridge.
 */
export interface FailedTranscription {
  status: 'failed'
  reason: TranscriptionFailureReason
  /** One finished sentence, shown to the user as written. */
  message: string
}

/**
 * What one Speech Engine invocation produced.
 *
 * `rawTranscript` is exactly what the engine said: no brand table, no Dictionary, no
 * Formatting Mode. An empty `rawTranscript` is a success, not a failure - it is the normal
 * outcome of pressing the shortcut and not speaking, and an error chime for a silent
 * recording trains the user to ignore the error chime.
 */
export type TranscriptionResult =
  { status: 'ok'; rawTranscript: string } | FailedTranscription

/**
 * One sentence per failure reason, written here rather than at the surfaces that show it.
 * Exhaustive by construction - add a reason to the union and this stops compiling.
 *
 * None of them promises that the next press works, which is the difference from
 * `BLOCKED_MESSAGES`: a blocked plan means the configuration is unrunnable and the heal pass
 * corrects it, while a failed run means the configuration was fine and nothing is healed.
 */
const TRANSCRIPTION_FAILURE_MESSAGES: Record<
  TranscriptionFailureReason,
  (speechModelLabel: string) => string
> = {
  engine_exited_nonzero: (label) =>
    `Dictation stopped because ${label} exited without transcribing. Nothing was pasted. Try again, and check the debug log if it keeps happening.`,
  engine_runtime_missing: (label) =>
    `Dictation stopped because ${label} could not be started: its engine or its weights are no longer on disk. Check the Speech Model in Settings, or reinstall Codictate.`,
  parakeet_no_final_line: (label) =>
    `Dictation stopped because ${label} finished without returning a transcript. Nothing was pasted.`,
  engine_output_unreadable: (label) =>
    `Dictation stopped because ${label} returned output Codictate could not read. Nothing was pasted.`,
}

/**
 * The one constructor for a failed Result, so a reason and its sentence cannot be paired up
 * differently in two places. Mirrors `blockedDictationPlan`.
 */
export function failedTranscription(
  reason: TranscriptionFailureReason,
  speechModelId: string
): FailedTranscription {
  return {
    status: 'failed',
    reason,
    message: TRANSCRIPTION_FAILURE_MESSAGES[reason](modelLabel(speechModelId)),
  }
}

/**
 * One Speech Engine invocation. Implemented twice, in `crispasr-engine.ts` and
 * `parakeet-engine.ts`, and dispatched by `runTranscription` in `run-transcription.ts`.
 */
export type SpeechEngineAdapter<Request extends TranscriptionRequest> = (
  request: Request
) => Promise<TranscriptionResult>

/**
 * Where a Speech Model's weights are, asked rather than looked up.
 *
 * `modelManager` satisfies this structurally, which is what keeps the derivation below pure:
 * the app passes the manager, a test passes two functions returning fixed strings.
 */
export interface SpeechModelLocations {
  /** Absolute path to the weights file, or the install directory for a Parakeet model. */
  getModelPath: (speechModelId: string) => string
  /** Absolute path to the Parakeet install directory. */
  getParakeetInstallDir: (speechModelId: string) => string
}

/**
 * The app's Dictation Plan, as a Transcription Request. The only place a plan turns into a
 * Request, and the reason the benchmark needs no private door into the adapters.
 *
 * Nothing is re-derived here: the Speech Model, the Speech Engine, the crispasr backend, the
 * language and the translate flag were all decided when the plan was built (ADR-0005), and
 * this copies them across. The only new facts are the audio path, which is now a parameter
 * rather than a process-global, and the resolved weights path.
 *
 * Batch only. A live plan never reaches this: Live Transcription is a session the Parakeet
 * Native Helper runs for itself, with no Request and no Result.
 */
export function transcriptionRequestFromPlan(
  plan: RunnableDictationPlan,
  audioPath: string,
  locations: SpeechModelLocations
): TranscriptionRequest {
  if (plan.engineId === PARAKEET_ENGINE_ID) {
    return {
      engineId: PARAKEET_ENGINE_ID,
      speechModelId: plan.speechModelId,
      audioPath,
      modelDir: locations.getParakeetInstallDir(plan.speechModelId),
    }
  }

  return {
    engineId: plan.engineId,
    speechModelId: plan.speechModelId,
    audioPath,
    modelPath: locations.getModelPath(plan.speechModelId),
    languageCode: plan.languageCode,
    translateToEnglish: plan.translateToEnglish,
    crispasrBackend: plan.crispasrBackend,
  }
}
