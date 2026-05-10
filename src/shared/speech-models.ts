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
  peakRamMB: number
  label: string
  description: string
  bundled?: boolean
  /** Always visible in the model picker (not just browse modal). */
  curated?: boolean
  translationSupport: boolean
  /** Hugging Face repo for downloadable models (not used for bundled whisper ggml) */
  huggingFaceRepoId?: string
  /** Transcription language ids (from transcription-languages) Parakeet v3 supports; empty = use Whisper rules */
  supportedTranscriptionLanguageIds?: readonly string[]
}

export const SPEECH_MODELS: SpeechModel[] = [
  // ── Curated models (always visible in picker) ──────────────────────
  {
    id: 'parakeet-tdt-0.6b-v3',
    engine: 'whisperkit',
    modeSupport: 'both',
    artifactName: 'parakeet-tdt-0.6b-v3-coreml',
    downloadSizeMB: 500,
    peakRamMB: 80,
    label: 'Parakeet TDT v3',
    description: 'Nvidia model · fastest, 3-10x faster, 80 MB RAM',
    bundled: false,
    curated: true,
    translationSupport: false,
    huggingFaceRepoId: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
    supportedTranscriptionLanguageIds: PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS,
  },
  {
    id: 'small.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en-q5_1.bin',
    downloadSizeMB: 181,
    peakRamMB: 475,
    label: 'Small English',
    description: 'Whisper model · best lightweight English, 475 MB RAM',
    curated: true,
    translationSupport: false,
  },
  {
    id: 'medium.en-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en-q5_0.bin',
    downloadSizeMB: 514,
    peakRamMB: 1122,
    label: 'Medium English',
    description: 'Whisper model · best English accuracy, 1.1 GB RAM',
    curated: true,
    translationSupport: false,
  },
  {
    id: 'small-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small-q5_1.bin',
    downloadSizeMB: 181,
    peakRamMB: 475,
    label: 'Small',
    description: 'Whisper model · lightweight multilingual, 475 MB RAM',
    curated: true,
    translationSupport: true,
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo-q5_0.bin',
    downloadSizeMB: 574,
    peakRamMB: 800,
    label: 'Large V3 Turbo',
    description: 'Whisper model · daily driver multilingual, 800 MB RAM',
    bundled: true,
    curated: true,
    translationSupport: false,
  },
  {
    id: 'large-v3-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-q5_0.bin',
    downloadSizeMB: 1100,
    peakRamMB: 1986,
    label: 'Large V3',
    description: 'Whisper model · highest accuracy, multilingual, 2.0 GB RAM',
    curated: true,
    translationSupport: true,
  },

  // ── Extended Whisper models (visible via browse modal) ─────────────
  // Tiny
  {
    id: 'tiny',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.bin',
    downloadSizeMB: 75,
    peakRamMB: 224,
    label: 'Tiny',
    description: 'Whisper model · smallest multilingual, 224 MB RAM',
    translationSupport: true,
  },
  {
    id: 'tiny-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny-q5_1.bin',
    downloadSizeMB: 31,
    peakRamMB: 156,
    label: 'Tiny',
    description:
      'Whisper model · smallest multilingual, Q5 quantized, 156 MB RAM',
    translationSupport: true,
  },
  {
    id: 'tiny-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny-q8_0.bin',
    downloadSizeMB: 42,
    peakRamMB: 173,
    label: 'Tiny',
    description:
      'Whisper model · smallest multilingual, Q8 quantized, 173 MB RAM',
    translationSupport: true,
  },
  {
    id: 'tiny.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en.bin',
    downloadSizeMB: 75,
    peakRamMB: 223,
    label: 'Tiny',
    description: 'Whisper model · smallest English-only, 223 MB RAM',
    translationSupport: false,
  },
  {
    id: 'tiny.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en-q5_1.bin',
    downloadSizeMB: 31,
    peakRamMB: 157,
    label: 'Tiny',
    description:
      'Whisper model · smallest English-only, Q5 quantized, 157 MB RAM',
    translationSupport: false,
  },
  {
    id: 'tiny.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en-q8_0.bin',
    downloadSizeMB: 42,
    peakRamMB: 173,
    label: 'Tiny',
    description:
      'Whisper model · smallest English-only, Q8 quantized, 173 MB RAM',
    translationSupport: false,
  },
  // Base
  {
    id: 'base',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.bin',
    downloadSizeMB: 142,
    peakRamMB: 334,
    label: 'Base',
    description: 'Whisper model · lightweight multilingual, 334 MB RAM',
    translationSupport: true,
  },
  {
    id: 'base-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base-q5_1.bin',
    downloadSizeMB: 57,
    peakRamMB: 218,
    label: 'Base',
    description:
      'Whisper model · lightweight multilingual, Q5 quantized, 218 MB RAM',
    translationSupport: true,
  },
  {
    id: 'base-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base-q8_0.bin',
    downloadSizeMB: 78,
    peakRamMB: 247,
    label: 'Base',
    description:
      'Whisper model · lightweight multilingual, Q8 quantized, 247 MB RAM',
    translationSupport: true,
  },
  {
    id: 'base.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en.bin',
    downloadSizeMB: 142,
    peakRamMB: 333,
    label: 'Base',
    description: 'Whisper model · lightweight English-only, 333 MB RAM',
    translationSupport: false,
  },
  {
    id: 'base.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en-q5_1.bin',
    downloadSizeMB: 57,
    peakRamMB: 217,
    label: 'Base',
    description:
      'Whisper model · lightweight English-only, Q5 quantized, 217 MB RAM',
    translationSupport: false,
  },
  {
    id: 'base.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en-q8_0.bin',
    downloadSizeMB: 78,
    peakRamMB: 247,
    label: 'Base',
    description:
      'Whisper model · lightweight English-only, Q8 quantized, 247 MB RAM',
    translationSupport: false,
  },
  // Small (extended variants - curated small-q5_1 is above)
  {
    id: 'small',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.bin',
    downloadSizeMB: 466,
    peakRamMB: 807,
    label: 'Small',
    description: 'Whisper model · good accuracy, full precision, 807 MB RAM',
    translationSupport: true,
  },
  {
    id: 'small-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small-q8_0.bin',
    downloadSizeMB: 252,
    peakRamMB: 558,
    label: 'Small',
    description: 'Whisper model · good accuracy, Q8 quantized, 558 MB RAM',
    translationSupport: true,
  },
  {
    id: 'small.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en.bin',
    downloadSizeMB: 466,
    peakRamMB: 806,
    label: 'Small',
    description: 'Whisper model · good accuracy English-only, 806 MB RAM',
    translationSupport: false,
  },
  {
    id: 'small.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en-q8_0.bin',
    downloadSizeMB: 252,
    peakRamMB: 558,
    label: 'Small',
    description:
      'Whisper model · good accuracy English-only, Q8 quantized, 558 MB RAM',
    translationSupport: false,
  },
  // Medium
  {
    id: 'medium',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2137,
    label: 'Medium',
    description: 'Whisper model · high accuracy multilingual, 2.1 GB RAM',
    translationSupport: true,
  },
  {
    id: 'medium-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium-q5_0.bin',
    downloadSizeMB: 514,
    peakRamMB: 1122,
    label: 'Medium',
    description:
      'Whisper model · high accuracy multilingual, Q5 quantized, 1.1 GB RAM',
    translationSupport: true,
  },
  {
    id: 'medium-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium-q8_0.bin',
    downloadSizeMB: 785,
    peakRamMB: 1412,
    label: 'Medium',
    description:
      'Whisper model · high accuracy multilingual, Q8 quantized, 1.4 GB RAM',
    translationSupport: true,
  },
  {
    id: 'medium.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2135,
    label: 'Medium',
    description: 'Whisper model · high accuracy English-only, 2.1 GB RAM',
    translationSupport: false,
  },
  {
    id: 'medium.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en-q8_0.bin',
    downloadSizeMB: 785,
    peakRamMB: 1412,
    label: 'Medium',
    description:
      'Whisper model · high accuracy English-only, Q8 quantized, 1.4 GB RAM',
    translationSupport: false,
  },
  // Large V1
  {
    id: 'large-v1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v1.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3977,
    label: 'Large V1',
    description: 'Whisper model · original large model, 4.0 GB RAM',
    translationSupport: true,
  },
  // Large V2
  {
    id: 'large-v2',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3977,
    label: 'Large V2',
    description: 'Whisper model · improved large model, 4.0 GB RAM',
    translationSupport: true,
  },
  {
    id: 'large-v2-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2-q5_0.bin',
    downloadSizeMB: 1100,
    peakRamMB: 1974,
    label: 'Large V2',
    description: 'Whisper model · improved large, Q5 quantized, 2.0 GB RAM',
    translationSupport: true,
  },
  {
    id: 'large-v2-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2-q8_0.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2546,
    label: 'Large V2',
    description: 'Whisper model · improved large, Q8 quantized, 2.5 GB RAM',
    translationSupport: true,
  },
  // Large V3 (extended variants - curated large-v3-q5_0 is above)
  {
    id: 'large-v3',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3983,
    label: 'Large V3',
    description: 'Whisper model · most accurate, full precision, 4.0 GB RAM',
    translationSupport: true,
  },
  // Large V3 Turbo (extended variants - curated turbo-q5_0 is above)
  {
    id: 'large-v3-turbo',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo.bin',
    downloadSizeMB: 1500,
    peakRamMB: 1878,
    label: 'Large V3 Turbo',
    description:
      'Whisper model · fast and very accurate, full precision, 1.9 GB RAM',
    translationSupport: false,
  },
  {
    id: 'large-v3-turbo-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo-q8_0.bin',
    downloadSizeMB: 834,
    peakRamMB: 1107,
    label: 'Large V3 Turbo',
    description:
      'Whisper model · fast and very accurate, Q8 quantized, 1.1 GB RAM',
    translationSupport: false,
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

export function formatRamSize(ramMB: number): string {
  if (ramMB >= 1000) return `${(ramMB / 1000).toFixed(1)} GB RAM`
  return `${ramMB} MB RAM`
}

export const CURATED_SPEECH_MODELS = SPEECH_MODELS.filter((m) => m.curated)

export const EXTENDED_WHISPER_MODELS = SPEECH_MODELS.filter(
  (m) => m.engine === 'whisper_cpp' && !m.curated
)
