import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserView, BrowserWindow, Utils } from 'electrobun/bun'
import { getPlatform } from './platform'
import type {
  WebviewRPCType,
  AppSettings,
  AppStatus,
  DeviceInfo,
  AudioDuckingSettingsPatch,
  FileTranscriptionOutcome,
  FileTranscriptionsState,
  DictationNoticeKind,
  DictionarySettingsPatch,
  FormattingSettingsPatch,
  GeneralSettingsPatch,
  HistorySettingsPatch,
  ModelDownloadProgress,
  NavigateRequest,
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
import { getPlatformRuntime } from './platform/runtime'
import { setWindowsWindowIcon } from './utils/window/windows-window-icon'
import {
  addCommandLineToUserPath,
  getCommandLineInstallState,
  installCommandLine,
  removeCommandLine,
} from './command-line-install'
import type { AudioDeviceSnapshot } from './utils/audio/devices'
import type { FileTranscriptionQueue } from './file-transcription'
import {
  createWindowFileTranscriptions,
  type WindowFileTranscriptions,
} from './window-file-transcriptions/controller'
import {
  chooseFilesWithNativeDialog,
  chooseFolderWithNativeDialog,
  isDirectory,
  pathExists,
  writeNewTextFile,
} from './window-file-transcriptions/native'
import { mainWindowNavigationRules } from './window-file-transcriptions/paths'
import {
  createDroppedFiles,
  type DroppedFiles,
} from './window-file-transcriptions/dropped-files'
import {
  createDroppedFileServer,
  listenOnLoopback,
} from './window-file-transcriptions/dropped-file-server'
import { createModelOperations, type ModelOperations } from './model-operations'
import { log } from './utils/logger'

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
  /** The File Transcription queue shared with the command line. */
  fileTranscriptions?: FileTranscriptionQueue
}

export interface WindowHandle {
  send: {
    updateStatus: (data: { status: AppStatus }) => void
    updatePermissions: (data: PermissionState) => void
    updateDevice: (data: DeviceInfo) => void
    updateSettings: (data: AppSettings) => void
    openSettingsScreen: () => void
    /** Switch the sidebar page and/or open the Settings modal at a tab. */
    navigate: (data: NavigateRequest) => void
    updateCheckStatus: (data: {
      state: UpdateCheckState
      message?: string
    }) => void
    updateModelDownloadProgress: (data: ModelDownloadProgress) => void
    updateModelAvailability: (data: {
      modelId: string
      available: boolean
    }) => void
    historyEntryAdded: (data: Record<string, never>) => void
    statsUpdated: (data: Record<string, never>) => void
    fileTranscriptionsChanged: (data: FileTranscriptionsState) => void
  }
  hasWindow: () => boolean
  /**
   * Speech Model downloads and removals, shared with the command line: a download either
   * side starts shows on the Models page, and both end in the heal pass.
   */
  models: ModelOperations
  /**
   * Open the native file dialog and queue each chosen file as a window File Transcription.
   * Resolves how many were queued; 0 when the user cancelled.
   */
  chooseAndTranscribeFiles: () => Promise<number>
  /**
   * Stop taking dropped files and delete every temporary copy, synchronously. For quitting,
   * after the File Transcription queue has cancelled its jobs.
   */
  removeDroppedFiles: () => void
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

  /**
   * Downloading or deleting a Speech Model changes what the settings are allowed to say
   * without any settings write happening, so the heal pass runs here too. Both the Translate
   * and the Live Transcription hooks fire unconditionally: the heal may have switched either
   * off, and the tray checkmarks and any running Parakeet stream have to follow.
   */
  async function healAfterAvailabilityChange(): Promise<void> {
    // Availability moving is the one moment an earlier correction can have been undone by
    // the user - they downloaded the Speech Model back - so a pass with nothing left to heal
    // retires the notice here rather than leaving it claiming a switch that no longer holds.
    await deps.appConfig.healRunnableSettings({
      retireSettledAnnouncements: true,
    })
    try {
      rpc.send.updateSettings(deps.appConfig.getSettings())
    } catch {
      // Window may be closed during a long download
    }
    deps.onTranslateChanged?.()
    deps.onStreamModeChanged?.()
  }

  const models = createModelOperations({
    store: modelManager,
    pushProgress: (progress) =>
      sendIfWindowAlive(() => rpc.send.updateModelDownloadProgress(progress)),
    pushAvailability: (data) =>
      sendIfWindowAlive(() => rpc.send.updateModelAvailability(data)),
    onAvailabilityChanged: healAfterAvailabilityChange,
    log: (event, data) => log('model-operations', event, data),
  })

