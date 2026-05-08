/**
 * Speech model catalog: whisper.cpp GGML files and Parakeet TDT v3 (Core ML on macOS,
 * ONNX on Windows). `engine: 'whisperkit'` is the historical Parakeet engine label.
 */

import { TRANSCRIPTION_LANGUAGE_OPTIONS } from './transcription-languages'

export type SpeechEngineId = 'whisper_cpp' | 'whisperkit'

export type SpeechModelModeSupport = 'normal' | 'stream' | 'both'

/** localStorage: set after first Parakeet transcribe/stream session ends so Ready UI stops showing the prep hint. */
export const PARAKEET_COREML_PREP_STORAGE_KEY =
  'codictate.parakeetCoreMlPrepCompleted'

/** One line under Transcribing… / Streaming… on first Parakeet use. */
export const PARAKEET_FIRST_RUN_READY_SUBTITLE =
  'First run: preparing the model can take 1-2 minutes. Later runs are fast.'

/** Settings / model row: why the first session can feel stuck. */
export const PARAKEET_FIRST_RUN_SETTINGS_HINT =
  'First run: Codictate may take 1-2 minutes to prepare Parakeet for this device. It may look stuck, but subsequent runs are fast.'

/** Stream mode helper (Transcription section has the full explanation). */
export const PARAKEET_FIRST_RUN_STREAM_HELPER =
  'First stream run takes 1-2 minutes to prepare the model (see Transcription).'

/** European-language set aligned with Parakeet TDT v3 multilingual (25 locales we expose in Settings). */
const PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'pl',
  'nl',
  'ru',
  'cs',
  'el',
  'fi',
  'sv',
  'da',
  'ro',
  'hu',
  'sk',
  'hr',
  'sl',
  'bg',
  'uk',
  'et',
  'lv',
  'lt',
  'ca',
] as const

export interface SpeechModel {
  id: string
  engine: SpeechEngineId
  modeSupport: SpeechModelModeSupport
  /** Display / disk artifact — Whisper ggml filename or Parakeet directory name under models root */
  artifactName: string
  downloadSizeMB: number
  label: string
  description: string
  bundled?: boolean
  translationSupport: boolean
  /** Hugging Face repo for downloadable models (not used for bundled whisper ggml) */
  huggingFaceRepoId?: string
  /** Transcription language ids (from transcription-languages) Parakeet v3 supports; empty = use Whisper rules */
  supportedTranscriptionLanguageIds?: readonly string[]
}

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: 'small-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small-q5_1.bin',
    downloadSizeMB: 181,
    label: 'Small',
    description: 'Whisper model · good accuracy',
    translationSupport: true,
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo-q5_0.bin',
    downloadSizeMB: 574,
    label: 'Turbo',
    description: 'Whisper model · fast and very accurate — default',
    bundled: true,
    translationSupport: false,
  },
  {
    id: 'large-v3-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-q5_0.bin',
    downloadSizeMB: 1100,
    label: 'Large',
    description: 'Whisper model · most accurate, best for translation',
    translationSupport: true,
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    engine: 'whisperkit',
    modeSupport: 'both',
    artifactName: 'parakeet-tdt-0.6b-v3-coreml',
    downloadSizeMB: 500,
    label: 'Parakeet TDT v3',
    description:
      'Nvidia model · fastest & live dictation · first session may need model prep (minutes)',
    bundled: false,
    translationSupport: false,
    huggingFaceRepoId: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
    supportedTranscriptionLanguageIds: PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS,
  },
]

export const DEFAULT_MODEL_ID = 'large-v3-turbo-q5_0'

/** Recommended stream engine model (must be installed; not bundled). */
export const DEFAULT_STREAM_CAPABLE_MODEL_ID = 'parakeet-tdt-0.6b-v3'

export const SPEECH_MODEL_IDS = SPEECH_MODELS.map((m) => m.id)

export function getSpeechModel(id: string): SpeechModel | undefined {
  return SPEECH_MODELS.find((m) => m.id === id)
}

export function isValidSpeechModelId(id: string): boolean {
  return SPEECH_MODEL_IDS.includes(id)
}

export function supportsStreamMode(model: SpeechModel): boolean {
  return model.modeSupport === 'stream' || model.modeSupport === 'both'
}

/** Parakeet (Core ML) has no fixed-language setting; the UI locks transcription language to automatic. */
export function speechModelLocksTranscriptionLanguage(
  speechModelId: string
): boolean {
  return getSpeechModel(speechModelId)?.engine === 'whisperkit'
}

/** `auto` is always allowed. Whisper models (no `supportedTranscriptionLanguageIds`) allow every picker id. */
export function transcriptionLanguageAllowedForModel(
  speechModelId: string,
  transcriptionLanguageId: string
): boolean {
  if (transcriptionLanguageId === 'auto') return true
  const model = getSpeechModel(speechModelId)
  const list = model?.supportedTranscriptionLanguageIds
  if (!list?.length) return true
  return (list as readonly string[]).includes(transcriptionLanguageId)
}

export function parakeetSupportsTranscriptionLanguageId(id: string): boolean {
  return transcriptionLanguageAllowedForModel(
    DEFAULT_STREAM_CAPABLE_MODEL_ID,
    id
  )
}

/** When switching model, normalize stored transcription language (Parakeet → always auto). */
export function coerceTranscriptionLanguageIdForModel(
  speechModelId: string,
  currentTranscriptionLanguageId: string
): string {
  if (speechModelLocksTranscriptionLanguage(speechModelId)) {
    return 'auto'
  }
  if (
    transcriptionLanguageAllowedForModel(
      speechModelId,
      currentTranscriptionLanguageId
    )
  ) {
    return currentTranscriptionLanguageId
  }
  return 'auto'
}

/** Settings tooltip: Parakeet language names only (no ISO codes), sorted A–Z. */
export function parakeetSupportedLanguagesTooltipText(): string {
  const byId = new Map(
    TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => [o.id, o.label])
  )
  const labels = PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS.map((id) =>
    byId.get(id)
  ).filter((l): l is string => l != null)
  labels.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return (
    `Parakeet supports ${labels.length} languages for stream and batch dictation:\n` +
    labels.join(', ') +
    '.'
  )
}

export function formatModelSize(sizeMB: number): string {
  if (sizeMB >= 1000) return `${(sizeMB / 1000).toFixed(1)} GB`
  return `${sizeMB} MB`
}
