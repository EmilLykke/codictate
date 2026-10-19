/* eslint-disable @typescript-eslint/no-empty-object-type */
import { RPCSchema } from 'electrobun'
import type { PlatformCapabilities } from './platform'
import type {
  BlockedDictationPlan,
  DictationReadiness,
  TranslateReadiness,
} from './dictation-plan'
import type { SettingsHealAnnouncement } from './settings-heal'
import type { TranscriptExportFormat } from './transcript-export'
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

export type ThemePreference = 'system' | 'light' | 'dark'

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

export type FormatterModelTier = 'fast' | 'quality' | 's1-mini'

export type S1Styling = 'casual' | 'semi-casual' | 'semi-formal' | 'formal'
export type S1Structure = 'prose' | 'lists'

export interface S1FormattingSettings {
  styling: S1Styling
  structure: S1Structure
}

export interface FormattingSettings {
  enabled: boolean
  enabledModes: FormattingEnabledModes
  forceModeId: FormattingModeId | null
  /** Selected Formatting Model: either Qwen tier or S1-mini by Superwhisper. */
  formatterModelTier: FormatterModelTier
  /** Platform supports running the formatter at all (vendored llama-cli present). */
  available: boolean
  /** Per-tier availability: true when that tier's GGUF exists on disk. */
  modelAvailability: Record<FormatterModelTier, boolean>
  /** General S1-mini controls. Matching enabled app presets may refine these per Dictation. */
  s1: S1FormattingSettings
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
  /** Whether the selected formatter model tier is installed and runnable. */
  modelInstalled: boolean
  /** Transcription language ID (e.g. 'da', 'zh-cn', 'auto'). Passed to the formatter for locale hints. */
  transcriptionLanguageId: string
  userDisplayName: string
  formatterModelTier: FormatterModelTier
  s1: S1FormattingSettings
  email: FormattingEmailSettings
  imessage: FormattingImessageSettings
  slack: FormattingSlackSettings
  document: FormattingDocumentSettings
}

export type AppStatus = 'ready' | 'recording' | 'transcribing' | 'streaming'
export type UpdateCheckState =
  'idle' | 'checking' | 'downloading' | 'up-to-date' | 'ready' | 'error'
export type SettingsPane =
  'inputMonitoring' | 'microphone' | 'accessibility' | 'documents'

/** Dev-only: force the main window to a root screen (Vite `import.meta.env.DEV`). */
export type DevAppPreviewRoute = 'permissions' | 'onboarding' | 'ready'

/** Floating recording / activity chip on the desktop (separate transparent window). */
export type RecordingIndicatorMode = 'off' | 'always' | 'when-active'
export type StreamTranscriptionMode = 'vad' | 'live'
export type WindowResizeEdge =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-right'
  | 'bottom-left'

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
  /** Modifier-only: Control + Command on macOS, Ctrl + Win on Windows. */
  | 'control-meta'
  | 'control-meta-space'
  /** Modifier-only: Control + Option on macOS, Ctrl + Alt on Windows. */
  | 'control-option'

/** The Speech Model, Transcription Language and Translate to English that File Transcriptions use. */
export interface FileTranscriptionSettings {
  speechModelId: string
  transcriptionLanguageId: string
  translateToEnglish: boolean
}
export type FileTranscriptionSettingsPatch = Partial<FileTranscriptionSettings>