  /** Tell the user about a finished transcript they cannot see: the window is closed. */
  function notifyFinishedWhileClosed(outcome: FileTranscriptionOutcome): void {
    if (hasWindow()) return
    if (outcome.status === 'failed' && outcome.code === 'cancelled') return
    try {
      Utils.showNotification(
        outcome.status === 'ok'
          ? { title: 'Transcript ready', body: outcome.fileName }
          : { title: "Couldn't transcribe", body: outcome.fileName }
      )
    } catch (err) {
      log('file-transcription', 'finished notification failed', {
        err: String(err),
      })
    }
  }

  const windowFiles: WindowFileTranscriptions | null = deps.fileTranscriptions
    ? createWindowFileTranscriptions({
        queue: deps.fileTranscriptions,
        chooseFiles: chooseFilesWithNativeDialog,
        saveToHistory: async (record) => {
          if (!deps.historyManager || !deps.appConfig.getHistoryEnabled()) {
            return false
          }
          await deps.historyManager.saveFileTranscription(record, {
            maxEntries: deps.appConfig.getHistoryMaxEntries(),
          })
          sendIfWindowAlive(() => rpc.send.historyEntryAdded({}))
          return true
        },
        chooseExportFolder: chooseFolderWithNativeDialog,
        lastExportFolder: () => deps.appConfig.getLastTranscriptExportFolder(),
        rememberExportFolder: (folder) =>
          deps.appConfig.setLastTranscriptExportFolder(folder),
        loadHistoryExportSource: async (id) => {
          const history = deps.historyManager
          if (!history) return null
          const source = await history.loadExportSource(id)
          if (source === null) return null
          const entry = (await history.loadEntries()).find((e) => e.id === id)
          return { source, filePath: entry?.filePath ?? null }
        },
        pushExportResult: (result) =>
          sendIfWindowAlive(() => rpc.send.transcriptExportFinished(result)),
        isDirectory,
        pathExists,
        homeFolder: () => homedir(),
        writeNewFile: writeNewTextFile,
        reveal: (path) => Utils.showItemInFolder(path),
        now: () => Date.now(),
        onChange: (state) =>
          sendIfWindowAlive(() => rpc.send.fileTranscriptionsChanged(state)),
        onFinished: notifyFinishedWhileClosed,
        log: (message, data) => log('file-transcription', message, data),
      })
    : null

  // Files dropped on the window arrive as bytes from the page and are queued as temporary
  // copies (window-file-transcriptions/dropped-files.ts). Made at boot, so it sweeps the
  // copies a crash left behind. The bytes come over a loopback-only HTTP upload
  // (dropped-file-server.ts), open only while a dropped file is being received.
  const droppedFiles: DroppedFiles | null = windowFiles
    ? createDroppedFiles({
        parentDir: tmpdir(),
        transcribe: (copy) => windowFiles.transcribeDroppedCopy(copy),
        now: () => Date.now(),
        log: (message, data) => log('file-transcription', message, data),
      })
    : null
  const droppedFileServer = droppedFiles
    ? createDroppedFileServer({
        droppedFiles,
        listen: listenOnLoopback,
        log: (message, data) => log('file-transcription', message, data),
      })
    : null
  const noDroppedFiles = {
    ok: false as const,
    message: "Codictate can't transcribe files right now.",
  }

  const emptyFileTranscriptions: FileTranscriptionsState = {
    active: [],
    finished: [],
  }

