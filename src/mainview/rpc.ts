import { Electroview } from 'electrobun/view'
import { QueryClient } from '@tanstack/react-query'
import type {
  WebviewRPCType,
  PermissionState,
  DeviceInfo,
  AppSettings,
  DictionaryCandidate,
  DictionaryEntry,
  FormatterModelTier,
  HistoryEntry,
  HistorySettingsPatch,
  SettingsPane,
  ShortcutId,
  StatsRange,
  StatsSettingsPatch,
  StatsSummary,
  StreamTranscriptionMode,
  ThemePreference,
  UpdateCheckState,
  RecordingIndicatorMode,
  AppStatus,
  WindowResizeEdge,
} from '../shared/types'
import { appEvents } from './app-events'
import { SPEECH_MODELS } from '../shared/speech-models'

export const queryClient = new QueryClient()

// Seed model availability — bundled models are always available.
// Non-bundled entries will be updated by updateModelAvailability messages from the backend.
queryClient.setQueryData(
  ['modelAvailability'],
  Object.fromEntries(SPEECH_MODELS.map((m) => [m.id, m.bundled ?? false]))
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
        if (data.modelAvailability) {
          queryClient.setQueryData(
            ['modelAvailability'],
            (old: Record<string, boolean> | undefined) => ({
              ...old,
              ...data.modelAvailability,
            })
          )
        }
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
      updateFormatterModelProgress: (data: {
        tier: FormatterModelTier
        progressFraction: number
        done: boolean
        error?: string
      }) => {
        appEvents.emit('formatterModelProgress', data)
      },
      historyEntryAdded: () => {
        appEvents.emit('historyEntryAdded')
      },
      statsUpdated: () => {
        queryClient.invalidateQueries({ queryKey: ['stats'] })
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

export function triggerPermissionPrompt(pane: SettingsPane): void {
  rpc.send.triggerPermissionPrompt({ pane })
}

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
  return rpc.request.updateGeneralSettings({ patch: { shortcutId } })
}

export async function setShortcutHoldOnly(
  shortcutHoldOnlyId: ShortcutId | null
): Promise<boolean> {
  return rpc.request.updateGeneralSettings({ patch: { shortcutHoldOnlyId } })
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

export function windowMinimize(): void {
  rpc.send.windowMinimize({})
}

export function windowToggleMaximize(): void {
  rpc.send.windowToggleMaximize({})
}

export function windowClose(): void {
  rpc.send.windowClose({})
}

export function windowResizeStart(params: {
  edge: WindowResizeEdge
  screenX: number
  screenY: number
}): void {
  rpc.send.windowResizeStart(params)
}

export function windowResizeMove(params: {
  screenX: number
  screenY: number
}): void {
  rpc.send.windowResizeMove(params)
}

export function windowResizeEnd(): void {
  rpc.send.windowResizeEnd({})
}

export async function setDebugMode(enabled: boolean): Promise<boolean> {
  return rpc.request.updateGeneralSettings({ patch: { debugMode: enabled } })
}

export async function setFunModeEnabled(enabled: boolean): Promise<boolean> {
  return rpc.request.updateGeneralSettings({
    patch: { funModeEnabled: enabled },
  })
}

export async function setSoundEffectsEnabled(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateGeneralSettings({
    patch: { soundEffectsEnabled: enabled },
  })
}

export async function setTranscriptionLanguage(
  transcriptionLanguageId: string
): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { transcriptionLanguageId },
  })
}

export async function completeOnboarding(): Promise<boolean> {
  return rpc.request.updateGeneralSettings({
    patch: { onboardingCompleted: true },
  })
}

export async function setMaxRecordingDuration(
  maxRecordingDuration: number
): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { maxRecordingDuration },
  })
}

export async function setThemePreference(
  themePreference: ThemePreference
): Promise<boolean> {
  return rpc.request.updateGeneralSettings({ patch: { themePreference } })
}

export async function setRecordingIndicatorMode(
  mode: RecordingIndicatorMode
): Promise<boolean> {
  return rpc.request.updateGeneralSettings({
    patch: { recordingIndicatorMode: mode },
  })
}

export async function setOnboardingIndicatorPreview(params: {
  active: boolean
  mode?: RecordingIndicatorMode
}): Promise<boolean> {
  return rpc.request.setOnboardingIndicatorPreview(params)
}

