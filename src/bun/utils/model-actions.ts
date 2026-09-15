import { SPEECH_MODELS } from '../../shared/speech-models'
import { speechModelSelectionPatch } from '../../shared/speech-model-selection'
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
    const patch = speechModelSelectionPatch(
      {
        speechModelId: appConfig.getSpeechModelId(),
        transcriptionLanguageId: appConfig.getTranscriptionLanguageId(),
        streamMode: appConfig.getStreamMode(),
      },
      id
    )
    const ok = await appConfig.updateTranscriptionSettings(patch)
    if (ok) onSuccess?.()
  })()
}
