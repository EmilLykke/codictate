/* eslint-disable @typescript-eslint/no-empty-object-type */
import { RPCSchema } from 'electrobun'
import type { PlatformCapabilities } from './platform'
import type {
  FormattingModeId,
  FormattingEmailGreetingStyle,
  FormattingEmailClosingStyle,
  FormattingImessageTone,
  FormattingSlackTone,
  FormattingDocumentTone,
  FormattingDocumentStructure,
} from './formatting-modes'

export type {
  FormattingModeId,
  FormattingEmailGreetingStyle,
  FormattingEmailClosingStyle,
  FormattingImessageTone,
  FormattingSlackTone,
  FormattingDocumentTone,
  FormattingDocumentStructure,
}

export interface FocusedAppContext {
  appName: string
  bundleIdentifier: string | null
  windowTitle: string | null
}

export type FormattingEnabledModes = Record<FormattingModeId, boolean>

export interface FormattingEmailSettings {
  includeSenderName: boolean
  greetingStyle: FormattingEmailGreetingStyle
  closingStyle: FormattingEmailClosingStyle
  customGreeting: string
  customClosing: string
}

export interface FormattingImessageSettings {
  tone: FormattingImessageTone
  allowEmoji: boolean
  lightweight: boolean
}

export interface FormattingSlackSettings {
  tone: FormattingSlackTone
  allowEmoji: boolean
  useMarkdown: boolean
  lightweight: boolean
}

export interface FormattingDocumentSettings {
  tone: FormattingDocumentTone
  structure: FormattingDocumentStructure
  lightweight: boolean
}

export interface FormattingSettings {
  enabled: boolean
  enabledModes: FormattingEnabledModes
  forceModeId: FormattingModeId | null
  available: boolean
  email: FormattingEmailSettings
  imessage: FormattingImessageSettings
  slack: FormattingSlackSettings
  document: FormattingDocumentSettings
}

export interface AudioDuckingSettings {
  /**
   * Duck amount applied to enabled output ducking targets.
   * 0 = fully mute, 100 = no change.
   */
  level: number
  /** When true, ducking also applies with headphones/Bluetooth/USB (default: true). */
  includeHeadphones: boolean
  /**
   * When true, mute built-in Mac speaker output while dictating (MicRecorder and stream helper).
   * Default true.
   */
  includeBuiltInSpeakers: boolean
}

export interface DictionaryEntry {
  kind: 'fuzzy' | 'replacement'
  /** Canonical output text that should appear in the transcript. */
  text: string
  /** Source phrase to replace exactly. Present only for direct replacements. */
  from?: string
  /** 'manual' = user typed it in settings; 'auto' = learned from a post-paste correction */
  source: 'manual' | 'auto'
  /** Confidence score for auto-learned entries. undefined = legacy/manual entry (not subject to auto-removal). */
  confidence?: number
  timesApplied?: number
  timesAccepted?: number
  timesReverted?: number
}

export interface DictionaryCandidate {
  /** Source phrase that may deserve an exact replacement. */
  from: string
  /** Corrected text the user changed it to. */
  to: string
  /** Number of separate observed corrections for this pair. */
  corrections: number
}

export interface DictionarySettings {
  entries: DictionaryEntry[]
  /** When true, the app automatically learns corrections from user edits (requires Accessibility). */
  autoLearn: boolean
  /** Pending exact-replacement candidates that need repeat confirmation before being learned. */
  candidates: DictionaryCandidate[]
}

export interface FormattingRuntimeSettings {
  /** Master switch — when false, runtime never formats. */
  enabled: boolean
  /** Per-format on/off used by app-aware auto-detect. */
  enabledModes: FormattingEnabledModes
  /** Tray-level force override; when non-null, bypasses app detection. */
  forceModeId: FormattingModeId | null
  /** Transcription language ID (e.g. 'da', 'zh-cn', 'auto'). Passed to the formatter for locale hints. */
  transcriptionLanguageId: string
  userDisplayName: string
  email: FormattingEmailSettings
  imessage: FormattingImessageSettings
  slack: FormattingSlackSettings
  document: FormattingDocumentSettings
}

export type AppStatus = 'ready' | 'recording' | 'transcribing' | 'streaming'
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

/** Dev-only: force the main window to a root screen (Vite `import.meta.env.DEV`). */
export type DevAppPreviewRoute = 'permissions' | 'onboarding' | 'ready'

/** Floating recording / activity chip on the desktop (separate transparent window). */
export type RecordingIndicatorMode = 'off' | 'always' | 'when-active'
export type StreamTranscriptionMode = 'vad' | 'live'

export type ShortcutId =
  | 'option-space'
  | 'right-option'
  | 'option-enter'
  | 'fn-space'
  | 'fn-f1'
  | 'fn-f2'
  /** Fn / Globe key alone (hardware varies; may not work on all keyboards). */
  | 'fn-globe'
  | 'control-space'
  | 'control-enter'

