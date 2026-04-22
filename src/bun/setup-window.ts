import { BrowserView, BrowserWindow } from 'electrobun/bun'
import type {
  WebviewRPCType,
  AppSettings,
  AppStatus,
  DeviceInfo,
  AudioDuckingSettingsPatch,
  DictionarySettingsPatch,
  FormattingSettingsPatch,
  GeneralSettingsPatch,
  PermissionState,
  SettingsPane,
  TranscriptionSettingsPatch,
  UpdateCheckState,
} from '../shared/types'
import { AppConfig } from './AppConfig/AppConfig'
import { copyLogToClipboard } from './utils/logger'
import { modelManager } from './utils/whisper/model-manager'
import { isTranslateCapableModelId } from '../shared/whisper-models'
import { getPlatformRuntime } from './platform/runtime'

const SYSTEM_PREFS_URLS: Record<SettingsPane, string> = {
  inputMonitoring:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  documents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
}

interface WindowDeps {
  url: string
  appConfig: AppConfig
  openWindowOnLaunch?: boolean
  /** Returns the live device list — called on every request so it's always fresh. */
  getCurrentDevices: () => Record<string, string>
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
  const rpc = BrowserView.defineRPC<WebviewRPCType>({
    handlers: {
      requests: {
        startMicSession: async () => true,
        getPermissions: deps.getPermissions,
        getDevices: async () => {
          const current = deps.getCurrentDevices()
          return {
            devices: current,
            selectedDevice: deps.appConfig.resolveAudioDevice(current),
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
            if (patch.recordingIndicatorMode !== undefined) {
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
            patch.streamTranscriptionMode !== undefined
          ) {
            deps.onStreamModeChanged?.()
          }
          return true
        },
        setAudioDevice: async ({ index }) => {
          await deps.onAudioDeviceSelected?.(index)
          const current = deps.getCurrentDevices()
          rpc.send.updateDevice({
            devices: current,
            selectedDevice: deps.appConfig.resolveAudioDevice(current),
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
      },
      messages: {
        logBun: ({ msg }) => console.log('Bun Log:', msg),
        openSystemPreferences: ({ pane }) => {
          Bun.spawn(['open', SYSTEM_PREFS_URLS[pane]])
        },
        triggerPermissionPrompt: ({ pane }) => {
          deps.onTriggerPermissionPrompt?.(pane)
        },
        triggerUpdateCheck: () => deps.onTriggerUpdateCheck?.(),
        triggerApplyUpdate: () => deps.onApplyUpdate?.(),
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
                  rpc.send.updateModelAvailability({ modelId, available: true })
                  if (isTranslateCapableModelId(modelId)) {
                    deps.onTranslateChanged?.()
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
            rpc.send.updateModelAvailability({ modelId, available: false })
            if (isTranslateCapableModelId(modelId)) {
              deps.onTranslateChanged?.()
            }
          }
        },
      },
    },
  })

  function createMainWindow() {
    const isWindows = getPlatformRuntime() === 'windows'
    const win = new BrowserWindow({
      title: 'Codictate',
      url: deps.url,
      frame: { width: 900, height: 700, x: 200, y: 200 },
      ...(isWindows ? {} : { titleBarStyle: 'hiddenInset' as const }),
      rpc,
    })
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
    },
    hasWindow,
    getOrCreateWindow,
  }
}