/** As the Transcribe page is shipped it: computed in the main process, rendered as is. */
export interface FileTranscriptionSettingsState extends FileTranscriptionSettings {
  /** Can Translate to English run with these settings, and the sentence when it cannot. */
  translateReadiness: TranslateReadiness
  /** What the last heal pass changed in these settings. Shown on the Transcribe page. */
  healAnnouncements: SettingsHealAnnouncement[]
}

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
  /** When false, dictation start/stop/cancel sounds are suppressed. */
  soundEffectsEnabled: boolean
  /**
   * Command-Line Control: whether the `codictate` command may start a Dictation or change
   * Codictate's settings. Off until the user turns it on (ADR-0009). File Transcription and
   * reading status never need it.
   */
  commandLineControl: boolean
  /** `auto` = language detection; else a key from `TRANSCRIPTION_LANGUAGE_OPTIONS`. */
  transcriptionLanguageId: string
  /**
   * The selected Speech Model's id. Defaults to `large-v3-turbo-q5_0` (bundled).
   *
   * Not whisper-only, which is why it is not named for whisper: hviske and Parakeet ids live
   * here too, and the Speech Engine that runs it comes from the catalog entry
   * (`getSpeechModel(id).engine`), never from the shape of the id.
   */
  speechModelId: string
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
  /** Whether the Parakeet Core ML model has been prepared and is ready for stream mode. */
  parakeetCoreMlReady: boolean
  /** Stream transcription behavior: VAD utterance commits or low-latency live chunks. */
  streamTranscriptionMode: StreamTranscriptionMode
  /** General user profile name, available to formatting and future personalized behaviors. */
  userDisplayName: string
  formatting: FormattingSettings
  audioDucking: AudioDuckingSettings
  dictionary: DictionarySettings
  history: HistorySettings
  stats: StatsSettings
  themePreference: ThemePreference
  modelAvailability: Record<string, boolean>
  /**
   * What the last heal pass changed behind the user's back: the Speech Model selection,
   * Translate to English, Live Transcription. Empty almost always. The main process decides
   * what to say and the window only renders it.
   */
  healAnnouncements: SettingsHealAnnouncement[]
  /**
   * What can run right now: Translate to English and Live Transcription, each with the
   * sentence to show when it cannot. Decided in the main process from the settings plus the
   * on-disk Speech Models, because the availability half is a filesystem question the window
   * cannot ask. The window renders this and derives nothing from raw availability.
   *
   * Recomputed on every settings push, including the one the heal pass sends after a Speech
   * Model is downloaded or deleted, which is what keeps it live without a refresh.
   */
  dictationReadiness: DictationReadiness
  /**
   * The File Transcription Settings, chosen apart from the Dictation's, with their readiness
   * and heal announcements. Kept runnable by the same heal pass.
   */
  fileTranscription: FileTranscriptionSettingsState
  /**
   * The last Dictation that refused to start, or `null`. Reached only when the world changed
   * behind the app's back - weights deleted in Finder, a failed disk, a cloud-storage
   * eviction - because the settings themselves are kept runnable. Rides this payload so the
   * blocked reason reaches the in-window banner through the channel the heal announcements
   * already use; when no window is open the same sentence goes out as a notification instead.
   *
   * Cleared by the first press that runs.
   */
  blockedDictation: BlockedDictationPlan | null
  /**
   * The last Dictation that started and then produced nothing, or `null`. A crashed Speech
   * Engine, weights that went away between the plan and the spawn, output that was not the
   * UTF-8 it was asked for: the closed reason union lives with the Speech Engine Adapter.
   *
   * Separate from `blockedDictation` because the two are corrected differently - a blocked
   * plan triggers the heal pass, a failed run must not (ADR-0006) - even though they reach
   * the user through the same banner slot and the same notification channel.
   *
   * Cleared by the next press that runs.
   */
  dictationFailure: DictationFailureNotice | null
}

/**
 * A Dictation that failed mid-run, as the window needs it: the finished sentence, and the
 * reason as an opaque key.
 *
 * Structural on purpose. `FailedTranscription`
 * (src/bun/utils/whisper/engines/transcription.ts) satisfies it, so the main process passes
 * the Result it already has and nothing under `src/shared` has to import a Speech Engine
 * type to describe a banner.
 */
export interface DictationFailureNotice {
  reason: string
  /** One finished sentence, shown to the user as written. */
  message: string
}

/**
 * Which of the three dictation notices a dismissal refers to: the heal announcements, the
 * blocked plan or the failed run, the three fields above. Named once because the same set
 * travels through the RPC schema, the window handler, the webview client and the banner, and
 * four hand-written copies of a union are four chances to add a member to three of them.
 */
export type DictationNoticeKind = 'heal' | 'blocked' | 'failed'

export interface PermissionState {
  inputMonitoring: boolean
  microphone: boolean
  accessibility: boolean
  documents: boolean
}

export interface AudioDeviceDetails {
  index: number
  name: string
  id: string | null
}

export interface DeviceInfo {
  devices: Record<string, string>
  deviceDetails?: Record<string, AudioDeviceDetails>
  selectedDevice: number
  selectedDeviceId?: string | null
}