export interface AppSettings {
  capabilities: PlatformCapabilities
  /** Tap-or-hold smart shortcut (500ms gate + second press to stop). */
  shortcutId: ShortcutId
  /** Optional push-to-talk only; release always ends recording. Must differ from `shortcutId`. */
  shortcutHoldOnlyId: ShortcutId | null
  maxRecordingDuration: number
  debugMode: boolean
  /** Hidden easter-egg toggle that swaps dictation start/stop sounds. */
  funModeEnabled: boolean
  /** `auto` = language detection; else a key from `TRANSCRIPTION_LANGUAGE_OPTIONS`. */
  transcriptionLanguageId: string
  /** ID of the Whisper model to use for transcription. Defaults to `large-v3-turbo-q5_0` (bundled). */
  whisperModelId: string
  /** When true, Whisper translates speech to English using the selected Small or Large model (not Turbo). */
  translateToEnglish: boolean
  /**
   * Default source language used only by translate mode when the normal
   * transcription language is auto-detect. Always set: `'auto'` = no fixed
   * default yet (translate-from-auto requires a concrete language); else a key
   * from `TRANSCRIPTION_LANGUAGE_OPTIONS`.
   */
  translateDefaultLanguageId: string
  /** First-run product onboarding after permissions; persisted, false until completed. */
  onboardingCompleted: boolean
  /** Desktop activity indicator: off, always visible, or only while recording/transcribing. */
  recordingIndicatorMode: RecordingIndicatorMode
  /**
   * Last top-left position of the floating indicator window (screen coordinates).
   * `null` = use default placement (bottom-right of primary work area).
   */
  recordingIndicatorPosition: { x: number; y: number } | null
  /**
   * When true, use hands-free stream dictation (Parakeet / Core ML). Requires the Parakeet model
   * download; normal shortcut toggles the stream instead of push-to-talk recording.
   */
  streamMode: boolean
  /** Stream transcription behavior: VAD utterance commits or low-latency live chunks. */
  streamTranscriptionMode: StreamTranscriptionMode
  /** General user profile name, available to formatting and future personalized behaviors. */
  userDisplayName: string
  formatting: FormattingSettings
  audioDucking: AudioDuckingSettings
  dictionary: DictionarySettings
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

export interface GeneralSettingsPatch {
  shortcutId?: ShortcutId
  shortcutHoldOnlyId?: ShortcutId | null
  debugMode?: boolean
  funModeEnabled?: boolean
  userDisplayName?: string
  onboardingCompleted?: boolean
  recordingIndicatorMode?: RecordingIndicatorMode
  recordingIndicatorPosition?: { x: number; y: number } | null
}

export interface TranscriptionSettingsPatch {
  transcriptionLanguageId?: string
  maxRecordingDuration?: number
  whisperModelId?: string
  translateToEnglish?: boolean
  translateDefaultLanguageId?: string
  streamMode?: boolean
  streamTranscriptionMode?: StreamTranscriptionMode
}

export interface FormattingSettingsPatch {
  enabled?: boolean
  enabledModes?: Partial<FormattingEnabledModes>
  forceModeId?: FormattingModeId | null
  email?: Partial<FormattingEmailSettings>
  imessage?: Partial<FormattingImessageSettings>
  slack?: Partial<FormattingSlackSettings>
  document?: Partial<FormattingDocumentSettings>
}

export interface DictionarySettingsPatch {
  entries?: DictionaryEntry[]
  autoLearn?: boolean
  candidates?: DictionaryCandidate[]
}

export type AudioDuckingSettingsPatch = Partial<AudioDuckingSettings>

export type WebviewRPCType = {
  bun: RPCSchema<{
    requests: {
      startMicSession: { params: {}; response: boolean }
      getPermissions: { params: {}; response: PermissionState }
      getDevices: { params: {}; response: DeviceInfo }
      getSettings: { params: {}; response: AppSettings }
      updateGeneralSettings: {
        params: { patch: GeneralSettingsPatch }
        response: boolean
      }
      setAudioDevice: { params: { index: number }; response: boolean }
      updateTranscriptionSettings: {
        params: { patch: TranscriptionSettingsPatch }
        response: boolean
      }
      updateFormattingSettings: {
        params: { patch: FormattingSettingsPatch }
        response: boolean
      }
      updateAudioDuckingSettings: {
        params: { patch: AudioDuckingSettingsPatch }
        response: boolean
      }
      updateDictionarySettings: {
        params: { patch: DictionarySettingsPatch }
        response: boolean
      }
      /** Ephemeral: show the floating indicator during onboarding to preview the chosen mode. */
      setOnboardingIndicatorPreview: {
        params: { active: boolean; mode?: RecordingIndicatorMode }
        response: boolean
      }
    }
    messages: {
      logBun: { msg: string }
      openSystemPreferences: { pane: SettingsPane }
      triggerPermissionPrompt: { pane: SettingsPane }
      triggerUpdateCheck: {}
      triggerApplyUpdate: {}
      copyDebugLog: {}
      downloadWhisperModel: { modelId: string }
      cancelModelDownload: { modelId: string }
      deleteWhisperModel: { modelId: string }
    }
  }>
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
