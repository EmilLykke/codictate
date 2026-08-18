import {
  SPEECH_MODELS,
  coerceTranscriptionLanguageIdForModel,
} from '../../shared/speech-models'
import { AppConfig } from '../AppConfig/AppConfig'
import { modelManager } from './whisper/model-manager'

const PREFIX = 'set-model:'

export function buildModelMenuItems(
  selectedModelId: string
): { type: 'normal'; label: string; action: string; checked?: boolean }[] {
  return SPEECH_MODELS.filter((m) => modelManager.isModelAvailable(m.id)).map(
    (m) => ({
      type: 'normal' as const,
      label: m.label,
      action: `${PREFIX}${m.id}`,
      checked: m.id === selectedModelId,
    })
  )
}

export function handleModelAction(
  action: string,
  appConfig: AppConfig,
  onSuccess?: () => void
) {
  if (!action.startsWith(PREFIX)) return
  const id = action.slice(PREFIX.length)
  void (async () => {
    const nextLang = coerceTranscriptionLanguageIdForModel(
      id,
      appConfig.getTranscriptionLanguageId()
    )
    // Live Transcription is not switched off here: the heal pass inside
    // updateTranscriptionSettings does it, and announces it, for every caller at once.
    const ok = await appConfig.updateTranscriptionSettings({
      speechModelId: id,
      ...(nextLang !== appConfig.getTranscriptionLanguageId()
        ? { transcriptionLanguageId: nextLang }
        : {}),
    })
    if (ok) onSuccess?.()
  })()
}
