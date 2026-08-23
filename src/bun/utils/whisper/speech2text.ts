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
import { RECORDING_PATH } from '../../platform/runtime'
import { runTranscription } from './engines/run-transcription'
import {
  transcriptionRequestFromPlan,
  type FailedTranscription,
  type TranscriptionResult,
} from './engines/transcription'

/**
 * Whisper often splits or mishears the product name — normalize before paste.
 * Order: phrase mishearings first, then codec+tate|tape|sheet|shade (incl. Codec Tate, Codec Tape, Codec Sheet, Codic shade, glued forms), then kodictate/codictate (any casing).
 */
const BRAND_TRANSCRIPT_FIXES: [RegExp, string][] = [
  [/\bcode\s+dictate\b/gi, 'Codictate'],
  [/\bcoding\s*tate\b/gi, 'Codictate'],
  [/\bco(?:\s+|[-–—]\s*)dictate\b/gi, 'Codictate'],
  [/\bkodi\s+dicate\b/gi, 'Codictate'],
  [/\bkodi\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tet\b/gi, 'Codictate'],
  [/\bkodiktet\b/gi, 'Codictate'],
  [/\bkodiktete\b/gi, 'Codictate'],
  [/\bkodig\s+tate\b/gi, 'Codictate'],
  [/\bkodigtate\b/gi, 'Codictate'],
  [/\bkodig\s+tet\b/gi, 'Codictate'],
  [/\bkodigtet\b/gi, 'Codictate'],
  [/\bko\s+digtet\b/gi, 'Codictate'],
  [/\bkodigt\s+tade\b/gi, 'Codictate'],
  [/\bkodigttade\b/gi, 'Codictate'],
  [/\bkodigtede\b/gi, 'Codictate'],
  [/\bkodig\s+tede\b/gi, 'Codictate'],
  [/\bko\s+digtede\b/gi, 'Codictate'],
  [/\bKodak\s+Tech\b/gi, 'Codictate'],
  [/\bKodakTech\b/gi, 'Codictate'],
  [/\bcodec\s+cheat\b/gi, 'Codictate'],
  [/\bcodeccheat\b/gi, 'Codictate'],
  [/\bcodec\s+sheet\b/gi, 'Codictate'],
  [/\bcodecsheet\b/gi, 'Codictate'],
  [/\bcodic\s+shade\b/gi, 'Codictate'],
  [/\bcodicshade\b/gi, 'Codictate'],
  [/\bcodec\s*t(?:ate|ape)\b/gi, 'Codictate'],
  [/\bcodec\s+tade\b/gi, 'Codictate'],
  [/\bcodectade\b/gi, 'Codictate'],
  [/\bcodexade\b/gi, 'Codictate'],
  [/\bcodex\s+ade\b/gi, 'Codictate'],
  [/\bcode\s+xade\b/gi, 'Codictate'],
  [/\bkodiktat\b/gi, 'Codictate'],
  [/\bkodiktate\b/gi, 'Codictate'],
  [/\bkodic\s+tate\b/gi, 'Codictate'],
  [/\bkodictate\b/gi, 'Codictate'],
  [/\bcodictate\b/gi, 'Codictate'],
  [/\bCodigTate\b/gi, 'Codictate'],
  [/\bCodig\s+Tate\b/gi, 'Codictate'],
  [/\bCodeictate\b/gi, 'Codictate'],
]

export function fixBrandMishearings(text: string): string {
  let t = text
  for (const [pattern, replacement] of BRAND_TRANSCRIPT_FIXES) {
    t = t.replace(pattern, replacement)
  }
  return t
}

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
 * The spawn itself moved out from under here into the Speech Engine Adapters. What is left
 * is the derivation - plan plus audio plus resolved weights path - and the brand table,
 * which is an app concern above the engine seam rather than part of what the engine said.
 * See ADR-0006.
 */
export const transcribe = async (
  plan: RunnableDictationPlan
): Promise<TranscriptionResult> => {
  const request = transcriptionRequestFromPlan(
    plan,
    RECORDING_PATH,
    modelManager
  )
  const result = await runTranscription(request)
  if (result.status === 'failed') return result
  return {
    status: 'ok',
    rawTranscript: fixBrandMishearings(result.rawTranscript),
  }
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

  let transcript = engineResult.rawTranscript
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
