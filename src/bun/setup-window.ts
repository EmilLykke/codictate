import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserView, BrowserWindow } from 'electrobun/bun'
import { getPlatform } from './platform'
import type {
  WebviewRPCType,
  AppSettings,
  AppStatus,
  DeviceInfo,
  AudioDuckingSettingsPatch,
  DictionarySettingsPatch,
  FormattingSettingsPatch,
  GeneralSettingsPatch,
  HistorySettingsPatch,
  PermissionState,
  SettingsPane,
  StatsRange,
  StatsSettingsPatch,
  TranscriptionSettingsPatch,
  UpdateCheckState,
  WindowResizeEdge,
} from '../shared/types'
import type { HistoryManager } from './utils/history/history-manager'
import type { StatsManager } from './utils/stats/stats-manager'
import { AppConfig } from './AppConfig/AppConfig'
import { copyLogToClipboard } from './utils/logger'
import { modelManager } from './utils/whisper/model-manager'
import { formatterModelManager } from './utils/formatting/formatter-model-manager'
import { isTranslateCapableModelId } from '../shared/whisper-models'
import { DEFAULT_STREAM_CAPABLE_MODEL_ID } from '../shared/speech-models'
import { warmupParakeet } from './utils/whisper/speech2text'
import { getPlatformRuntime } from './platform/runtime'
import { setWindowsWindowIcon } from './utils/window/windows-window-icon'
import type { AudioDeviceSnapshot } from './utils/audio/devices'

interface WindowDeps {
  url: string
  appConfig: AppConfig
  openWindowOnLaunch?: boolean
  /** Returns the live device list — called on every request so it's always fresh. */
  getCurrentDeviceSnapshot: () => AudioDeviceSnapshot
  getPermissions: () => Promise<PermissionState>
  onSettingsChanged: () => Promise<void>
  /** Called when the user selects a device from the settings screen. Should persist the choice and update menus. */
  onAudioDeviceSelected?: (index: number) => Promise<void>
  onTriggerUpdateCheck?: () => void
  onApplyUpdate?: () => Promise<void>
  /** Called after a newly re-created window is ready to receive RPC messages. */
  onNewWindowReady?: () => void
  onSetDebugMode?: (enabled: boolean) => Promise<void>
  /** Refresh tray/menu checkmarks after language changes from the webview. */
  onTranscriptionMenuSync?: () => void
  /** Refresh tray checkmark after translate mode changes from the webview. */
  onTranslateChanged?: () => void
  /** Show one native permission prompt for the given privacy pane (sequential onboarding). */
  onTriggerPermissionPrompt?: (pane: SettingsPane) => void
  /** Indicator window should resync when the user changes recording indicator mode in Settings. */
  onRecordingIndicatorModeChanged?: () => void
  /** Indicator is hidden until onboarding completes; refresh when that flips to true. */
  onOnboardingCompleted?: () => void
  /** Indicator preview during onboarding (step 3). */
  onOnboardingIndicatorPreviewChanged?: () => void
  /** Refresh tray and webview after stream mode toggled (from tray or webview). */
  onStreamModeChanged?: () => void
  /** Refresh tray after formatting mode changed from webview. */
  onFormattingModeChanged?: () => void
  historyManager?: HistoryManager
  statsManager?: StatsManager
}

export interface WindowHandle {
  send: {
    updateStatus: (data: { status: AppStatus }) => void
    updatePermissions: (data: PermissionState) => void
    updateDevice: (data: DeviceInfo) => void
    updateSettings: (data: AppSettings) => void
    openSettingsScreen: () => void
    updateCheckStatus: (data: {
      state: UpdateCheckState
      message?: string
    }) => void
    updateModelDownloadProgress: (data: {
      modelId: string
      progressFraction: number
      done: boolean
      error?: string
    }) => void
    updateModelAvailability: (data: {
      modelId: string
      available: boolean
    }) => void
    historyEntryAdded: (data: Record<string, never>) => void
    statsUpdated: (data: Record<string, never>) => void
  }
  hasWindow: () => boolean
  /**
   * Returns (or creates) the main window.
   * `onAction` is invoked once the window is ready to receive messages —
   * immediately if the window already exists, or after a short delay if it
   * was just created (webview needs time to connect the RPC bridge).
   */
  getOrCreateWindow: (onAction?: () => void) => BrowserWindow
}