export interface GeneralSettingsPatch {
  shortcutId?: ShortcutId
  shortcutHoldOnlyId?: ShortcutId | null
  debugMode?: boolean
  funModeEnabled?: boolean
  soundEffectsEnabled?: boolean
  commandLineControl?: boolean
  userDisplayName?: string
  onboardingCompleted?: boolean
  recordingIndicatorMode?: RecordingIndicatorMode
  recordingIndicatorPosition?: { x: number; y: number } | null
  themePreference?: ThemePreference
}

export interface TranscriptionSettingsPatch {
  transcriptionLanguageId?: string
  maxRecordingDuration?: number
  speechModelId?: string
  translateToEnglish?: boolean
  translateDefaultLanguageId?: string
  streamMode?: boolean
  streamTranscriptionMode?: StreamTranscriptionMode
}

export interface FormattingSettingsPatch {
  enabled?: boolean
  enabledModes?: Partial<FormattingEnabledModes>
  forceModeId?: FormattingModeId | null
  formatterModelTier?: FormatterModelTier
  s1?: Partial<S1FormattingSettings>
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

/**
 * What a History entry came from. A Dictation, or a File Transcription asked for in
 * Codictate's window (GLOSSARY.md: History). Index files written before File Transcription
 * have no `source`; they are read as `dictation`.
 */
export type HistoryEntrySource = 'dictation' | 'file'

export interface HistoryEntry {
  id: string
  timestamp: number
  transcript: string
  /** Empty when no audio was kept, which is always the case for a File Transcription. */
  audioFilename: string
  /** For a File Transcription, the length of the file's audio. */
  durationMs?: number
  source: HistoryEntrySource
  /** The transcribed file's name, for `source: 'file'`. */
  fileName?: string
  /**
   * The transcribed file's absolute path, for `source: 'file'`. Absent for a file dropped on
   * the window, which was transcribed from a temporary copy.
   */
  filePath?: string
  /** Processing Time, for `source: 'file'`. Absent on entries saved before it was recorded. */
  processingSeconds?: number
  /** The Speech Model that ran it, for `source: 'file'`. */
  speechModelId?: string
  /** The Transcription Language the run was fixed to, `null` when detected. For `source: 'file'`. */
  language?: string | null
  /** Whether the transcript is Translate to English output, for `source: 'file'`. */
  translated?: boolean
  /** Whether a Timed Transcript was kept with it, for `source: 'file'`. */
  hasTimedTranscript?: boolean
}

export interface HistorySettings {
  enabled: boolean
  storagePath: string
  /** Max number of history entries to keep. 0 = unlimited. */
  maxEntries: number
  /** When false, only transcripts are saved (no audio file). */
  saveAudio: boolean
}

export interface HistorySettingsPatch {
  enabled?: boolean
  storagePath?: string
  maxEntries?: number
  saveAudio?: boolean
}

export interface StatsSessionEntry {
  timestamp: number
  rawWordCount: number | null
  outputWordCount: number
  durationMs: number
  engineId: string | null
  formattingUsed: boolean | null
  languageId: string | null
}

export interface StatsSettings {
  enabled: boolean
}

export interface StatsSettingsPatch {
  enabled?: boolean
}

export type StatsRange = 'today' | '7d' | '30d' | '3m' | 'all'

export interface StatsSummary {
  totalOutputWords: number
  averageRawWpm: number
  totalSessions: number
  /** Words in current comparison window (for "all" = this month, otherwise = totalOutputWords). */
  trendCurrentWords: number
  /** Words in previous comparison window (for "all" = last month, otherwise = equivalent prior period). */
  trendPreviousWords: number
  formattingUsagePercent: number
  /** Date key (YYYY-MM-DD) -> total output words for that day. */
  dailyActivity: Record<string, number>
  /** Always lifetime, regardless of range filter. */
  currentStreakDays: number
  longestStreakDays: number
}

/** A page in the main window's sidebar. Shared so the main process can name one in `navigate`. */
export type SidebarTab =
  | 'home'
  | 'transcribe'
  | 'dictionary'
  | 'models'
  | 'formatting'
  | 'history'
  | 'stats'

/** A tab in the Settings modal. Shared so the main process can name one in `navigate`. */
export type SettingsTab =
  | 'general'
  | 'audio'
  | 'shortcuts'
  | 'ui'
  | 'history'
  | 'stats'
  | 'command-line'
  | 'debug'
  | 'fun'

/**
 * Where the main process wants the window to go: a sidebar page, the Settings modal at a
 * tab, or both. An empty request is a no-op.
 */
export interface NavigateRequest {
  tab?: SidebarTab
  settingsTab?: SettingsTab
}

/** A Speech Model download's progress, pushed to the window whoever started it. */
export interface ModelDownloadProgress {
  modelId: string
  progressFraction: number
  done: boolean
  error?: string
  /**
   * The window started this download or joined it. Only then does a finished download
   * select the Speech Model; one only the command line asked for never does.
   */
  requestedByWindow: boolean
}

/**
 * What sits at `~/.local/bin/codictate` on macOS, relative to this app's client.
 *
 * - `installed`: a symlink to this app's client.
 * - `other-codictate`: a symlink to some other Codictate's client (another channel, an old
 *   copy, a dev build). Safe to replace when the user asks.
 * - `foreign`: anything else. Never overwritten.
 * - `not-installed`: nothing there.
 */
export type CommandLineLinkStatus =
  'installed' | 'other-codictate' | 'foreign' | 'not-installed'

/** How to put the `codictate` command on the user's PATH, as Settings shows it. */
export type CommandLineInstallState =
  | {
      platform: 'macos'
      /** This app's client, or `null` when the bundle has none (a dev build without it). */
      clientPath: string | null
      /** The symlink location, for display (`~/.local/bin/codictate`). */
      linkPath: string
      link: CommandLineLinkStatus
      /**
       * The app runs from the disk image or a translocated copy, so a link to it would break;
       * install refuses until the app is in Applications.
       */
      mustMoveToApplications: boolean
      /** Where the existing symlink points, when there is one. */
      linkTarget: string | null
      /** `~/.local/bin` on the login shell's PATH; `null` when the shell could not be asked. */
      onPath: boolean | null
      /** The line that puts `~/.local/bin` on PATH for the user's shell, and where it goes. */
      pathSetup: { line: string; where: string }
    }
  | {
      platform: 'windows'
      clientPath: string | null
      /** The directory the installer puts on the user's Path. */
      binDir: string
      /** `binDir` in the user's Path (HKCU); `null` when it could not be read. */
      onPath: boolean | null
    }
  | { platform: 'linux' }

export interface CommandLineInstallResult {
  ok: boolean
  /** One sentence for the user when `ok` is false. */
  message: string | null
  state: CommandLineInstallState
}

/**
 * The File Transcription error codes, as the window shows them. Mirrors
 * `FileTranscriptionErrorCode` in src/bun/file-transcription/types.ts (the command line's
 * contract); the window controller assigns one to the other, so they cannot drift apart.
 */
export type FileTranscriptionFailureCode =
  | 'input_unreadable'
  | 'no_audio'
  | 'model_not_installed'
  | 'unknown_model'
  | 'unknown_language'
  | 'language_not_allowed'
  | 'engine_failed'
  | 'cannot_translate'
  | 'cancelled'
  | 'internal'

/** A File Transcription that is running or waiting, from the window or the command line. */
export interface FileTranscriptionQueueItem {
  id: string
  fileName: string
  /** Who asked. Command-line jobs are shown while they run, never kept. */
  origin: 'window' | 'command-line'
  /** The command line's self-reported caller (`Terminal`, `codiclens`), when there is one. */
  callerName: string | null
  state: 'queued' | 'decoding' | 'transcribing'
  /** 1 means next. `null` for the running job. */
  position: number | null
  /** Epoch milliseconds, `null` while queued. */
  startedAt: number | null
  /** Length of the decoded audio, `null` until decoding has finished. */
  audioSeconds: number | null
}

interface FileTranscriptionOutcomeBase {
  id: string
  /** The name the user knows the file by: a dropped file's own name, not its copy's. */
  fileName: string
  /**
   * Where the transcribed file is on the user's disk. `null` for a file dropped on the
   * window: the page sent its bytes and Codictate transcribed a temporary copy, so there is
   * no folder the user knows it from.
   */
  sourcePath: string | null
  /** Epoch milliseconds. */
  finishedAt: number
}

/** A finished File Transcription asked for in the window. Kept in memory for the session. */
export type FileTranscriptionOutcome =
  | (FileTranscriptionOutcomeBase & {
      status: 'ok'
      /** The Raw Transcript. Empty for silence. */
      text: string
      audioSeconds: number
      speechModelId: string
      savedToHistory: boolean
      /** Processing Time. */
      processingSeconds: number
      /** The Transcription Language the run was fixed to, `null` when detected. */
      language: string | null
      /** Whether `text` is Translate to English output. */
      translated: boolean
      /** Whether the main process holds a Timed Transcript for it. The timings stay there. */
      hasTimedTranscript: boolean
      /** The last Transcript Export of it this session, if any. */
      lastExport: { format: TranscriptExportFormat; path: string } | null
    })
  | (FileTranscriptionOutcomeBase & {
      status: 'failed'
      code: FileTranscriptionFailureCode
      /** The queue's own one-line message, for the codes that need detail. */
      message: string
    })

/** Everything the Transcribe page shows. Newest finished first. */
export interface FileTranscriptionsState {
  active: FileTranscriptionQueueItem[]
  finished: FileTranscriptionOutcome[]
}

/** Which transcript a Transcript Export is of: a session result in the window, or a History entry. */
export type TranscriptExportTarget =
  { kind: 'window'; id: string } | { kind: 'history'; id: string }

/** How a Transcript Export ended, pushed to the window as `transcriptExportFinished`. */
export type TranscriptExportResult =
  | {
      target: TranscriptExportTarget
      status: 'saved'
      format: TranscriptExportFormat
      path: string
    }
  | { target: TranscriptExportTarget; status: 'cancelled' }
  | {
      target: TranscriptExportTarget
      status: 'failed'
      format: TranscriptExportFormat
      /** One finished sentence for the user. */
      message: string
    }

/**
 * A file dropped on the window reaches the main process as its bytes, because neither
 * WKWebView nor WebView2 tells the page where a dropped file is on disk
 * (src/shared/dropped-file-upload.ts, src/bun/window-file-transcriptions/dropped-files.ts).
 * A refusal carries one finished sentence for the user.
 */
export type BeginDroppedFileReply =
  | {
      ok: true
      uploadId: string
      /** Where to `PUT` the bytes; `null` when the main process is not listening. */
      upload: DroppedFileUploadTarget | null
    }
  | { ok: false; message: string }

/**
 * The loopback URL for one upload, and the secret its request must carry
 * (src/bun/window-file-transcriptions/dropped-file-server.ts).
 */
export interface DroppedFileUploadTarget {
  url: string
  token: string
}

/** How many bytes the copy holds so far. A refusal has already ended the upload. */
export type AppendDroppedFileChunkReply =
  { ok: true; received: number } | { ok: false; message: string }

/** `ok` means the copy is queued as a window File Transcription. A refusal ended the upload. */
export type FinishDroppedFileReply =
  { ok: true } | { ok: false; message: string }

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
      /**
       * Dismiss a banner notice for good.
       *
       * The notice lives in the main process, so dismissal has to as well. Keeping it as
       * webview state made it a property of one mounted component: the banner slot renders
       * in two branches of `AppLayout`'s tab ternary, so changing tab remounted it and the
       * dismissal was forgotten.
       */
      dismissDictationNotice: {
        params: { notice: DictationNoticeKind }
        response: boolean
      }
      getHistoryEntries: {
        params: { search?: string }
        response: HistoryEntry[]
      }
      getHistoryAudio: {
        params: { id: string }
        response: string | null
      }
      deleteHistoryEntry: {
        params: { id: string }
        response: boolean
      }
      updateHistorySettings: {
        params: { patch: HistorySettingsPatch }
        response: boolean
      }
      getStats: {
        params: { range?: StatsRange }
        response: StatsSummary
      }
      updateStatsSettings: {
        params: { patch: StatsSettingsPatch }
        response: boolean
      }
      /** Where `codictate` is on PATH, if anywhere. Asks the login shell on macOS. */
      getCommandLineInstall: {
        params: {}
        response: CommandLineInstallState
      }
      /** macOS: symlink `~/.local/bin/codictate` to this app's client. */
      installCommandLine: {
        params: { replace: boolean }
        response: CommandLineInstallResult
      }
      /** macOS: remove `~/.local/bin/codictate`, only when it points to this app. */
      removeCommandLine: {
        params: {}
        response: CommandLineInstallResult
      }
      /** Windows: append the client's directory to the user's Path. */
      addCommandLineToPath: {
        params: {}
        response: CommandLineInstallResult
      }
      /** The Transcribe page's queue and this session's finished window File Transcriptions. */
      getFileTranscriptions: {
        params: {}
        response: FileTranscriptionsState
      }
      /** Cancel a queued or running File Transcription, from the window or the command line. */
      cancelFileTranscription: {
        params: { id: string }
        response: boolean
      }
      /** Remove a finished File Transcription from the page. History keeps its copy. */
      dismissFileTranscription: {
        params: { id: string }
        response: boolean
      }
      /** Change the File Transcription Settings. `false` when the result would not be runnable. */
      updateFileTranscriptionSettings: {
        params: { patch: FileTranscriptionSettingsPatch }
        response: boolean
      }
      /** Dismiss the File Transcription Settings heal announcements on the Transcribe page. */
      dismissFileTranscriptionNotice: { params: {}; response: boolean }
      /**
       * Start receiving a file dropped on the window: `name` is its own name, `size` its
       * length in bytes. The bytes follow as one HTTP `PUT` to the reply's `upload`, or with
       * `appendDroppedFileChunk` when the page cannot reach it.
       */
      beginDroppedFile: {
        params: { name: string; size: number }
        response: BeginDroppedFileReply
      }
      /**
       * The next piece of a dropped file, base64: the fallback for a page that cannot reach
       * the upload URL. `offset` must be exactly the bytes received so far, so the page sends
       * one chunk at a time and waits for this answer.
       */
      appendDroppedFileChunk: {
        params: { uploadId: string; offset: number; data: string }
        response: AppendDroppedFileChunkReply
      }
      /** Every byte is in: queue the copy as a window File Transcription. */
      finishDroppedFile: {
        params: { uploadId: string }
        response: FinishDroppedFileReply
      }
      /** Stop receiving a dropped file and delete what arrived. `false` when there was none. */
      cancelDroppedFile: {
        params: { uploadId: string }
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
      windowMinimize: {}
      windowToggleMaximize: {}
      windowClose: {}
      windowResizeStart: {
        edge: WindowResizeEdge
        screenX: number
        screenY: number
      }
      windowResizeMove: { screenX: number; screenY: number }
      windowResizeEnd: {}
      copyDebugLog: {}
      downloadWhisperModel: { modelId: string }
      cancelModelDownload: { modelId: string }
      deleteWhisperModel: { modelId: string }
      downloadFormatterModel: { tier: FormatterModelTier }
      cancelFormatterModelDownload: {}
      deleteFormatterModel: { tier: FormatterModelTier }
      openExternalUrl: { url: string }
      openHistoryFolder: {}
      /**
       * Open the native file dialog and transcribe what the user picks. A message, not a
       * request: the dialog stays open as long as the user likes, longer than a request may
       * wait. The result arrives as `fileTranscriptionsChanged`.
       */
      chooseFilesToTranscribe: {}
      /**
       * Ask for a folder in the native folder picker and save the transcript there in
       * `format`, as a new file named after the transcribed file. A message, not a request,
       * for the same reason as `chooseFilesToTranscribe`: the picker must never be awaited
       * inside a request (#156). The result arrives as `transcriptExportFinished`.
       */
      exportTranscript: {
        target: TranscriptExportTarget
        format: TranscriptExportFormat
      }
      /** Show the file the last Transcript Export of `target` wrote, in Finder / Explorer. */
      revealExportedTranscript: { target: TranscriptExportTarget }
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
      /** Switch the sidebar page and/or open the Settings modal at a tab. */
      navigate: NavigateRequest
      updateCheckStatus: { state: UpdateCheckState; message?: string }
      updateModelDownloadProgress: ModelDownloadProgress
      updateModelAvailability: { modelId: string; available: boolean }
      updateFormatterModelProgress: {
        tier: FormatterModelTier
        progressFraction: number
        done: boolean
        error?: string
      }
      historyEntryAdded: {}
      statsUpdated: {}
      /** The File Transcription queue changed, or a window File Transcription finished. */
      fileTranscriptionsChanged: FileTranscriptionsState
      /** A Transcript Export asked for with `exportTranscript` was saved, cancelled or failed. */
      transcriptExportFinished: TranscriptExportResult
    }
  }>
}
