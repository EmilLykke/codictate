import { AppConfig } from '../AppConfig/AppConfig'
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../shared/transcription-languages'

const PREFIX = 'transcription-lang:'

export const buildTranscriptionLanguageMenuItems = (
  selectedId: string
): { type: 'normal'; label: string; action: string; checked?: boolean }[] =>
  TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => ({
    type: 'normal' as const,
    label: o.label,
    action: `${PREFIX}${o.id}`,
    checked: o.id === selectedId,
  }))

export function handleTranscriptionLanguageAction(
  action: string,
  appConfig: AppConfig,
  onSuccess?: () => void
) {
  if (!action.startsWith(PREFIX)) return
  const id = action.slice(PREFIX.length)
  void appConfig
    .updateTranscriptionSettings({ transcriptionLanguageId: id })
    .then((ok) => {
      if (ok) onSuccess?.()
    })
}
