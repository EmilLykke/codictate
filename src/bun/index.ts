import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Electrobun, { Updater, Utils } from 'electrobun/bun'
import type { PermissionState, SettingsPane } from '../shared/types'
import { findDevices, type AudioDeviceSnapshot } from './utils/audio/devices'
import { duckDelayAfterStartChimeMs } from './utils/sound/play-sound'
import { checkMicrophoneAuthorization } from './utils/audio/check-mic-authorization'
import { checkNativePermissions } from './utils/keyboard/check-native-permissions'
import { AppConfig } from './AppConfig/AppConfig'
import { setupApplicationMenu } from './setup-menu'
import { setupTray } from './setup-tray'
import { setupRecording } from './setup-recording'
import { setupWindow } from './setup-window'
import {
  setupIndicatorWindow,
  type IndicatorWindowHandle,
} from './setup-indicator-window'
import { setOnAutoDisable, log } from './utils/logger'
import { HistoryManager } from './utils/history/history-manager'
import { StatsManager } from './utils/stats/stats-manager'
import { RECORDING_PATH } from './platform/runtime'
import { modelManager } from './utils/whisper/model-manager'
import { SPEECH_MODELS } from '../shared/speech-models'
import { DEFAULT_STREAM_CAPABLE_MODEL_ID } from '../shared/speech-models'
import { warmupParakeet } from './utils/whisper/speech2text'
import type {
  BlockedDictationPlan,
  DictationPlan,
} from '../shared/dictation-plan'

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

const INPUT_MONITORING_PREFS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'

function checkDocumentsPermission(): boolean {
  try {
    readdirSync(join(homedir(), 'Documents'))
    return true
  } catch {
    return false
  }
}

/** Only touch ~/Documents (TCC) once the user has completed the step before it.
 *  Permission order: Accessibility → Documents → Microphone → Input Monitoring.
 *  So we probe as soon as accessibility is granted (or all native perms are done). */
function shouldProbeDocuments(
  p: Pick<PermissionState, 'inputMonitoring' | 'microphone' | 'accessibility'>
): boolean {
  return p.accessibility
}