export function setupWindow(deps: WindowDeps): WindowHandle {
  let resizeSession: {
    edge: WindowResizeEdge
    startX: number
    startY: number
    frame: { x: number; y: number; width: number; height: number }
  } | null = null

  function applyWindowResize(screenX: number, screenY: number) {
    if (!mainWindow || !resizeSession) return
    const dx = screenX - resizeSession.startX
    const dy = screenY - resizeSession.startY
    const minWidth = 720
    const minHeight = 520
    let { x, y, width, height } = resizeSession.frame

    if (resizeSession.edge.includes('right')) {
      width = Math.max(minWidth, resizeSession.frame.width + dx)
    }
    if (resizeSession.edge.includes('bottom')) {
      height = Math.max(minHeight, resizeSession.frame.height + dy)
    }
    if (resizeSession.edge.includes('left')) {
      const nextWidth = Math.max(minWidth, resizeSession.frame.width - dx)
      x = resizeSession.frame.x + (resizeSession.frame.width - nextWidth)
      width = nextWidth
    }
    if (resizeSession.edge.includes('top')) {
      const nextHeight = Math.max(minHeight, resizeSession.frame.height - dy)
      y = resizeSession.frame.y + (resizeSession.frame.height - nextHeight)
      height = nextHeight
    }

    mainWindow.setFrame(
      Math.round(x),
      Math.round(y),
      Math.round(width),
      Math.round(height)
    )
  }

  const rpc = BrowserView.defineRPC<WebviewRPCType>({
    handlers: {
      requests: {
        startMicSession: async () => true,
        getPermissions: deps.getPermissions,
        getDevices: async () => {
          const current = deps.getCurrentDeviceSnapshot()
          return {
            devices: current.devices,
            deviceDetails: current.details,
            selectedDevice: deps.appConfig.resolveAudioDevice(
              current.devices,
              current.details
            ),
            selectedDeviceId: deps.appConfig.resolveAudioDeviceId(
              current.devices,
              current.details
            ),
          }
        },
        getSettings: async () => deps.appConfig.getSettings(),
        updateGeneralSettings: async ({
          patch,
        }: {
          patch: GeneralSettingsPatch
        }) => {
          if (Object.keys(patch).length === 0) {
            return false
          }
          const requiresFullRefresh =
            patch.shortcutId !== undefined ||
            patch.shortcutHoldOnlyId !== undefined
          const ok = await deps.appConfig.updateGeneralSettings(patch)
          if (!ok) return false
          if (requiresFullRefresh) {
            await deps.onSettingsChanged()
          } else {
            rpc.send.updateSettings(deps.appConfig.getSettings())
            if (
              patch.recordingIndicatorMode !== undefined ||
              patch.themePreference !== undefined
            ) {
              deps.onRecordingIndicatorModeChanged?.()
            }
            if (patch.onboardingCompleted) {
              deps.onOnboardingCompleted?.()
            }
          }
          return true
        },
        updateTranscriptionSettings: async ({
          patch,
        }: {
          patch: TranscriptionSettingsPatch
        }) => {
          if (Object.keys(patch).length === 0) return false
          const ok = await deps.appConfig.updateTranscriptionSettings(patch)
          if (!ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
            return false
          }
          rpc.send.updateSettings(deps.appConfig.getSettings())
          if (
            patch.transcriptionLanguageId !== undefined ||
            patch.translateDefaultLanguageId !== undefined
          ) {
            deps.onTranscriptionMenuSync?.()
          }
          if (
            patch.whisperModelId !== undefined ||
            patch.translateToEnglish !== undefined ||
            patch.translateDefaultLanguageId !== undefined ||
            patch.transcriptionLanguageId !== undefined
          ) {
            deps.onTranslateChanged?.()
          }
          if (
            patch.streamMode !== undefined ||
            patch.streamTranscriptionMode !== undefined ||
            patch.whisperModelId !== undefined
          ) {
            deps.onStreamModeChanged?.()
          }
          if (patch.whisperModelId === DEFAULT_STREAM_CAPABLE_MODEL_ID) {
            void warmupParakeet(async () => {
              await deps.appConfig.markParakeetCoreMlReady()
              rpc.send.updateSettings(deps.appConfig.getSettings())
              deps.onStreamModeChanged?.()
            })
          }
          return true
        },
        setAudioDevice: async ({ index }) => {
          await deps.onAudioDeviceSelected?.(index)
          const current = deps.getCurrentDeviceSnapshot()
          rpc.send.updateDevice({
            devices: current.devices,
            deviceDetails: current.details,
            selectedDevice: deps.appConfig.resolveAudioDevice(
              current.devices,
              current.details
            ),
            selectedDeviceId: deps.appConfig.resolveAudioDeviceId(
              current.devices,
              current.details
            ),
          })

          return true
        },
        updateFormattingSettings: async ({
          patch,
        }: {
          patch: FormattingSettingsPatch
        }) => {
          const ok = await deps.appConfig.updateFormattingSettings(patch)
          if (ok) rpc.send.updateSettings(deps.appConfig.getSettings())
          if (
            ok &&
            (patch.enabled !== undefined ||
              patch.forceModeId !== undefined ||
              patch.enabledModes !== undefined)
          ) {
            deps.onFormattingModeChanged?.()
          }
          return ok
        },
        updateAudioDuckingSettings: async ({
          patch,
        }: {
          patch: AudioDuckingSettingsPatch
        }) => {
          const ok = await deps.appConfig.updateAudioDuckingSettings(patch)
          if (ok) rpc.send.updateSettings(deps.appConfig.getSettings())
          return ok
        },
        updateDictionarySettings: async ({
          patch,
        }: {
          patch: DictionarySettingsPatch
        }) => {
          const ok = await deps.appConfig.updateDictionarySettings(patch)
          if (ok) rpc.send.updateSettings(deps.appConfig.getSettings())
          return ok
        },
        setOnboardingIndicatorPreview: async ({ active, mode }) => {
          deps.appConfig.setRecordingIndicatorOnboardingPreview(active, mode)
          deps.onOnboardingIndicatorPreviewChanged?.()
          return true
        },
        getHistoryEntries: async ({ search }) => {
          if (!deps.historyManager) return []
          return deps.historyManager.loadEntries(search)
        },
        getHistoryAudio: async ({ id }) => {
          if (!deps.historyManager) return null
          return deps.historyManager.getAudioBase64(id)
        },
        deleteHistoryEntry: async ({ id }) => {
          if (!deps.historyManager) return false
          return deps.historyManager.deleteEntry(id)
        },
        updateHistorySettings: async ({
          patch,
        }: {
          patch: HistorySettingsPatch
        }) => {
          const ok = await deps.appConfig.updateHistorySettings(patch)
          if (ok) rpc.send.updateSettings(deps.appConfig.getSettings())
          return ok
        },
        getStats: async ({ range }: { range?: StatsRange }) => {
          if (!deps.statsManager)
            return {
              totalOutputWords: 0,
              averageRawWpm: 0,
              totalSessions: 0,
              trendCurrentWords: 0,
              trendPreviousWords: 0,
              formattingUsagePercent: 0,
              dailyActivity: {},
              currentStreakDays: 0,
              longestStreakDays: 0,
            }
          return deps.statsManager.getSummary(range)
        },
        updateStatsSettings: async ({
          patch,
        }: {
          patch: StatsSettingsPatch
        }) => {
          const ok = await deps.appConfig.updateStatsSettings(patch)
          if (ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
            if (
              patch.enabled &&
              deps.statsManager &&
              deps.historyManager &&
              !deps.appConfig.isStatsBackfillDone()
            ) {
              const entries = await deps.historyManager.loadEntries()
              if (entries.length > 0) {
                await deps.statsManager.backfillFromHistory(entries)
              }
              await deps.appConfig.markStatsBackfillDone()
              rpc.send.statsUpdated({})
            }
          }
          return ok
        },
      },
      messages: {
        logBun: ({ msg }) => console.log('Bun Log:', msg),
        openSystemPreferences: ({ pane }) => {
          const url = getPlatform().getPermissionSettingsUrl(pane)
          if (url) getPlatform().openUrl(url)
        },
        triggerPermissionPrompt: ({ pane }) => {
          deps.onTriggerPermissionPrompt?.(pane)
        },
        triggerUpdateCheck: () => deps.onTriggerUpdateCheck?.(),
        triggerApplyUpdate: () => deps.onApplyUpdate?.(),
        windowMinimize: () => {
          mainWindow?.minimize()
        },
        windowToggleMaximize: () => {
          if (!mainWindow) return
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize()
          } else {
            mainWindow.maximize()
          }
        },
        windowClose: () => {
          mainWindow?.close()
        },
        windowResizeStart: ({ edge, screenX, screenY }) => {
          if (!mainWindow || mainWindow.isMaximized()) return
          resizeSession = {
            edge,
            startX: screenX,
            startY: screenY,
            frame: mainWindow.getFrame(),
          }
        },
        windowResizeMove: ({ screenX, screenY }) => {
          applyWindowResize(screenX, screenY)
        },
        windowResizeEnd: () => {
          resizeSession = null
        },
        copyDebugLog: () => {
          copyLogToClipboard().catch(console.error)
        },
        downloadWhisperModel: ({ modelId }) => {
          modelManager
            .downloadModel(modelId, (progressFraction, done, error) => {
              try {
                rpc.send.updateModelDownloadProgress({
                  modelId,
                  progressFraction,
                  done,
                  error,
                })
                if (done && !error) {
                  rpc.send.updateSettings(deps.appConfig.getSettings())
                  if (isTranslateCapableModelId(modelId)) {
                    deps.onTranslateChanged?.()
                  }
                  if (modelId === DEFAULT_STREAM_CAPABLE_MODEL_ID) {
                    void warmupParakeet(async () => {
                      await deps.appConfig.markParakeetCoreMlReady()
                      rpc.send.updateSettings(deps.appConfig.getSettings())
                      deps.onStreamModeChanged?.()
                    })
                  }
                }
              } catch {
                // Window may be closed during a long download
              }
            })
            .catch(console.error)
        },
        cancelModelDownload: ({ modelId }) => {
          modelManager.cancelDownload(modelId)
        },
        deleteWhisperModel: ({ modelId }) => {
          const deleted = modelManager.deleteModel(modelId)
          if (deleted) {
            if (modelId === DEFAULT_STREAM_CAPABLE_MODEL_ID) {
              void deps.appConfig.resetParakeetCoreMlReady()
            }
            rpc.send.updateSettings(deps.appConfig.getSettings())
            if (isTranslateCapableModelId(modelId)) {
              deps.onTranslateChanged?.()
            }
          }
        },
        downloadFormatterModel: ({ tier }) => {
          formatterModelManager
            .download(tier, (progressFraction, done, error) => {
              try {
                rpc.send.updateFormatterModelProgress({
                  tier,
                  progressFraction,
                  done,
                  error,
                })
                if (done && !error) {
                  deps.appConfig.refreshFormatterModelInstalled()
                  rpc.send.updateSettings(deps.appConfig.getSettings())
                }
              } catch {
                // Window may be closed during a long download
              }
            })
            .catch(console.error)
        },
        cancelFormatterModelDownload: () => {
          formatterModelManager.cancel()
        },
        deleteFormatterModel: ({ tier }) => {
          const deleted = formatterModelManager.delete(tier)
          if (deleted) {
            deps.appConfig.refreshFormatterModelInstalled()
            rpc.send.updateSettings(deps.appConfig.getSettings())
          }
        },
        openExternalUrl: ({ url }) => {
          getPlatform().openUrl(url)
        },
        openHistoryFolder: () => {
          const path = join(
            deps.appConfig.getHistoryStoragePath(),
            'recordings'
          )
          mkdirSync(path, { recursive: true })
          getPlatform().openUrl(path)
        },
      },
    },
  })

  function createMainWindow() {
    const titleBarStyle =
      getPlatformRuntime() === 'windows' ? 'hidden' : 'hiddenInset'
    const win = new BrowserWindow({
      title: 'Codictate',
      url: deps.url,
      frame: { width: 1080, height: 700, x: 400, y: 200 },
      titleBarStyle,
      rpc,
    })
    setWindowsWindowIcon(win)
    return win
  }

  let mainWindow: BrowserWindow | null = deps.openWindowOnLaunch
    ? createMainWindow()
    : null

  function hasWindow(): boolean {
    return mainWindow !== null && Boolean(BrowserWindow.getById(mainWindow.id))
  }

  function sendIfWindowAlive<T>(send: () => T): T | undefined {
    if (!hasWindow()) return undefined
    try {
      return send()
    } catch {
      return undefined
    }
  }

  function getOrCreateWindow(onAction?: () => void): BrowserWindow {
    if (mainWindow !== null && BrowserWindow.getById(mainWindow.id)) {
      // Window already exists and its RPC bridge is live.
      onAction?.()
      return mainWindow
    }
    // Window was closed — create a fresh one. The webview takes ~500ms to
    // load and connect the RPC bridge, so we delay both the initial-state
    // push and any caller-specific action until it's ready.
    mainWindow = createMainWindow()
    setTimeout(() => {
      deps.onNewWindowReady?.()
      onAction?.()
    }, 600)
    return mainWindow
  }

  return {
    send: {
      updateStatus: (data) =>
        sendIfWindowAlive(() => rpc.send.updateStatus(data)),
      updatePermissions: (data) =>
        sendIfWindowAlive(() => rpc.send.updatePermissions(data)),
      updateDevice: (data) =>
        sendIfWindowAlive(() => rpc.send.updateDevice(data)),
      updateSettings: (data) =>
        sendIfWindowAlive(() => rpc.send.updateSettings(data)),
      openSettingsScreen: () =>
        sendIfWindowAlive(() => rpc.send.openSettingsScreen({})),
      updateCheckStatus: (data) =>
        sendIfWindowAlive(() => rpc.send.updateCheckStatus(data)),
      updateModelDownloadProgress: (data) =>
        sendIfWindowAlive(() => rpc.send.updateModelDownloadProgress(data)),
      updateModelAvailability: (data) =>
        sendIfWindowAlive(() => rpc.send.updateModelAvailability(data)),
      historyEntryAdded: (data) =>
        sendIfWindowAlive(() => rpc.send.historyEntryAdded(data)),
      statsUpdated: (data) =>
        sendIfWindowAlive(() => rpc.send.statsUpdated(data)),
    },
    hasWindow,
    getOrCreateWindow,
  }
}
