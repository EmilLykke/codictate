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
 * `RECORDING_PATH`. What is left is the order of the rewrites: the shipped brand table, the
 * user Dictionary, then the Formatting Mode.
 *
 * Live Transcription does not come through here. The Parakeet Native Helper captures,
 * transcribes and pastes for itself, so there is no Outcome to return.
 */

import type { RunnableDictationPlan } from '../../shared/dictation-plan'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../shared/types'
import { applyDictionary } from '../utils/dictionary/apply-dictionary'
import { applyFormatting } from '../utils/formatting/apply-formatting'
import { buildFormatterRequest } from '../utils/formatting/resolve-formatting-request'
import { runTranscription } from '../utils/whisper/engines/run-transcription'
import {
  transcriptionRequestFromPlan,
  type FailedTranscription,
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
  /** After the brand table and the Dictionary, before the Formatting Mode. */
  raw: string
  /** What the caller pastes. Equal to `raw` when no Formatting Mode matched. */
  output: string
  formattingUsed: boolean
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

export async function runDictation(
  request: DictationRunRequest
): Promise<DictationRunResult> {
  const { plan } = request

  const engineResult = await runTranscription(
    transcriptionRequestFromPlan(plan, request.audioPath, modelManager)
  )
  if (engineResult.status === 'failed') return engineResult

  const outcome = (
    raw: string,
    output: string,
    formattingUsed: boolean
  ): DictationOutcome => ({
    status: 'ok',
    raw,
    output,
    formattingUsed,
    engineId: plan.speechModelId,
    languageId: plan.transcriptionLanguageId,
    durationMs: request.durationMs,
  })

  // A zero-exit empty transcript is a success with empty output, and it stops here. The
  // Formatting Backend has nothing to rewrite, and the caller pastes nothing, records nothing
  // and plays no error chime: pressing the shortcut and saying nothing is the normal outcome
  // of pressing the shortcut and saying nothing. See ADR-0006.
  if (engineResult.rawTranscript.trim() === '') {
    return outcome('', '', false)
  }

  // The shipped brand table first, then the user Dictionary. Both are app rewrites of what
  // the Speech Engine said, and both sit above the engine seam so the benchmark scores raw
  // hypotheses.
  let transcript = fixBrandMishearings(engineResult.rawTranscript)
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
  const formatterRequest = await buildFormatterRequest(
    transcript,
    request.formattingSettings
  )
  if (formatterRequest === null) return outcome(raw, raw, false)

  // A Formatting Backend failure degrades to the Raw Transcript rather than failing the
  // Dictation - withholding real text because the rewrite failed is worse than pasting it
  // unformatted, and unlike the engine there is something honest to paste. `applyFormatting`
  // owns that degrade and never hands the failure back here.
  return outcome(raw, await applyFormatting(formatterRequest), true)
}