  const rpc = BrowserView.defineRPC<WebviewRPCType>({
    handlers: {
      requests: {
        startMicSession: async () => true,
        getPermissions: deps.getPermissions,
        getDevices: async () => {
          const current = deps.getCurrentDeviceSnapshot()
          return deps.appConfig.getDeviceInfo(current.devices, current.details)
        },
        getSettings: async () => deps.appConfig.getSettings(),
        dismissDictationNotice: async ({
          notice,
        }: {
          notice: DictationNoticeKind
        }) => {
          const dismissed =
            notice === 'heal'
              ? deps.appConfig.dismissHealAnnouncements()
              : notice === 'blocked'
                ? deps.appConfig.clearBlockedDictation()
                : deps.appConfig.clearFailedDictation()
          if (!dismissed) return false
          // Pushed back rather than left to the caller's own state, so every mount of the
          // banner slot agrees about what is dismissed.
          try {
            rpc.send.updateSettings(deps.appConfig.getSettings())
          } catch {
            // Window may have been closed between the click and this push
          }
          return true
        },
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
            patch.speechModelId !== undefined ||
            patch.translateToEnglish !== undefined ||
            patch.translateDefaultLanguageId !== undefined ||
            patch.transcriptionLanguageId !== undefined
          ) {
            deps.onTranslateChanged?.()
          }
          if (
            patch.streamMode !== undefined ||
            patch.streamTranscriptionMode !== undefined ||
            patch.speechModelId !== undefined
          ) {
            deps.onStreamModeChanged?.()
          }
          // No warmup call here. Selecting Parakeet starts its preparation, but the
          // trigger lives on `AppConfig`'s runnable-settings observer so that the tray menu
          // and the "download then select" path get it too - see `installParakeetWarmup` in
          // index.ts.
          return true
        },
        setAudioDevice: async ({ index }) => {
          await deps.onAudioDeviceSelected?.(index)
          const current = deps.getCurrentDeviceSnapshot()
          rpc.send.updateDevice(
            deps.appConfig.getDeviceInfo(current.devices, current.details)
          )

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
        getCommandLineInstall: async () => getCommandLineInstallState(),
        installCommandLine: async ({ replace }: { replace: boolean }) =>
          installCommandLine(replace),
        removeCommandLine: async () => removeCommandLine(),
        addCommandLineToPath: async () => addCommandLineToUserPath(),
        setOnboardingIndicatorPreview: async ({ active, mode }) => {
          deps.appConfig.setRecordingIndicatorOnboardingPreview(active, mode)
          deps.onOnboardingIndicatorPreviewChanged?.()
          return true
        },
        getFileTranscriptions: async () =>
          windowFiles?.state() ?? emptyFileTranscriptions,
        cancelFileTranscription: async ({ id }) =>
          windowFiles?.cancel(id) ?? false,
        dismissFileTranscription: async ({ id }) =>
          windowFiles?.dismiss(id) ?? false,
        updateFileTranscriptionSettings: async ({ patch }) => {
          const ok = await deps.appConfig.updateFileTranscriptionSettings(patch)
          // Pushed whether or not it was accepted, so a refused write snaps the page back.
          rpc.send.updateSettings(deps.appConfig.getSettings())
          return ok
        },
        dismissFileTranscriptionNotice: async () => {
          if (!deps.appConfig.dismissFileTranscriptionHealAnnouncements()) {
            return false
          }
          try {
            rpc.send.updateSettings(deps.appConfig.getSettings())
          } catch {
            // Window may have been closed between the click and this push
          }
          return true
        },
        // The page awaits each of these before sending the next chunk. Each answers as soon
        // as its chunk is written: the File Transcription itself runs in the queue.
        beginDroppedFile: async (params) =>
          droppedFileServer?.begin(params) ?? noDroppedFiles,
        appendDroppedFileChunk: async (params) =>
          droppedFiles?.append(params) ?? noDroppedFiles,
        finishDroppedFile: async (params) =>
          droppedFiles?.finish(params) ?? noDroppedFiles,
        cancelDroppedFile: async (params) =>
          droppedFiles?.cancel(params) ?? false,
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
              // Stats count Dictations. A File Transcription is not one.
              const entries = (await deps.historyManager.loadEntries()).filter(
                (entry) => entry.source === 'dictation'
              )
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
          // Joins a download the command line already started for the same weights.
          void models.download(modelId, 'window').result
        },
        cancelModelDownload: ({ modelId }) => {
          models.cancelDownload(modelId)
        },
        deleteWhisperModel: ({ modelId }) => {
          void models.remove(modelId)
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
        chooseFilesToTranscribe: () => {
          void windowFiles?.chooseAndTranscribe()
        },
        // A message, like `chooseFilesToTranscribe`: the folder picker is never awaited
        // inside a request (#156). The result goes back as `transcriptExportFinished`.
        exportTranscript: ({ target, format }) => {
          if (!windowFiles) {
            sendIfWindowAlive(() =>
              rpc.send.transcriptExportFinished({
                target,
                status: 'failed',
                format,
                message: "That transcript isn't here anymore.",
              })
            )
            return
          }
          void windowFiles.exportTranscript(target, format)
        },
        revealExportedTranscript: ({ target }) => {
          windowFiles?.revealExport(target)
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
    // Every navigation away from the app is blocked, as a security measure: the page never
    // navigates on its own. A file dropped on the window does not navigate either; the page
    // cancels the drop and uploads the file's bytes (dropped-files.ts). Set on the webview
    // after creation: Electrobun 1.18 ignores the `navigationRules` constructor option.
    win.webview.setNavigationRules(mainWindowNavigationRules(deps.url))
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
      navigate: (data) => sendIfWindowAlive(() => rpc.send.navigate(data)),
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
      fileTranscriptionsChanged: (data) =>
        sendIfWindowAlive(() => rpc.send.fileTranscriptionsChanged(data)),
    },
    hasWindow,
    models,
    chooseAndTranscribeFiles: async () =>
      (await windowFiles?.chooseAndTranscribe()) ?? 0,
    removeDroppedFiles: () => {
      droppedFileServer?.stop()
      droppedFiles?.removeAll()
    },
    getOrCreateWindow,
  }
}