function mergeDocumentsField(
  nativeSlice: Pick<
    PermissionState,
    'inputMonitoring' | 'microphone' | 'accessibility'
  >,
  previousDocuments: boolean
): boolean {
  if (shouldProbeDocuments(nativeSlice)) return checkDocumentsPermission()
  return previousDocuments
}

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel()
  if (channel === 'dev') {
    try {
      await fetch(DEV_SERVER_URL, { method: 'HEAD' })
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`)
      return DEV_SERVER_URL
    } catch {
      console.log(
        "Vite dev server not running. Run 'bun run dev:hmr' for HMR support."
      )
    }
  }
  return 'views://mainview/index.html'
}

const url = await getMainViewUrl()

export const UserAppConfig = new AppConfig()
await UserAppConfig.load()

const historyManager = new HistoryManager(() =>
  UserAppConfig.getHistoryStoragePath()
)

const statsManager = new StatsManager(() =>
  UserAppConfig.getHistoryStoragePath()
)

// The boot heal that used to live here - one field-specific check for Translate to English
// and another for Live Transcription - is now `AppConfig.load()`'s own heal pass over the
// whole runnable slice, so there is a single definition of what "runnable" means.

let deviceSnapshot: AudioDeviceSnapshot = await findDevices()
let devices = deviceSnapshot.devices
duckDelayAfterStartChimeMs()

let currentPermissions: PermissionState = {
  inputMonitoring: false,
  microphone: false,
  accessibility: false,
  documents: false,
}

function allPermissionsGranted(p: PermissionState): boolean {
  return p.inputMonitoring && p.microphone && p.accessibility && p.documents
}

// Forward-declared — closures capture by reference, so they'll be
// initialised by the time any callback actually fires.
// eslint-disable-next-line prefer-const
let trayHandlers: ReturnType<typeof setupTray>
// eslint-disable-next-line prefer-const
let menuHandlers: ReturnType<typeof setupApplicationMenu>

const indicatorRef: { current: IndicatorWindowHandle | null } = {
  current: null,
}

const pushInitialState = () => {
  win.send.updateStatus({ status: 'ready' })
  indicatorRef.current?.onAppStatus('ready')
  win.send.updatePermissions(currentPermissions)
  // Push availability for all non-bundled models so the UI knows what's downloaded.
  for (const model of SPEECH_MODELS) {
    if (!model.bundled) {
      win.send.updateModelAvailability({
        modelId: model.id,
        available: modelManager.isModelAvailable(model.id),
      })
    }
  }
  keyboard.checkPermissions()
}

const onApplyUpdate = async () => {
  if (!Updater.updateInfo()?.updateReady) {
    // UI state is stale — re-run the full check so state syncs back up.
    void checkForUpdates()
    return
  }
  try {
    await Updater.applyUpdate()
  } catch (e) {
    console.error('Failed to apply update:', e)
    try {
      win.send.updateCheckStatus({
        state: 'error',
        message: 'Failed to apply update. Please restart the app manually.',
      })
    } catch {
      /* window may be closed */
    }
  }
}

const win = setupWindow({
  url,
  appConfig: UserAppConfig,
  openWindowOnLaunch: true,
  getCurrentDeviceSnapshot: () => deviceSnapshot,
  getPermissions: async () => {
    let accessibility = currentPermissions.accessibility
    let inputMonitoring = currentPermissions.inputMonitoring
    let microphone = currentPermissions.microphone
    try {
      const fresh = await checkNativePermissions()
      accessibility = fresh.accessibility
      inputMonitoring = fresh.inputMonitoring
      microphone = fresh.microphone
    } catch {
      // KeyListener binary unavailable — fall back to mic-only check
      try {
        microphone = await checkMicrophoneAuthorization()
      } catch {
        /* MicRecorder also unavailable — keep previous values */
      }
    }
    const nativeSlice = { accessibility, inputMonitoring, microphone }
    currentPermissions = {
      ...nativeSlice,
      documents: mergeDocumentsField(nativeSlice, currentPermissions.documents),
    }
    if (keyboard.isAlive) keyboard.checkPermissions()
    return currentPermissions
  },
  onSettingsChanged: async () => {
    await keyboard.stopActiveParakeetStream()
    keyboard.stop()
    keyboard = startKeyboard()
    win.send.updateSettings(UserAppConfig.getSettings())
    trayHandlers.refreshTrayShortcutTitle()
  },
  onAudioDeviceSelected: async (index) => {
    const deviceName = devices[index.toString()]
    const deviceId = deviceSnapshot.details[index.toString()]?.id ?? null
    await UserAppConfig.setAudioDevice(index, deviceName, deviceId)
    trayHandlers.rebuildDeviceMenu(index)
    menuHandlers.rebuildDeviceMenu(index)
  },
  onSetDebugMode: async (enabled) => {
    await UserAppConfig.setDebugMode(enabled)
    win.send.updateSettings(UserAppConfig.getSettings())
  },
  onTriggerUpdateCheck: () => checkForUpdates(),
  onApplyUpdate: onApplyUpdate,
  // Re-push app state whenever the window is re-opened after being closed.
  onNewWindowReady: () => pushInitialState(),
  onTranscriptionMenuSync: () => {
    trayHandlers.rebuildDeviceMenu(
      UserAppConfig.resolveAudioDevice(devices, deviceSnapshot.details)
    )
  },
  onTranslateChanged: () => {
    trayHandlers.syncTranslateState()
  },
  onStreamModeChanged: () => {
    if (!UserAppConfig.getStreamMode()) {
      void keyboard.stopActiveParakeetStream()
    }
    trayHandlers.syncStreamModeState()
  },
  onFormattingModeChanged: () => {
    trayHandlers.syncFormattingModeState()
  },
  historyManager,
  statsManager,
  onTriggerPermissionPrompt: (pane: SettingsPane) => {
    if (pane === 'inputMonitoring') {
      if (keyboard.isAlive) {
        keyboard.requestInputMonitoringPrompt()
      }
      Bun.spawn(['open', INPUT_MONITORING_PREFS_URL])
      return
    }
    if (pane === 'documents') {
      if (shouldProbeDocuments(currentPermissions)) {
        currentPermissions = {
          ...currentPermissions,
          documents: checkDocumentsPermission(),
        }
        win.send.updatePermissions(currentPermissions)
      }
      return
    }
    if (!keyboard.isAlive) return
    switch (pane) {
      case 'accessibility':
        keyboard.promptAccessibility()
        break
      case 'microphone':
        keyboard.requestMicrophone()
        break
    }
  },
  onRecordingIndicatorModeChanged: () => {
    indicatorRef.current?.onConfigChanged()
  },
  onOnboardingCompleted: () => {
    indicatorRef.current?.onConfigChanged()
  },
  onOnboardingIndicatorPreviewChanged: () => {
    indicatorRef.current?.onConfigChanged()
  },
})

indicatorRef.current = setupIndicatorWindow({
  getSettings: () => UserAppConfig.getSettings(),
  getRecordingIndicatorPosition: () =>
    UserAppConfig.getRecordingIndicatorPosition(),
  saveRecordingIndicatorPosition: (x, y) =>
    UserAppConfig.setRecordingIndicatorPosition(x, y),
  getOnboardingIndicatorPreviewMode: () =>
    UserAppConfig.getRecordingIndicatorOnboardingPreviewMode(),
})

// When the 5-minute auto-disable fires, sync the state back to AppConfig and
// push the updated settings so the UI toggle turns itself off.
setOnAutoDisable(async () => {
  await UserAppConfig.setDebugMode(false)
  win.send.updateSettings(UserAppConfig.getSettings())
})

const onDeviceSelected = (device: number) => {
  trayHandlers.rebuildDeviceMenu(device)
  menuHandlers.rebuildDeviceMenu(device)
  win.send.updateDevice({
    devices,
    deviceDetails: deviceSnapshot.details,
    selectedDevice: device,
    selectedDeviceId: deviceSnapshot.details[device.toString()]?.id ?? null,
  })
}

function startDeviceMonitor() {
  let snapshot = JSON.stringify(deviceSnapshot)
  setInterval(async () => {
    const newDeviceSnapshot = await findDevices()
    const newSnapshot = JSON.stringify(newDeviceSnapshot)
    if (newSnapshot === snapshot) return
    snapshot = newSnapshot
    deviceSnapshot = newDeviceSnapshot
    devices = newDeviceSnapshot.devices
    const selected = UserAppConfig.resolveAudioDevice(
      newDeviceSnapshot.devices,
      newDeviceSnapshot.details
    )
    trayHandlers.updateDeviceList(
      newDeviceSnapshot.devices,
      selected,
      newDeviceSnapshot.details
    )
    menuHandlers.updateDeviceList(
      newDeviceSnapshot.devices,
      selected,
      newDeviceSnapshot.details
    )
    win.send.updateDevice({
      devices: newDeviceSnapshot.devices,
      deviceDetails: newDeviceSnapshot.details,
      selectedDevice: selected,
      selectedDeviceId: UserAppConfig.resolveAudioDeviceId(
        newDeviceSnapshot.devices,
        newDeviceSnapshot.details
      ),
    })
  }, 5000)
}

const onOpenSettings = () => {
  win.getOrCreateWindow(() => win.send.openSettingsScreen()).focus()
}

Electrobun.events.on('reopen', () => {
  win.getOrCreateWindow().focus()
})

menuHandlers = setupApplicationMenu(
  devices,
  deviceSnapshot.details,
  UserAppConfig,
  () => win.getOrCreateWindow(),
  onDeviceSelected,
  onOpenSettings
)

const pushSettingsToWebview = () =>
  win.send.updateSettings(UserAppConfig.getSettings())

if (
  modelManager.isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID) &&
  !UserAppConfig.isParakeetCoreMlReady()
) {
  void warmupParakeet(async () => {
    await UserAppConfig.markParakeetCoreMlReady()
    pushSettingsToWebview()
    trayHandlers?.syncStreamModeState()
  })
}

trayHandlers = setupTray(
  (onAction) => win.getOrCreateWindow(onAction),
  devices,
  deviceSnapshot.details,
  UserAppConfig,
  () => {
    void (async () => {
      await keyboard.stopActiveParakeetStream()
      keyboard.stop()
      setTimeout(() => Utils.quit(), 150)
    })()
  },
  onDeviceSelected,
  onOpenSettings,
  onApplyUpdate,
  () => checkForUpdates(),
  // onTranscriptionLanguageChanged, onFormattingModeChanged, onModelChanged
  pushSettingsToWebview,
  pushSettingsToWebview,
  pushSettingsToWebview
)

/**
 * A blocked Dictation, on the surface the user is actually looking at.
 *
 * The tray error state and the error chime are handled inside `setupRecording`, which owns
 * both. What is left is the sentence: a native notification when the main window is closed,
 * and the in-window banner when it is open. The banner arrives the way heal announcements
 * already do - `AppSettings.blockedDictation` rides the settings push and `HealNotices`
 * renders it - rather than through a second channel.
 *
 * Then the heal pass, because a blocked plan means the world changed underneath settings that
 * were runnable when they were written. Correcting them here is what makes the next press
 * work, and what stops Settings claiming a deleted Speech Model is still selected.
 */
const reportDictationPlan = async (plan: DictationPlan): Promise<void> => {
  if (plan.status !== 'blocked') {
    // A Dictation ran, so the last blocked notice is stale.
    if (UserAppConfig.clearBlockedDictation()) pushSettingsToWebview()
    return
  }

  UserAppConfig.recordBlockedDictation(plan)
  const windowOpen = win.hasWindow()
  await UserAppConfig.healRunnableSettings()
  pushSettingsToWebview()
  trayHandlers.syncTranslateState()
  trayHandlers.syncStreamModeState()
  if (!windowOpen) notifyBlockedDictation(plan)
}

/**
 * The blocked reason as a native notification, for the closed-window case. Electrobun's
 * notification path is the same call on macOS and Windows; a platform without it must not
 * cost the user their Dictation, so a failure here is logged and nothing else.
 */
function notifyBlockedDictation(plan: BlockedDictationPlan): void {
  try {
    Utils.showNotification({
      title:
        plan.mode === 'live'
          ? 'Live transcription could not start'
          : 'Dictation could not start',
      body: plan.message,
    })
  } catch (err) {
    log('shortcut', 'blocked dictation notification failed', {
      err: String(err),
      reason: plan.reason,
    })
  }
}

let permissionPoll: ReturnType<typeof setInterval> | null = null
let lastKeyboardRespawnMs = 0
const KEYBOARD_RESPAWN_MIN_MS = 30_000

// After the user grants Input Monitoring in System Settings, macOS requires the
// KeyListener process to restart before CGPreflightListenEventAccess() returns true.
// We restart it — but only once all other permissions are done and IM is the sole
// remaining step. Restarting earlier would be pointless (IM hasn't been touched yet)
// and could cause confusion during earlier permission steps.
const IM_TCC_REFRESH_GRACE_MS = 8_000
let imRefreshScheduled = false

const ACCESSIBILITY_TCC_REFRESH_GRACE_MS = 3_000
let accessibilityRefreshScheduled = false

function startKeyboard() {
  return setupRecording(
    UserAppConfig,
    trayHandlers,
    (status) => {
      win.send.updateStatus({ status })
      indicatorRef.current?.onAppStatus(status)
    },
    (nativePermissions) => {
      currentPermissions = {
        ...nativePermissions,
        documents: mergeDocumentsField(
          nativePermissions,
          currentPermissions.documents
        ),
      }
      win.send.updatePermissions(currentPermissions)

      if (allPermissionsGranted(currentPermissions)) {
        if (permissionPoll) {
          clearInterval(permissionPoll)
          permissionPoll = null
        }
        imRefreshScheduled = false
        accessibilityRefreshScheduled = false
        return
      }

      // Only poll for permission changes when something is still outstanding.
      if (!permissionPoll) {
        permissionPoll = setInterval(() => {
          if (allPermissionsGranted(currentPermissions)) {
            clearInterval(permissionPoll!)
            permissionPoll = null
            imRefreshScheduled = false
            accessibilityRefreshScheduled = false
            return
          }

          // Restart KeyListener for accessibility TCC refresh when accessibility
          // is not yet detected. macOS TCC sometimes needs a process restart
          // before AXIsProcessTrusted() reflects a newly granted permission.
          if (
            !currentPermissions.accessibility &&
            !accessibilityRefreshScheduled &&
            keyboard.isAlive
          ) {
            accessibilityRefreshScheduled = true
            setTimeout(() => {
              if (!currentPermissions.accessibility && keyboard.isAlive) {
                void (async () => {
                  await keyboard.stopActiveParakeetStream()
                  keyboard.stop()
                  keyboard = startKeyboard()
                })()
              }
              accessibilityRefreshScheduled = false
            }, ACCESSIBILITY_TCC_REFRESH_GRACE_MS)
            return
          }

          // Restart KeyListener for IM TCC refresh ONLY when IM is the last step.
          // (Accessibility + Documents + Microphone must all be done first.)
          const imIsLastStep =
            currentPermissions.accessibility &&
            currentPermissions.documents &&
            currentPermissions.microphone &&
            !currentPermissions.inputMonitoring

          if (imIsLastStep && !imRefreshScheduled && keyboard.isAlive) {
            imRefreshScheduled = true
            setTimeout(() => {
              if (
                !allPermissionsGranted(currentPermissions) &&
                !currentPermissions.inputMonitoring &&
                keyboard.isAlive
              ) {
                void (async () => {
                  await keyboard.stopActiveParakeetStream()
                  keyboard.stop()
                  keyboard = startKeyboard()
                })()
              }
            }, IM_TCC_REFRESH_GRACE_MS)
            return
          }

          if (keyboard.isAlive) {
            keyboard.checkPermissions()
          } else {
            const now = Date.now()
            if (now - lastKeyboardRespawnMs >= KEYBOARD_RESPAWN_MIN_MS) {
              lastKeyboardRespawnMs = now
              keyboard = startKeyboard()
            }
          }
        }, 3000)
      }
    },
    () => deviceSnapshot,
    () => {
      win.send.updateSettings(UserAppConfig.getSettings())
    },
    async (transcript) => {
      if (!UserAppConfig.getHistoryEnabled()) return
      try {
        await historyManager.saveEntry(RECORDING_PATH, transcript, {
          saveAudio: UserAppConfig.getHistorySaveAudio(),
          maxEntries: UserAppConfig.getHistoryMaxEntries(),
        })
        try {
          win.send.historyEntryAdded({})
        } catch {
          /* window may be closed */
        }
      } catch (err) {
        log('history', 'save failed in pipeline', { err: String(err) })
      }
    },
    // Stats record what ran, from the Dictation Plan. They used to re-read the selected
    // Speech Model and Transcription Language from live config *after* the run, which the
    // user can change mid-transcription - so a stats row could name a Speech Model that had
    // never produced a word of it.
    async (result, durationMs, plan) => {
      if (!UserAppConfig.getStatsEnabled()) return
      const rawWords = result.raw.trim().split(/\s+/)
      const outputWords = result.output.trim().split(/\s+/)
      await statsManager.saveSession({
        timestamp: Date.now(),
        rawWordCount: rawWords[0] === '' ? 0 : rawWords.length,
        outputWordCount: outputWords[0] === '' ? 0 : outputWords.length,
        durationMs,
        engineId: plan.speechModelId,
        formattingUsed: result.formattingUsed,
        languageId: plan.transcriptionLanguageId,
      })
      try {
        win.send.statsUpdated({})
      } catch {
        /* window may be closed */
      }
    },
    reportDictationPlan
  )
}

let keyboard = startKeyboard()

// Push initial app state once the first window's RPC bridge is live.
setTimeout(pushInitialState, 500)

startDeviceMonitor()

Electrobun.events.on('before-quit', () => {
  trayHandlers.setTrayIdle()
  void (async () => {
    await keyboard.stopActiveParakeetStream()
    keyboard.stop()
  })()
  indicatorRef.current?.dispose()
})
process.on('exit', () => keyboard.stop())

async function checkForUpdates() {
  const sendStatus = (
    state: Parameters<typeof win.send.updateCheckStatus>[0]
  ) => {
    try {
      win.send.updateCheckStatus(state)
    } catch {
      /* window may be closed */
    }
  }

  try {
    const channel = await Updater.localInfo.channel()
    if (channel === 'dev') {
      sendStatus({ state: 'up-to-date', message: 'Running in dev mode' })
      return
    }

    trayHandlers.setUpdateChecking()
    sendStatus({ state: 'checking' })

    const updateInfo = await Updater.checkForUpdate()
    if (!updateInfo.updateAvailable) {
      trayHandlers.resetUpdateState()
      sendStatus({ state: 'up-to-date' })
      return
    }

    sendStatus({ state: 'downloading' })
    await Updater.downloadUpdate()

    if (Updater.updateInfo()?.updateReady) {
      trayHandlers.showUpdateReady()
      sendStatus({ state: 'ready' })
    } else {
      trayHandlers.resetUpdateState()
      sendStatus({ state: 'idle' })
    }
  } catch (e) {
    console.error('Update check failed:', e)
    trayHandlers.resetUpdateState()
    sendStatus({
      state: 'error',
      message: 'Could not reach the update server',
    })
  }
}

// First check 10 s after launch, then every 4 hours.
setTimeout(checkForUpdates, 10_000)
setInterval(checkForUpdates, 4 * 60 * 60 * 1_000)

console.log('Codictate started!')