export function copyDebugLog(): void {
  rpc.send.copyDebugLog({})
}

export async function setWhisperModel(modelId: string): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { whisperModelId: modelId },
  })
}

export async function setTranslateToEnglish(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { translateToEnglish: enabled },
  })
}

export async function setTranslateDefaultLanguage(
  languageId: string
): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { translateDefaultLanguageId: languageId },
  })
}

export async function setStreamMode(enabled: boolean): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { streamMode: enabled },
  })
}

export async function setStreamTranscriptionMode(
  mode: StreamTranscriptionMode
): Promise<boolean> {
  return rpc.request.updateTranscriptionSettings({
    patch: { streamTranscriptionMode: mode },
  })
}

export async function setFormattingEnabled(enabled: boolean): Promise<boolean> {
  return rpc.request.updateFormattingSettings({ patch: { enabled } })
}

export async function setFormattingModeEnabled(
  modeId: keyof AppSettings['formatting']['enabledModes'],
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { enabledModes: { [modeId]: enabled } },
  })
}

export async function setFormattingForceModeId(
  modeId: AppSettings['formatting']['forceModeId']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { forceModeId: modeId },
  })
}

export async function setUserDisplayName(
  userDisplayName: string
): Promise<boolean> {
  return rpc.request.updateGeneralSettings({ patch: { userDisplayName } })
}

export async function setFormattingEmailIncludeSenderName(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { email: { includeSenderName: enabled } },
  })
}

export async function setFormattingEmailGreetingStyle(
  style: AppSettings['formatting']['email']['greetingStyle']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { email: { greetingStyle: style } },
  })
}

export async function setFormattingEmailClosingStyle(
  style: AppSettings['formatting']['email']['closingStyle']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { email: { closingStyle: style } },
  })
}

export async function setFormattingEmailCustomGreeting(
  text: string
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { email: { customGreeting: text } },
  })
}

export async function setFormattingEmailCustomClosing(
  text: string
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { email: { customClosing: text } },
  })
}

export async function setFormattingImessageTone(
  tone: AppSettings['formatting']['imessage']['tone']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({ patch: { imessage: { tone } } })
}

export async function setFormattingImessageAllowEmoji(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { imessage: { allowEmoji: enabled } },
  })
}

export async function setFormattingImessageLightweight(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { imessage: { lightweight: enabled } },
  })
}

export async function setFormattingSlackTone(
  tone: AppSettings['formatting']['slack']['tone']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({ patch: { slack: { tone } } })
}

export async function setFormattingSlackAllowEmoji(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { slack: { allowEmoji: enabled } },
  })
}

export async function setFormattingSlackUseMarkdown(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { slack: { useMarkdown: enabled } },
  })
}

export async function setFormattingSlackLightweight(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { slack: { lightweight: enabled } },
  })
}

export async function setFormattingDocumentTone(
  tone: AppSettings['formatting']['document']['tone']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { document: { tone } },
  })
}

export async function setFormattingDocumentStructure(
  structure: AppSettings['formatting']['document']['structure']
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { document: { structure } },
  })
}

export async function setFormattingDocumentLightweight(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { document: { lightweight: enabled } },
  })
}

export async function setAudioDuckingLevel(level: number): Promise<boolean> {
  return rpc.request.updateAudioDuckingSettings({ patch: { level } })
}

export async function setAudioDuckingIncludeHeadphones(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateAudioDuckingSettings({
    patch: { includeHeadphones: enabled },
  })
}

export async function setAudioDuckingIncludeBuiltInSpeakers(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateAudioDuckingSettings({
    patch: { includeBuiltInSpeakers: enabled },
  })
}

export async function addDictionaryEntry(params: {
  kind: 'fuzzy' | 'replacement'
  text: string
  from?: string
}): Promise<boolean> {
  const current = queryClient.getQueryData<AppSettings>(['settings'])
  if (!current) return false
  const entries: DictionaryEntry[] = [...current.dictionary.entries]
  entries.push({
    kind: params.kind,
    text: params.text,
    ...(params.from ? { from: params.from } : {}),
    source: 'manual',
  })
  return rpc.request.updateDictionarySettings({ patch: { entries } })
}

