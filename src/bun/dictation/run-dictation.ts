/**
 * One Batch Dictation, end to end: a runnable Dictation Plan and a captured WAV in, a
 * **Dictation Outcome** out.
 *
 * It does not paste. A transcript could not be obtained from Codictate without pasting it
 * into whatever app had focus, which is what made history, stats and the clipboard the mic
 * module's problem and left the benchmark unable to reuse any of this. Paste, history, stats
 * and the four failure surfaces belong to `setup-recording.ts`, which already owns every
 * other post-Dictation surface. See docs/adr/0006-dictation-returns-an-outcome.md.
 *
 * Nothing here is decided. The Speech Model, the Speech Engine, the crispasr backend, the
 * Transcription Language and the translate flag were all resolved once when the plan was
 * built (ADR-0005), and the audio is a parameter rather than the process-global
 * `RECORDING_PATH`. What is left is the order of the steps: the Speech Engine, Punctuation
 * Restoration when the plan says so, the shipped brand table, the user Dictionary, then the
 * Formatting Mode.
 *
 * The Speech Engine run, the Punctuation Restorer and the Formatting Mode arrive as
 * dependencies, with the real ones as defaults, so the order can be tested with fakes.
 *
 * Live Transcription does not come through here. The Parakeet Native Helper captures,
 * transcribes and pastes for itself, so there is no Outcome to return.
 */

import type { RunnableDictationPlan } from '../../shared/dictation-plan'
import type { FormattingModeId } from '../../shared/formatting-modes'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../shared/types'
import { applyDictionary } from '../utils/dictionary/apply-dictionary'
import { applyFormatting } from '../utils/formatting/apply-formatting'
import { buildFormatterRequest } from '../utils/formatting/resolve-formatting-request'
import { appPunctuationRestorer } from '../utils/punctuation/app-punctuation-restorer'
import type { PunctuationRestorer } from '../utils/punctuation/punctuation-restorer'
import { runTranscription } from '../utils/whisper/engines/run-transcription'
import { engineProcessTimeoutMs } from '../utils/whisper/engines/process-supervisor'
import {
  transcriptionRequestFromPlan,
  type FailedTranscription,
  type TranscriptionResult,
} from '../utils/whisper/engines/transcription'
import { modelManager } from '../utils/whisper/model-manager'
import { fixBrandMishearings } from './brand-mishearings'

export interface DictationRunRequest {
  /** Decided once, before the recorder was spawned. Nothing below re-derives any of it. */
  plan: RunnableDictationPlan
  /** The WAV the recorder wrote. */
  audioPath: string
  /** How long the capture was, measured from that WAV by the audio module. */
  durationMs: number
  formattingSettings: FormattingRuntimeSettings
  dictionaryEntries: DictionaryEntry[]
  /**
   * Which Dictionary entries fired, reported as they fire rather than in the Outcome: the
   * next Dictation promotes them, and only this pass knows which ones matched.
   */
  onAppliedEntries?: (entries: DictionaryEntry[]) => void
  /**
   * Output the Raw Transcript: no Punctuation Restoration, no brand table, no Dictionary,
   * no Formatting Mode. A command-line Dictation asks for this with `--raw`.
   */
  raw?: boolean
  /** Stops the Speech Engine. Only a command-line Dictation passes one, to cancel. */
  signal?: AbortSignal
  /**
   * The Detected Language, when it was detected while the user was speaking
   * (`language-while-recording.ts`). Under automatic detection only.
   */
  detectedLanguage?: string
}

/**
 * A Dictation that produced text, and the facts a caller needs to record it.
 *
 * `engineId` and `languageId` come from the plan rather than from a config read after the
 * run, because the user can change either mid-transcription and a stats row that names a
 * Speech Model which never produced a word of it is worse than no row. Carrying them here
 * makes AGENTS.md's "stats record what ran" structural instead of a convention every call
 * site has to remember.
 */
export interface DictationOutcome {
  status: 'ok'
  /**
   * The Raw Transcript: what the Speech Engine produced, before any rewriting, Punctuation
   * Restoration included.
   */
  rawTranscript: string
  /**
   * After Punctuation Restoration, the brand table and the Dictionary, before the
   * Formatting Mode.
   */
  raw: string
  /** What the caller pastes. Equal to `raw` when no Formatting Mode matched. */
  output: string
  formattingUsed: boolean
  /** The Formatting Mode that rewrote `raw`, or `null` when none did. */
  formattingModeId: FormattingModeId | null
  /**
   * Punctuation Restoration ran and succeeded. False when the plan did not ask for it, for a
   * raw request, an empty transcript, and when the Punctuation Restorer failed and the
   * words went on unpunctuated.
   */
  punctuationRestored: boolean
  /** The Speech Model that produced this, as stats names it. */
  engineId: string
  languageId: string
  durationMs: number
}

