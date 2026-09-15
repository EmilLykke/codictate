import type { AppSettings, TranscriptionSettingsPatch } from './types'
import { coerceTranscriptionLanguageIdForModel } from './speech-models'

export type SpeechModelSelectionSettings = Pick<
  AppSettings,
  'speechModelId' | 'transcriptionLanguageId' | 'streamMode'
>

/** Build the complete settings change caused by selecting a speech model. */
export function speechModelSelectionPatch(
  current: SpeechModelSelectionSettings,
  speechModelId: string
): TranscriptionSettingsPatch {
  const transcriptionLanguageId = coerceTranscriptionLanguageIdForModel(
    speechModelId,
    current.transcriptionLanguageId
  )

  return {
    speechModelId,
    ...(transcriptionLanguageId !== current.transcriptionLanguageId
      ? { transcriptionLanguageId }
      : {}),
    ...(current.streamMode ? { streamMode: false } : {}),
  }
}