export async function removeDictionaryEntry(params: {
  kind: 'fuzzy' | 'replacement'
  text: string
  from?: string
}): Promise<boolean> {
  const current = queryClient.getQueryData<AppSettings>(['settings'])
  if (!current) return false
  const key = `${params.kind}:${(params.from ?? '').trim().toLowerCase()}=>${params.text
    .trim()
    .toLowerCase()}`
  const entries = current.dictionary.entries.filter((entry) => {
    const entryKey = `${entry.kind}:${(entry.from ?? '').trim().toLowerCase()}=>${entry.text
      .trim()
      .toLowerCase()}`
    return entryKey !== key
  })
  return rpc.request.updateDictionarySettings({ patch: { entries } })
}

export async function editDictionaryEntry(
  oldEntry: Pick<DictionaryEntry, 'kind' | 'text' | 'from'>,
  newEntry: { kind: 'fuzzy' | 'replacement'; text: string; from?: string }
): Promise<boolean> {
  const current = queryClient.getQueryData<AppSettings>(['settings'])
  if (!current) return false
  const oldKey = `${oldEntry.kind}:${(oldEntry.from ?? '').trim().toLowerCase()}=>${oldEntry.text
    .trim()
    .toLowerCase()}`
  const entries = current.dictionary.entries.map((entry) => {
    const entryKey = `${entry.kind}:${(entry.from ?? '').trim().toLowerCase()}=>${entry.text
      .trim()
      .toLowerCase()}`
    if (entryKey !== oldKey) return entry
    return {
      ...entry,
      kind: newEntry.kind,
      text: newEntry.text,
      from: newEntry.kind === 'replacement' ? newEntry.from : undefined,
    }
  })
  return rpc.request.updateDictionarySettings({ patch: { entries } })
}

export async function setDictionaryAutoLearn(
  enabled: boolean
): Promise<boolean> {
  return rpc.request.updateDictionarySettings({ patch: { autoLearn: enabled } })
}

export async function removeDictionaryCandidate(
  candidate: Pick<DictionaryCandidate, 'from' | 'to'>
): Promise<boolean> {
  const current = queryClient.getQueryData<AppSettings>(['settings'])
  if (!current) return false
  const from = candidate.from.trim().toLowerCase()
  const to = candidate.to.trim().toLowerCase()
  const candidates = current.dictionary.candidates.filter(
    (entry) =>
      !(
        entry.from.trim().toLowerCase() === from &&
        entry.to.trim().toLowerCase() === to
      )
  )
  return rpc.request.updateDictionarySettings({ patch: { candidates } })
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

export async function setFormatterModelTier(
  tier: FormatterModelTier
): Promise<boolean> {
  return rpc.request.updateFormattingSettings({
    patch: { formatterModelTier: tier },
  })
}

export function downloadFormatterModel(tier: FormatterModelTier): void {
  rpc.send.downloadFormatterModel({ tier })
}

export function cancelFormatterModelDownload(): void {
  rpc.send.cancelFormatterModelDownload({})
}

export function deleteFormatterModel(tier: FormatterModelTier): void {
  rpc.send.deleteFormatterModel({ tier })
}

export function openExternalUrl(url: string): void {
  rpc.send.openExternalUrl({ url })
}

export async function fetchHistoryEntries(
  search?: string
): Promise<HistoryEntry[]> {
  return rpc.request.getHistoryEntries({ search })
}

export async function fetchHistoryAudio(id: string): Promise<string | null> {
  return rpc.request.getHistoryAudio({ id })
}

export async function deleteHistoryEntry(id: string): Promise<boolean> {
  return rpc.request.deleteHistoryEntry({ id })
}

export async function updateHistorySettings(
  patch: HistorySettingsPatch
): Promise<boolean> {
  return rpc.request.updateHistorySettings({ patch })
}

export function openHistoryFolder(): void {
  rpc.send.openHistoryFolder({})
}

export async function fetchStats(range?: StatsRange): Promise<StatsSummary> {
  return rpc.request.getStats({ range })
}

export async function updateStatsSettings(
  patch: StatsSettingsPatch
): Promise<boolean> {
  return rpc.request.updateStatsSettings({ patch })
}
