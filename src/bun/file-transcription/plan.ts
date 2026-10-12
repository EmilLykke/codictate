/**
 * What a File Transcription runs, decided by the one resolver.
 *
 * Pure: no spawn, no filesystem, no platform probe. Nothing here picks a Speech Engine, a
 * crispasr backend or a pinned language. The selection goes through `buildDictationPlan`,
 * the resolver a press of the Dictation Shortcut uses (ADR-0005), so the Danish pin and the
 * hviske `cohere` backend apply here because they apply there. Never add a model-to-engine
 * table to this module.
 *
 * Read-only. Nothing here writes the config or heals it: a selection whose weights are gone
 * is reported as `model_not_installed`, and the app's own heal pass repairs it.
 */

import {
  buildDictationPlan,
  modelLabel,
  type RunnableDictationPlan,
} from '../../shared/dictation-plan'
import {
  coerceTranscriptionLanguageIdForModel,
  getSpeechModel,
  pinnedTranscriptionLanguageId,
  transcriptionLanguageAllowedForModel,
  type SpeechEngineId,
} from '../../shared/speech-models'
import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  isValidTranscriptionLanguageId,
} from '../../shared/transcription-languages'
import {
  transcriptionRequestFromPlan,
  type SpeechModelLocations,
  type TranscriptionFailureReason,
  type TranscriptionRequest,
} from '../utils/whisper/engines/transcription'
import type {
  FileTranscriptionErrorCode,
  FileTranscriptionRequest,
  PublicSpeechEngineName,
} from './types'

/**
 * The two settings a File Transcription reads. `AppConfig` satisfies it structurally
 * (`getSpeechModelId()`, `getTranscriptionLanguageId()`), already healed and validated.
 */
export interface FileTranscriptionSettingsReader {
  getSpeechModelId(): string
  getTranscriptionLanguageId(): string
}

export interface FileTranscriptionFailure {
  status: 'failed'
  code: FileTranscriptionErrorCode
  message: string
}

export function fileTranscriptionFailure(
  code: FileTranscriptionErrorCode,
  message: string
): FileTranscriptionFailure {
  return { status: 'failed', code, message: oneLine(message) }
}

/** The Speech Model and Transcription Language one request asks for, fixed when it is queued. */
export interface FileTranscriptionSelection {
  speechModelId: string
  /** Already coerced for the Speech Model, as a settings write would leave it. */
  transcriptionLanguageId: string
}

