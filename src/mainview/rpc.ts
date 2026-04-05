import { Electroview } from 'electrobun/view'
import { QueryClient } from '@tanstack/react-query'
import type {
  WebviewRPCType,
  PermissionState,
  DeviceInfo,
  AppSettings,
  SettingsPane,
  ShortcutId,
  UpdateCheckState,
} from '../shared/types'

import type { AppStatus } from '../shared/types'
import { appEvents } from './app-events'
import { WHISPER_MODELS } from '../shared/whisper-models'

export const queryClient = new QueryClient()

// Seed model availability — bundled models are always available.
// Non-bundled entries will be updated by updateModelAvailability messages from the backend.
queryClient.setQueryData(
  ['modelAvailability'],
  Object.fromEntries(WHISPER_MODELS.map((m) => [m.id, m.bundled ?? false]))
)

// rpc is not exported — the inferred type references an internal electrobun path
// that TypeScript cannot name in declaration files (TS2742). All external access
// goes through the typed helpers below.
const rpc = Electroview.defineRPC<WebviewRPCType>({
  handlers: {
    messages: {
      updatePermissions: (data: PermissionState) => {
        queryClient.setQueryData(['permissions'], data)
        appEvents.emit('permissions', data)
      },
      updateStatus: ({ status }: { status: AppStatus }) =>
        appEvents.emit('status', status),
      updateDevice: (data: DeviceInfo) => {
        queryClient.setQueryData(['devices'], data)
      },
      updateSettings: (data: AppSettings) => {
        queryClient.setQueryData(['settings'], data)
        appEvents.emit('settings', data)
      },
      openSettingsScreen: () => {
        appEvents.emit('openSettingsScreen')
      },
      updateCheckStatus: (data: {
        state: UpdateCheckState
        message?: string
      }) => {
        appEvents.emit('updateCheckStatus', data)
      },
      updateModelDownloadProgress: (data: {
        modelId: string
        progressFraction: number
        done: boolean
        error?: string
      }) => {
        appEvents.emit('modelDownloadProgress', data)
      },
      updateModelAvailability: (data: {
        modelId: string
        available: boolean
      }) => {
        queryClient.setQueryData(
          ['modelAvailability'],
          (old: Record<string, boolean> | undefined) => ({
            ...old,
            [data.modelId]: data.available,
          })
        )
        appEvents.emit('modelAvailability', data)
      },
    },
  },
})

appEvents.on('openSettings', (pane: SettingsPane) => {
  rpc.send.openSystemPreferences({ pane })
})

// Initialize the Electroview bridge here so main.tsx doesn't need to import rpc.
new Electroview({ rpc })

// ─── Typed helpers for consumers ──────────────────────────────────────────────

export async function fetchPermissions(): Promise<PermissionState> {
  return rpc.request.getPermissions({})
}

export async function fetchDevices(): Promise<DeviceInfo> {
  return rpc.request.getDevices({})
}

export async function fetchSettings(): Promise<AppSettings> {
  return rpc.request.getSettings({})
}

export async function setShortcut(shortcutId: ShortcutId): Promise<boolean> {
  return rpc.request.setSettings({ shortcutId })
}

export async function setAudioDevice(index: number): Promise<boolean> {
  return rpc.request.setAudioDevice({ index })
}

export function triggerUpdateCheck(): void {
  rpc.send.triggerUpdateCheck({})
}

export function triggerApplyUpdate(): void {
  rpc.send.triggerApplyUpdate({})
}

export async function setDebugMode(enabled: boolean): Promise<boolean> {
  return rpc.request.setDebugMode({ enabled })
}

export async function setTranscriptionLanguage(
  transcriptionLanguageId: string
): Promise<boolean> {
  return rpc.request.setTranscriptionLanguage({ transcriptionLanguageId })
}

export async function setMaxRecordingDuration(
  maxRecordingDuration: number
): Promise<boolean> {
  return rpc.request.setMaxRecordingDuration({ maxRecordingDuration })
}

export function copyDebugLog(): void {
  rpc.send.copyDebugLog({})
}

export async function setWhisperModel(modelId: string): Promise<boolean> {
  return rpc.request.setWhisperModel({ modelId })
}

export async function setTranslateToEnglish(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.setTranslateToEnglish({ enabled })
}

export async function setTranslateDefaultLanguage(
  languageId: string | null
): Promise<boolean> {
  return rpc.request.setTranslateDefaultLanguage({ languageId })
}

export function downloadWhisperModel(modelId: string): void {
  rpc.send.downloadWhisperModel({ modelId })
}

export function cancelModelDownload(modelId: string): void {
  rpc.send.cancelModelDownload({ modelId })
}

export function deleteWhisperModel(modelId: string): void {
  rpc.send.deleteWhisperModel({ modelId })
}

export async function fetchOnboardingState(): Promise<{
  hasCompleted: boolean
}> {
  return rpc.request.getOnboardingState({})
}

export async function completeOnboarding(): Promise<boolean> {
  return rpc.request.completeOnboarding({})
}

export async function requestDocumentsAccess(): Promise<boolean> {
  return rpc.request.requestDocumentsAccess({})
}
