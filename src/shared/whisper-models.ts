export interface WhisperModel {
  id: string
  filename: string
  sizeMB: number
  label: string
  description: string
  bundled?: boolean
}

export const WHISPER_MODELS: WhisperModel[] = [
  {
    id: 'small-q5_1',
    filename: 'ggml-small-q5_1.bin',
    sizeMB: 181,
    label: 'Small',
    description: 'Good accuracy',
  },
  {
    id: 'large-v3-turbo-q5_0',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    sizeMB: 574,
    label: 'Turbo',
    description: 'Fast & very accurate — default (translate mode uses Large)',
    bundled: true,
  },
  {
    id: 'large-v3-q5_0',
    filename: 'ggml-large-v3-q5_0.bin',
    sizeMB: 1100,
    label: 'Large',
    description: 'Most accurate, best for translation',
  },
]

export const DEFAULT_MODEL_ID = 'large-v3-turbo-q5_0'
export const TRANSLATE_MODEL_ID = 'large-v3-q5_0'

export const WHISPER_MODEL_IDS = WHISPER_MODELS.map((m) => m.id)

export function getWhisperModel(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id)
}

export function isValidWhisperModelId(id: string): boolean {
  return WHISPER_MODEL_IDS.includes(id)
}

export function formatModelSize(sizeMB: number): string {
  if (sizeMB >= 1000) return `${(sizeMB / 1000).toFixed(1)} GB`
  return `${sizeMB} MB`
}

/** Download URL pattern from the whisper.cpp download script. */
export function whisperModelDownloadUrl(filename: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`
}
