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
import type { FileTranscriptionSettings } from '../../shared/types'
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
 * What a File Transcription reads from the config: the File Transcription Settings (already
 * healed and validated) and the translate default, the source language a translate run from
 * automatic detection uses. `AppConfig` satisfies it structurally.
 */
export interface FileTranscriptionSettingsReader {
  getFileTranscriptionSettings(): FileTranscriptionSettings
  getTranslateDefaultLanguageId(): string
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

/** What one request runs with, fixed when it is queued. */
export interface FileTranscriptionSelection {
  speechModelId: string
  /** Already coerced for the Speech Model, as a settings write would leave it. */
  transcriptionLanguageId: string
  /** The request's own choice, or the File Transcription Settings' one. */
  translateToEnglish: boolean
  /** The source language a translate run from automatic detection uses. */
  translateDefaultLanguageId: string
}

function override(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function languageLabel(id: string): string {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.find((o) => o.id === id)?.label ?? id
}

/**
 * A Speech Model and Transcription Language: `defaults` with the request's overrides on top.
 * Shared by File Transcription (defaults: the File Transcription Settings) and a command-line
 * Dictation (defaults: the Dictation's settings), so both check overrides the same way.
 *
 * The overrides are validated the way a settings write validates them: an id the catalog
 * does not know is refused, and a Transcription Language the Speech Model cannot take is
 * coerced (`coerceTranscriptionLanguageIdForModel`), never refused, unless no coercion makes
 * it allowed. With today's catalog coercion always lands on an allowed language, so
 * `language_not_allowed` is the guard for a catalog entry that would break that.
 */
export function selectSpeechModelAndLanguage(
  defaults: { speechModelId: string; transcriptionLanguageId: string },
  request: Pick<FileTranscriptionRequest, 'speechModelId' | 'languageId'>
):
  | { status: 'ok'; speechModelId: string; transcriptionLanguageId: string }
  | FileTranscriptionFailure {
  const modelOverride = override(request.speechModelId)
  if (modelOverride !== null && getSpeechModel(modelOverride) === undefined) {
    return fileTranscriptionFailure(
      'unknown_model',
      `There is no Speech Model called "${modelOverride}". Run codictate models list --all to see them.`
    )
  }
  const speechModelId = modelOverride ?? defaults.speechModelId
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
  const requestedLanguage = rawLanguage ?? defaults.transcriptionLanguageId
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

  return { status: 'ok', speechModelId, transcriptionLanguageId }
}

/**
 * The File Transcription Settings with the request's overrides on top, read once, when the
 * job is queued: a settings change while it waits does not change what it runs.
 *
 * Translate to English is the request's when it says (`true` or `false`), otherwise the File
 * Transcription Settings' one. The window leaves it to the settings; the command line always
 * says, so its File Transcriptions translate only with `--translate`. Whether it can run is
 * the plan's question, not this one's.
 */
export function selectFileTranscription(
  settings: FileTranscriptionSettingsReader,
  request: Pick<
    FileTranscriptionRequest,
    'speechModelId' | 'languageId' | 'translateToEnglish'
  >
):
  | { status: 'ok'; selection: FileTranscriptionSelection }
  | FileTranscriptionFailure {
  const current = settings.getFileTranscriptionSettings()
  const selected = selectSpeechModelAndLanguage(current, request)
  if (selected.status === 'failed') return selected
  return {
    status: 'ok',
    selection: {
      speechModelId: selected.speechModelId,
      transcriptionLanguageId: selected.transcriptionLanguageId,
      translateToEnglish:
        request.translateToEnglish ?? current.translateToEnglish,
      translateDefaultLanguageId: settings.getTranslateDefaultLanguageId(),
    },
  }
}

/**
 * The selection as a runnable batch plan, or why there is none.
 *
 * Always batch, because a file is not a Dictation and Live Transcription is a microphone
 * session. Translate to English runs exactly as a Dictation's would: the plan refuses a
 * Speech Model that cannot translate, and a translate run from automatic detection takes
 * the translate default as its source language. Nothing substitutes.
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
      translateDefaultLanguageId: selection.translateDefaultLanguageId,
      translateToEnglish: selection.translateToEnglish,
      streamMode: false,
    },
    // Batch only, so whether this platform can stream never comes up.
    { isModelAvailable, streamSupported: false }
  )
  if (plan.status === 'runnable') return { status: 'runnable', plan }
  const label = modelLabel(selection.speechModelId)
  switch (plan.reason) {
    case 'speech_model_not_installed':
      return fileTranscriptionFailure(
        'model_not_installed',
        `Speech Model ${selection.speechModelId} is not installed. Download it in Codictate's Settings, or run codictate models download ${selection.speechModelId}.`
      )
    case 'model_cannot_translate':
      return fileTranscriptionFailure(
        'cannot_translate',
        `${label} can't translate to English. Choose a Whisper Small or Large Speech Model, or turn off Translate to English.`
      )
    case 'no_translate_source_language':
      return fileTranscriptionFailure(
        'cannot_translate',
        'Translate to English needs a Transcription Language. Choose one instead of Auto-detect.'
      )
    default:
      // Live Transcription reasons: unreachable for a batch plan.
      return fileTranscriptionFailure('internal', plan.message)
  }
}

/**
 * The plan as a Transcription Request, through the derivation a Dictation uses, plus what
 * only File Transcription needs: a way to cancel, and lowered OS priority so a Dictation
 * never waits behind it.
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
