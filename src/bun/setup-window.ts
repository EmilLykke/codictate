import { BrowserView, BrowserWindow } from 'electrobun/bun'
import type {
  WebviewRPCType,
  AppSettings,
  AppStatus,
  DeviceInfo,
  PermissionState,
  SettingsPane,
  ShortcutId,
  UpdateCheckState,
} from '../shared/types'
import { AppConfig } from './AppConfig/AppConfig'
import { copyLogToClipboard } from './utils/logger'
import { modelManager } from './utils/whisper/model-manager'
import { TRANSLATE_MODEL_ID } from '../shared/whisper-models'

/**
 * Always open the Privacy & Security hub (macOS 13+). Legacy
 * `com.apple.preference.security?Privacy_*` deep links often land on an empty
 * or wrong pane in System Settings; every Codictate permission is toggled from
 * this section’s sidebar (Input Monitoring, Microphone, Accessibility, Files
 * & Folders).
 */
const PRIVACY_SECURITY_HUB =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'

const SYSTEM_PREFS_URLS: Record<SettingsPane, string> = {
  inputMonitoring: PRIVACY_SECURITY_HUB,
  microphone: PRIVACY_SECURITY_HUB,
  accessibility: PRIVACY_SECURITY_HUB,
  documents: PRIVACY_SECURITY_HUB,
}

interface WindowDeps {
  url: string
  appConfig: AppConfig
  /** Returns the live device list — called on every request so it's always fresh. */
  getCurrentDevices: () => Record<string, string>
  getPermissions: () => Promise<PermissionState>
  onSettingsChanged: (shortcutId: ShortcutId) => Promise<void>
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
  /**
   * Explicitly trigger the Documents permission check (shown when user clicks
   * "Allow" on the Documents row). Returns the updated full PermissionState so
   * the handler can push it via rpc.
   */
  onRequestDocumentsAccess: () => PermissionState
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
        getOnboardingState: async () => ({
          hasCompleted: deps.appConfig.getHasCompletedOnboarding(),
        }),
        completeOnboarding: async () => {
          await deps.appConfig.setHasCompletedOnboarding()
          return true
        },
        setSettings: async ({ shortcutId }) => {
          await deps.appConfig.setShortcutId(shortcutId)
          await deps.onSettingsChanged(shortcutId)
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
        setDebugMode: async ({ enabled }) => {
          await deps.onSetDebugMode?.(enabled)
          return true
        },
        setTranscriptionLanguage: async ({ transcriptionLanguageId }) => {
          const ok = await deps.appConfig.setTranscriptionLanguageId(
            transcriptionLanguageId
          )
          if (ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
            deps.onTranscriptionMenuSync?.()
          }
          return ok
        },
        setMaxRecordingDuration: async ({ maxRecordingDuration }) => {
          const ok =
            await deps.appConfig.setMaxRecordingDurationSeconds(
              maxRecordingDuration
            )
          if (ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
          }
          return ok
        },
        setWhisperModel: async ({ modelId }) => {
          const ok = await deps.appConfig.setWhisperModelId(modelId)
          if (ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
          }
          return ok
        },
        requestDocumentsAccess: async () => {
          const updated = deps.onRequestDocumentsAccess()
          rpc.send.updatePermissions(updated)
          return updated.documents
        },
        setTranslateDefaultLanguage: async ({ languageId }) => {
          const ok =
            await deps.appConfig.setTranslateDefaultLanguageId(languageId)
          if (ok) {
            rpc.send.updateSettings(deps.appConfig.getSettings())
          }
          return ok
        },
        setTranslateToEnglish: async ({ enabled }) => {
          if (enabled) {
            // Translate mode requires the Large model and a resolvable source language
            // (fixed picker language or default source language in Settings — same as Ready).
            if (!modelManager.isModelAvailable(TRANSLATE_MODEL_ID)) {
              rpc.send.updateSettings(deps.appConfig.getSettings())
              return false
            }
            if (deps.appConfig.getTranscriptionLanguageId() === 'auto') {
              const fallback = deps.appConfig.getTranslateDefaultLanguageId()
              if (!fallback) {
                rpc.send.updateSettings(deps.appConfig.getSettings())
                return false
              }
              const ok =
                await deps.appConfig.setTranscriptionLanguageId(fallback)
              if (!ok) {
                rpc.send.updateSettings(deps.appConfig.getSettings())
                return false
              }
            }
            await deps.appConfig.setTranslateToEnglish(true)
          } else {
            // Atomic: sets translateToEnglish=false and transcriptionLanguageId='auto'
            // in a single save — no window where disk can have stale lang state.
            await deps.appConfig.setTranslateOff()
          }
          rpc.send.updateSettings(deps.appConfig.getSettings())
          deps.onTranslateChanged?.()
          return true
        },
      },
      messages: {
        logBun: ({ msg }) => console.log('Bun Log:', msg),
        openSystemPreferences: ({ pane }) => {
          Bun.spawn(['open', SYSTEM_PREFS_URLS[pane]])
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
                  // If the translate model just became available, rebuild the tray menu.
                  if (modelId === TRANSLATE_MODEL_ID) {
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
            if (modelId === TRANSLATE_MODEL_ID) {
              deps.onTranslateChanged?.()
            }
          }
        },
      },
    },
  })

  function createMainWindow() {
    return new BrowserWindow({
      title: 'Codictate',
      url: deps.url,
      frame: { width: 900, height: 700, x: 200, y: 200 },
      titleBarStyle: 'hiddenInset',
      rpc,
    })
  }

  let mainWindow = createMainWindow()

  function getOrCreateWindow(onAction?: () => void): BrowserWindow {
    if (BrowserWindow.getById(mainWindow.id)) {
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
      updateStatus: (data) => rpc.send.updateStatus(data),
      updatePermissions: (data) => rpc.send.updatePermissions(data),
      updateDevice: (data) => rpc.send.updateDevice(data),
      updateSettings: (data) => rpc.send.updateSettings(data),
      openSettingsScreen: () => rpc.send.openSettingsScreen({}),
      updateCheckStatus: (data) => rpc.send.updateCheckStatus(data),
      updateModelDownloadProgress: (data) =>
        rpc.send.updateModelDownloadProgress(data),
      updateModelAvailability: (data) => rpc.send.updateModelAvailability(data),
    },
    getOrCreateWindow,
  }
}