function override(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function languageLabel(id: string): string {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.find((o) => o.id === id)?.label ?? id
}

/**
 * The current settings with the request's overrides on top.
 *
 * The overrides are validated the way a settings write validates them: an id the catalog
 * does not know is refused, and a Transcription Language the Speech Model cannot take is
 * coerced (`coerceTranscriptionLanguageIdForModel`), never refused, unless no coercion makes
 * it allowed. With today's catalog coercion always lands on an allowed language, so
 * `language_not_allowed` is the guard for a catalog entry that would break that.
 */
export function selectFileTranscription(
  settings: FileTranscriptionSettingsReader,
  request: Pick<FileTranscriptionRequest, 'speechModelId' | 'languageId'>
):
  | { status: 'ok'; selection: FileTranscriptionSelection }
  | FileTranscriptionFailure {
  const modelOverride = override(request.speechModelId)
  if (modelOverride !== null && getSpeechModel(modelOverride) === undefined) {
    return fileTranscriptionFailure(
      'unknown_model',
      `There is no Speech Model called "${modelOverride}". Run codictate models list --all to see them.`
    )
  }
  const speechModelId = modelOverride ?? settings.getSpeechModelId()
  if (getSpeechModel(speechModelId) === undefined) {
    // The setting is validated on every load and write, so this is a broken installation.
    return fileTranscriptionFailure(
      'unknown_model',
      `The selected Speech Model "${speechModelId}" is not one Codictate knows.`
    )
  }

  const rawLanguage = override(request.languageId)?.toLowerCase() ?? null
  if (rawLanguage !== null && !isValidTranscriptionLanguageId(rawLanguage)) {
    return fileTranscriptionFailure(
      'unknown_language',
      `There is no Transcription Language called "${rawLanguage}". Run codictate languages list to see them.`
    )
  }
  const requestedLanguage = rawLanguage ?? settings.getTranscriptionLanguageId()
  const transcriptionLanguageId = coerceTranscriptionLanguageIdForModel(
    speechModelId,
    requestedLanguage
  )
  if (
    pinnedTranscriptionLanguageId(speechModelId) === null &&
    !transcriptionLanguageAllowedForModel(
      speechModelId,
      transcriptionLanguageId
    )
  ) {
    return fileTranscriptionFailure(
      'language_not_allowed',
      `${modelLabel(speechModelId)} cannot transcribe ${languageLabel(requestedLanguage)}.`
    )
  }

  return { status: 'ok', selection: { speechModelId, transcriptionLanguageId } }
}

/**
 * The selection as a runnable batch plan, or why there is none.
 *
 * Two differences from a press of the Dictation Shortcut, each because a file is not a
 * Dictation: always batch (Live Transcription is a microphone session), and never
 * Translate to English (the command transcribes what was said). With both off, the only way
 * a batch plan blocks is weights that are not installed.
 */
export function planFileTranscription(
  selection: FileTranscriptionSelection,
  isModelAvailable: (speechModelId: string) => boolean
):
  | { status: 'runnable'; plan: RunnableDictationPlan }
  | FileTranscriptionFailure {
  const plan = buildDictationPlan(
    {
      speechModelId: selection.speechModelId,
      transcriptionLanguageId: selection.transcriptionLanguageId,
      translateDefaultLanguageId: 'auto',
      translateToEnglish: false,
      streamMode: false,
    },
    // Batch only, so whether this platform can stream never comes up.
    { isModelAvailable, streamSupported: false }
  )
  if (plan.status === 'runnable') return { status: 'runnable', plan }
  return fileTranscriptionFailure(
    'model_not_installed',
    `Speech Model ${selection.speechModelId} is not installed. Download it in Codictate's Settings, or run codictate models download ${selection.speechModelId}.`
  )
}

/**
 * The plan as a Transcription Request, through the derivation a Dictation uses, plus what
 * only File Transcription needs: a way to cancel, and lowered OS priority so a Dictation
 * never waits behind it.
 *
 * No timestamps. whisper.cpp only prints usable segment times when `-nt` is dropped, and
 * dropping it changes decoding: measured on Edda, the transcript turned to noise.
 */
export function fileTranscriptionRequest(
  plan: RunnableDictationPlan,
  audioPath: string,
  timeoutMs: number,
  locations: SpeechModelLocations,
  signal?: AbortSignal
): TranscriptionRequest {
  return {
    ...transcriptionRequestFromPlan(plan, audioPath, timeoutMs, locations),
    signal,
    lowPriority: true,
  }
}

const PUBLIC_ENGINE_NAME: Record<SpeechEngineId, PublicSpeechEngineName> = {
  whisper_cpp: 'whisper',
  // `whisperkit` is a misnomer for FluidAudio's Parakeet.
  whisperkit: 'parakeet',
  hviske: 'hviske',
}

export function publicEngineName(
  engineId: SpeechEngineId
): PublicSpeechEngineName {
  return PUBLIC_ENGINE_NAME[engineId]
}

/** The Transcription Language the run was fixed to, or `null` when the engine detects it. */
export function resultLanguage(plan: RunnableDictationPlan): string | null {
  return plan.transcriptionLanguageId === 'auto'
    ? null
    : plan.transcriptionLanguageId
}

/**
 * File Transcription's own sentence per engine failure. The Transcription Result's
 * `message` is written for a Dictation ("Nothing was pasted"), which is the wrong sentence
 * for a file. Exhaustive, so a new failure reason does not compile without one.
 */
const FAILURE_SENTENCES: Record<
  TranscriptionFailureReason,
  (label: string) => string
> = {
  engine_exited_nonzero: (label) => `${label} exited without transcribing`,
  engine_runtime_missing: (label) =>
    `${label} could not be started: its engine or its weights are missing`,
  engine_timed_out: (label) => `${label} took too long and was stopped`,
  parakeet_no_final_line: (label) =>
    `${label} finished without returning a transcript`,
  engine_output_unreadable: (label) =>
    `${label} returned output that could not be read`,
  cancelled: (label) => `the transcription with ${label} was cancelled`,
}

/** One line for a failed run: the sentence, then the engine's own words, flattened. */
export function engineFailureLine(
  reason: TranscriptionFailureReason,
  speechModelId: string,
  diagnostic?: string
): string {
  const sentence = FAILURE_SENTENCES[reason](modelLabel(speechModelId))
  return diagnostic ? `${sentence} (${oneLine(diagnostic, 300)})` : sentence
}

/** Collapse whitespace so a message is exactly one line, keeping the end when it is long. */
export function oneLine(text: string, maxChars = 500): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `...${flat.slice(-maxChars)}`
}
