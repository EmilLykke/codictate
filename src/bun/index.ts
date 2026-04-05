import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Electrobun, { Updater, Utils } from 'electrobun/bun'
import type { PermissionState } from '../shared/types'
import { findDevices } from './utils/audio/devices'
import { AppConfig } from './AppConfig/AppConfig'
import { setupApplicationMenu } from './setup-menu'
import { setupTray } from './setup-tray'
import { setupRecording } from './setup-recording'
import { setupWindow } from './setup-window'
import { setOnAutoDisable } from './utils/logger'
import { modelManager } from './utils/whisper/model-manager'
import { WHISPER_MODELS, TRANSLATE_MODEL_ID } from '../shared/whisper-models'

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

function checkDocumentsPermission(): boolean {
  try {
    readdirSync(join(homedir(), 'Documents'))
    return true
  } catch {
    return false
  }
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

// Translate mode always runs on the Large model, not the bundled Turbo default.
// Heal disk state if translate was left on without that model or without a resolvable source language.
if (UserAppConfig.getTranslateToEnglish()) {
  const langAuto = UserAppConfig.getTranscriptionLanguageId() === 'auto'
  const noDefault = UserAppConfig.getTranslateDefaultLanguageId() == null
  const translateNotRunnable =
    !modelManager.isModelAvailable(TRANSLATE_MODEL_ID) ||
    (langAuto && noDefault)
  if (translateNotRunnable) {
    await UserAppConfig.setTranslateOff()
  }
}

let devices = await findDevices()

let currentPermissions: PermissionState = {
  inputMonitoring: false,
  microphone: false,
  accessibility: false,
  documents: false,
}

// Only call checkDocumentsPermission() after the user explicitly requests it
// (clicks "Allow" on the Documents row) OR after onboarding is complete on a
// subsequent launch. This prevents the Files & Folders dialog from appearing
// automatically at startup.
let hasTriggeredDocumentsCheck = false
function shouldCheckDocuments(): boolean {
  return hasTriggeredDocumentsCheck || UserAppConfig.getHasCompletedOnboarding()
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

const pushInitialState = () => {
  win.send.updateStatus({ status: 'ready' })
  win.send.updatePermissions(currentPermissions)
  // Push availability for all non-bundled models so the UI knows what's downloaded.
  for (const model of WHISPER_MODELS) {
    if (!model.bundled) {
      win.send.updateModelAvailability({
        modelId: model.id,
        available: modelManager.isModelAvailable(model.id),
      })
    }
  }
  keyboard?.checkPermissions()
}

const onApplyUpdate = async () => {
  if (Updater.updateInfo()?.updateReady) {
    await Updater.applyUpdate()
  }
}

const win = setupWindow({
  url,
  appConfig: UserAppConfig,
  getCurrentDevices: () => devices,
  getPermissions: async () => {
    if (shouldCheckDocuments()) {
      currentPermissions = {
        ...currentPermissions,
        documents: checkDocumentsPermission(),
      }
    }
    if (keyboard?.isAlive) keyboard.checkPermissions()
    return currentPermissions
  },
  onSettingsChanged: async () => {
    keyboard?.stop()
    keyboard = startKeyboard()
    win.send.updateSettings(UserAppConfig.getSettings())
  },
  onAudioDeviceSelected: async (index) => {
    const deviceName = devices[index.toString()]
    await UserAppConfig.setAudioDevice(index, deviceName)
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
    trayHandlers.rebuildDeviceMenu(UserAppConfig.resolveAudioDevice(devices))
  },
  onTranslateChanged: () => {
    trayHandlers.syncTranslateState()
  },
  onRequestDocumentsAccess: () => {
    hasTriggeredDocumentsCheck = true
    currentPermissions = {
      ...currentPermissions,
      documents: checkDocumentsPermission(),
    }
    return currentPermissions
  },
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
  win.send.updateDevice({ devices, selectedDevice: device })
}

function startDeviceMonitor() {
  let snapshot = JSON.stringify(devices)
  setInterval(async () => {
    const newDevices = await findDevices()
    const newSnapshot = JSON.stringify(newDevices)
    if (newSnapshot === snapshot) return
    snapshot = newSnapshot
    devices = newDevices
    const selected = UserAppConfig.resolveAudioDevice(newDevices)
    trayHandlers.updateDeviceList(newDevices, selected)
    menuHandlers.updateDeviceList(newDevices, selected)
    win.send.updateDevice({ devices: newDevices, selectedDevice: selected })
  }, 5000)
}

const onOpenSettings = () => {
  win.getOrCreateWindow(() => win.send.openSettingsScreen()).focus()
}

menuHandlers = setupApplicationMenu(
  devices,
  UserAppConfig,
  () => win.getOrCreateWindow(),
  onDeviceSelected,
  onOpenSettings
)

trayHandlers = setupTray(
  (onAction) => win.getOrCreateWindow(onAction),
  devices,
  UserAppConfig,
  () => {
    keyboard.stop()
    setTimeout(() => Utils.quit(), 150)
  },
  onDeviceSelected,
  onOpenSettings,
  onApplyUpdate,
  () => checkForUpdates(),
  () => win.send.updateSettings(UserAppConfig.getSettings()),
  () => win.send.updateSettings(UserAppConfig.getSettings())
)

let permissionPoll: ReturnType<typeof setInterval> | null = null

function startKeyboard() {
  return setupRecording(
    UserAppConfig,
    trayHandlers,
    (status) => {
      win.send.updateStatus({ status })
    },
    (nativePermissions) => {
      currentPermissions = {
        ...nativePermissions,
        documents: shouldCheckDocuments()
          ? checkDocumentsPermission()
          : currentPermissions.documents,
      }
      win.send.updatePermissions(currentPermissions)

      if (allPermissionsGranted(currentPermissions)) {
        if (permissionPoll) {
          clearInterval(permissionPoll)
          permissionPoll = null
        }
      } else if (!permissionPoll) {
        permissionPoll = setInterval(() => {
          if (keyboard?.isAlive) {
            keyboard?.checkPermissions()
          } else {
            keyboard = startKeyboard()
          }
        }, 3000)
      }
    }
  )
}

// Always start the keyboard listener — on first launch this surfaces the
// Input Monitoring system dialog, which is the intended first step.
let keyboard: ReturnType<typeof startKeyboard> = startKeyboard()

// Push initial app state once the first window's RPC bridge is live.
setTimeout(pushInitialState, 500)

startDeviceMonitor()

Electrobun.events.on('before-quit', () => keyboard?.stop())
process.on('exit', () => keyboard?.stop())

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
