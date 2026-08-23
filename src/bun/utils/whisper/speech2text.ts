import type { RunnableDictationPlan } from '../../../shared/dictation-plan'
import { modelManager } from './model-manager'
import { pasteTranscript } from '../keyboard/keyboard-events'
import { applyFormatting } from '../formatting/apply-formatting'
import { buildFormatterRequest } from '../formatting/resolve-formatting-request'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../../shared/types'
import { applyDictionary } from '../dictionary/apply-dictionary'
import { fixBrandMishearings } from '../../dictation/brand-mishearings'
import { RECORDING_PATH } from '../../platform/runtime'
import { runTranscription } from './engines/run-transcription'
import {
  transcriptionRequestFromPlan,
  type FailedTranscription,
  type TranscriptionResult,
} from './engines/transcription'

/**
 * One Dictation, exactly as the Dictation Plan describes it.
 *
 * Every question this used to ask - is the selection installed, can it translate, which
 * backend, which language - was answered when the plan was built, so nothing is re-derived
 * here and there is nothing left to fall back to. The two fallbacks that used to live in
 * this function are gone: an hviske selection with deleted weights no longer transcribes
 * with the default Speech Model, and Translate to English is no longer dropped when the
 * selection cannot do it. Both states are now unreachable (settings-heal.ts) or blocked
 * before the spawn (buildDictationPlan). See ADR-0005.
 *
 * The spawn itself moved out from under here into the Speech Engine Adapters, so what is
 * left is the derivation: plan plus audio plus the resolved weights path. What comes back is
 * the Raw Transcript, exactly what the Speech Engine said - the brand table is applied by
 * the pipeline below, not here. See ADR-0006.
 */
export const transcribe = async (
  plan: RunnableDictationPlan
): Promise<TranscriptionResult> => {
  const request = transcriptionRequestFromPlan(
    plan,
    RECORDING_PATH,
    modelManager
  )
  return runTranscription(request)
}

/** A Dictation that produced text, whether or not a Formatting Mode rewrote it. */
export interface Speech2TextSuccess {
  status: 'ok'
  raw: string
  output: string
  formattingUsed: boolean
}

/**
 * What the pipeline produced, carried rather than raised.
 *
 * A failed Speech Engine used to be invisible here: a non-zero exit returned stdout anyway,
 * so an empty transcript was pasted over the user's cursor, written to history and counted
 * in stats. The failed arm is that fact, with the reason and the sentence the engine adapter
 * wrote for it. Nothing is pasted, nothing is recorded. See ADR-0006.
 */
export type Speech2TextResult = Speech2TextSuccess | FailedTranscription

export const speech2text = async (
  plan: RunnableDictationPlan,
  formattingSettings: FormattingRuntimeSettings,
  dictionaryEntries: DictionaryEntry[] = [],
  onBeforeTranscription?: () => Promise<void>,
  onAppliedEntries?: (entries: DictionaryEntry[]) => void
): Promise<Speech2TextResult> => {
  if (onBeforeTranscription) await onBeforeTranscription()

  const engineResult = await transcribe(plan)
  if (engineResult.status === 'failed') return engineResult

  // The shipped brand table first, then the user Dictionary. Both are app rewrites of what
  // the Speech Engine said, and both sit above the engine seam so the benchmark scores raw
  // hypotheses.
  let transcript = fixBrandMishearings(engineResult.rawTranscript)
  if (dictionaryEntries.length > 0) {
    const result = applyDictionary(transcript, dictionaryEntries, {
      trackApplied: true,
    })
    transcript = result.text
    if (onAppliedEntries && result.appliedEntries.length > 0) {
      onAppliedEntries(result.appliedEntries)
    }
  }
  const rawTranscript = transcript
  let formattingUsed = false
  const formatterRequest = await buildFormatterRequest(
    transcript,
    formattingSettings
  )
  if (formatterRequest !== null) {
    transcript = await applyFormatting(formatterRequest)
    formattingUsed = true
  }
  await pasteTranscript(transcript)
  return {
    status: 'ok',
    raw: rawTranscript,
    output: transcript,
    formattingUsed,
  }
}
