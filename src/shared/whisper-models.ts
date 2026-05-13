import {
  SPEECH_MODELS,
  type SpeechModel,
  DEFAULT_MODEL_ID as SPEECH_DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  formatModelSize,
  getSpeechModel,
  isValidSpeechModelId,
  supportsStreamMode,
  parakeetSupportsTranscriptionLanguageId,
} from './speech-models'

/** @deprecated Use SpeechModel — retained for Whisper.ggml entries in UI */
export type WhisperModel = Pick<
  SpeechModel,
  'id' | 'label' | 'description' | 'bundled'
> & { filename: string; sizeMB: number }

export const WHISPER_MODELS: WhisperModel[] = SPEECH_MODELS.filter(
  (m) => m.engine === 'whisper_cpp'
).map((m) => ({
  id: m.id,
  filename: m.artifactName,
  sizeMB: m.downloadSizeMB,
  label: m.label,
  description: m.description,
  bundled: m.bundled,
}))

export const DEFAULT_MODEL_ID = SPEECH_DEFAULT_MODEL_ID

export {
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  formatModelSize,
  parakeetSupportsTranscriptionLanguageId,
}

/** Whisper models that support the `-tr` (translate to English) flag. English-only and turbo models cannot. */
export const TRANSLATE_CAPABLE_MODEL_IDS: string[] = SPEECH_MODELS.filter(
  (m) => m.engine === 'whisper_cpp' && m.translationSupport
).map((m) => m.id)

export const LARGE_V3_Q5_MODEL_ID = 'large-v3-q5_0'

export const DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID = 'small-q5_1'

export const WHISPER_MODEL_IDS = WHISPER_MODELS.map((m) => m.id)

export function isTranslateCapableModelId(id: string): boolean {
  return TRANSLATE_CAPABLE_MODEL_IDS.includes(id)
}

export function resolveTranslateModelId(
  selectedWhisperModelId: string,
  isModelAvailable: (id: string) => boolean
): string | null {
  if (!isTranslateCapableModelId(selectedWhisperModelId)) {
    return null
  }
  if (!isModelAvailable(selectedWhisperModelId)) {
    return null
  }
  return selectedWhisperModelId
}

export function hasAnyTranslateCapableModelAvailable(
  isModelAvailable: (id: string) => boolean
): boolean {
  return TRANSLATE_CAPABLE_MODEL_IDS.some((id) => isModelAvailable(id))
}

export type TranslateReadiness =
  | { kind: 'ready' }
  | { kind: 'need_download' }
  | { kind: 'need_switch_model' }
  | { kind: 'need_language' }

export function getTranslateReadiness(
  whisperModelId: string,
  transcriptionLanguageId: string,
  translateDefaultLanguageId: string,
  isModelAvailable: (id: string) => boolean
): TranslateReadiness {
  const langOk =
    transcriptionLanguageId !== 'auto' || translateDefaultLanguageId !== 'auto'
  if (!langOk) {
    return { kind: 'need_language' }
  }

  if (resolveTranslateModelId(whisperModelId, isModelAvailable) !== null) {
    return { kind: 'ready' }
  }

  if (isTranslateCapableModelId(whisperModelId)) {
    return { kind: 'need_download' }
  }

  if (hasAnyTranslateCapableModelAvailable(isModelAvailable)) {
    return { kind: 'need_switch_model' }
  }

  return { kind: 'need_download' }
}

export function getWhisperModel(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id)
}

export function isValidWhisperModelId(id: string): boolean {
  return isValidSpeechModelId(id)
}

export function whisperModelDownloadUrl(filename: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`
}

export function isStreamCapableModelId(id: string): boolean {
  const m = getSpeechModel(id)
  return m != null && supportsStreamMode(m)
}

export type StreamModeReadiness =
  | { kind: 'ready' }
  | { kind: 'need_parakeet_download' }
  | { kind: 'need_switch_model' }
  | { kind: 'need_language' }
  | { kind: 'need_warmup' }

/** Whether stream (Parakeet) dictation can be enabled with the given config. */
export function getStreamModeReadiness(
  whisperModelId: string,
  transcriptionLanguageId: string,
  isModelAvailable: (id: string) => boolean,
  parakeetCoreMlReady: boolean
): StreamModeReadiness {
  if (!isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID)) {
    return { kind: 'need_parakeet_download' }
  }
  if (!isStreamCapableModelId(whisperModelId)) {
    return { kind: 'need_switch_model' }
  }
  if (!parakeetSupportsTranscriptionLanguageId(transcriptionLanguageId)) {
    return { kind: 'need_language' }
  }
  if (!parakeetCoreMlReady) {
    return { kind: 'need_warmup' }
  }
  return { kind: 'ready' }
}