/**
 * What one Dictation produced, carried rather than raised.
 *
 * The failed arm is the Speech Engine's, unchanged from the Adapter: a Formatting Backend
 * failure is not a failed Dictation, and never reaches here as one.
 */
export type DictationRunResult = DictationOutcome | FailedTranscription

/** What a Formatting Mode made of the text, or `null` when no Formatting Mode applied. */
export interface FormattedTranscript {
  output: string
  modeId: FormattingModeId
}

export interface DictationRunDependencies {
  /** One Speech Engine run on the request's audio, as the plan describes it. */
  runEngine: (request: DictationRunRequest) => Promise<TranscriptionResult>
  /** Never throws: a failure comes back as the input with `restored: false`. */
  punctuationRestorer: Pick<PunctuationRestorer, 'restore'>
  /**
   * Pick the Formatting Mode for the text and run it, or `null` when none applies. Never
   * throws: a Formatting Backend failure degrades to the text it was given.
   */
  formatTranscript: (
    transcript: string,
    settings: FormattingRuntimeSettings
  ) => Promise<FormattedTranscript | null>
}

const realDependencies = (): DictationRunDependencies => ({
  runEngine: (request) =>
    runTranscription({
      ...transcriptionRequestFromPlan(
        request.plan,
        request.audioPath,
        engineProcessTimeoutMs(request.durationMs),
        modelManager,
        request.detectedLanguage
      ),
      signal: request.signal,
    }),
  punctuationRestorer: appPunctuationRestorer(),
  formatTranscript: async (transcript, settings) => {
    const formatterRequest = await buildFormatterRequest(transcript, settings)
    if (formatterRequest === null) return null
    // A Formatting Backend failure degrades to the text rather than failing the Dictation -
    // withholding real text because the rewrite failed is worse than pasting it
    // unformatted, and unlike the engine there is something honest to paste.
    // `applyFormatting` owns that degrade and never hands the failure back here.
    return {
      output: await applyFormatting(formatterRequest),
      modeId: formatterRequest.modeId,
    }
  },
})

export async function runDictation(
  request: DictationRunRequest,
  dependencies: DictationRunDependencies = realDependencies()
): Promise<DictationRunResult> {
  const { plan } = request

  const engineResult = await dependencies.runEngine(request)
  if (engineResult.status === 'failed') return engineResult

  let punctuationRestored = false
  const outcome = (
    raw: string,
    output: string,
    formattingModeId: FormattingModeId | null
  ): DictationOutcome => ({
    status: 'ok',
    rawTranscript: engineResult.rawTranscript,
    raw,
    output,
    formattingUsed: formattingModeId !== null,
    formattingModeId,
    punctuationRestored,
    engineId: plan.speechModelId,
    languageId: plan.transcriptionLanguageId,
    durationMs: request.durationMs,
  })

  // A zero-exit empty transcript is a success with empty output, and it stops here. The
  // Formatting Backend has nothing to rewrite, and the caller pastes nothing, records nothing
  // and plays no error chime: pressing the shortcut and saying nothing is the normal outcome
  // of pressing the shortcut and saying nothing. See ADR-0006.
  if (engineResult.rawTranscript.trim() === '') {
    return outcome('', '', null)
  }

  if (request.raw === true) {
    return outcome(engineResult.rawTranscript, engineResult.rawTranscript, null)
  }

  // Punctuation Restoration first, on the Raw Transcript as the engine wrote it, so the
  // brand table, the Dictionary and the Formatting Mode all work on punctuated text. It runs
  // whether or not a Formatting Mode applies. A failure is not a failed Dictation: the
  // Punctuation Restorer hands the words back unpunctuated and this carries on with them,
  // with no error chime, because a Dictation must never be lost to a punctuation fault.
  let transcript = engineResult.rawTranscript
  if (plan.punctuationRestoration) {
    const restored = await dependencies.punctuationRestorer.restore(transcript)
    transcript = restored.text
    punctuationRestored = restored.restored
  }

  // The shipped brand table, then the user Dictionary. Both are app rewrites of what the
  // Speech Engine said, and both sit above the engine seam so the benchmark scores raw
  // hypotheses.
  transcript = fixBrandMishearings(transcript)
  if (request.dictionaryEntries.length > 0) {
    const applied = applyDictionary(transcript, request.dictionaryEntries, {
      trackApplied: true,
    })
    transcript = applied.text
    if (request.onAppliedEntries && applied.appliedEntries.length > 0) {
      request.onAppliedEntries(applied.appliedEntries)
    }
  }

  const raw = transcript
  const formatted = await dependencies.formatTranscript(transcript, {
    ...request.formattingSettings,
    // Translate mode's output is English even though the plan language names its source.
    transcriptionLanguageId: plan.translateToEnglish
      ? 'en'
      : plan.transcriptionLanguageId,
  })
  if (formatted === null) return outcome(raw, raw, null)
  return outcome(raw, formatted.output, formatted.modeId)
}
