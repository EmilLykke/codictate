/* eslint-disable @typescript-eslint/no-empty-object-type */
import { RPCSchema } from 'electrobun'

export type AppStatus = 'ready' | 'recording' | 'transcribing'
export type UpdateCheckState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'up-to-date'
  | 'ready'
  | 'error'
export type SettingsPane =
  | 'inputMonitoring'
  | 'microphone'
  | 'accessibility'
  | 'documents'

export type ShortcutId =
  | 'option-space'
  | 'right-option'
  | 'option-f1'
  | 'option-f2'
  | 'option-enter'

export interface AppSettings {
  shortcutId: ShortcutId
  maxRecordingDuration: number
  debugMode: boolean
  /** `auto` = language detection; else a key from `TRANSCRIPTION_LANGUAGE_OPTIONS`. */
  transcriptionLanguageId: string
  /** ID of the Whisper model to use for transcription. Defaults to `large-v3-turbo-q5_0` (bundled). */
  whisperModelId: string
  /** When true, Whisper translates speech to English using the large-v3-q5_0 model. */
  translateToEnglish: boolean
  /**
   * Default source language applied automatically when translate mode is enabled
   * while auto-detect is active. `null` means the user hasn't set one yet.
   */
  translateDefaultLanguageId: string | null
}

export interface PermissionState {
  inputMonitoring: boolean
  microphone: boolean
  accessibility: boolean
  documents: boolean
}

export interface DeviceInfo {
  devices: Record<string, string>
  selectedDevice: number
}

export type WebviewRPCType = {
  // Messages/requests handled by the Bun (main) process
  bun: RPCSchema<{
    requests: {
      startMicSession: { params: {}; response: boolean }
      getPermissions: { params: {}; response: PermissionState }
      getDevices: { params: {}; response: DeviceInfo }
      getSettings: { params: {}; response: AppSettings }
      getOnboardingState: { params: {}; response: { hasCompleted: boolean } }
      completeOnboarding: { params: {}; response: boolean }
      setSettings: { params: { shortcutId: ShortcutId }; response: boolean }
      setAudioDevice: { params: { index: number }; response: boolean }
      setDebugMode: { params: { enabled: boolean }; response: boolean }
      setTranscriptionLanguage: {
        params: { transcriptionLanguageId: string }
        response: boolean
      }
      setMaxRecordingDuration: {
        params: { maxRecordingDuration: number }
        response: boolean
      }
      setWhisperModel: { params: { modelId: string }; response: boolean }
      setTranslateToEnglish: { params: { enabled: boolean }; response: boolean }
      setTranslateDefaultLanguage: {
        params: { languageId: string | null }
        response: boolean
      }
      requestDocumentsAccess: { params: {}; response: boolean }
    }
    messages: {
      logBun: { msg: string }
      openSystemPreferences: { pane: SettingsPane }
      triggerUpdateCheck: {}
      triggerApplyUpdate: {}
      copyDebugLog: {}
      downloadWhisperModel: { modelId: string }
      cancelModelDownload: { modelId: string }
      deleteWhisperModel: { modelId: string }
    }
  }>
  // Messages/requests handled by the browser (webview)
  webview: RPCSchema<{
    requests: {}
    messages: {
      updatePermissions: PermissionState
      updateStatus: { status: AppStatus }
      updateDevice: DeviceInfo
      updateSettings: AppSettings
      openSettingsScreen: {}
      updateCheckStatus: { state: UpdateCheckState; message?: string }
      updateModelDownloadProgress: {
        modelId: string
        progressFraction: number
        done: boolean
        error?: string
      }
      updateModelAvailability: { modelId: string; available: boolean }
    }
  }>
}
