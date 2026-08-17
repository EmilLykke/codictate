import Electrobun, { ApplicationMenu, BrowserWindow } from 'electrobun/bun'
import { AppConfig } from './AppConfig/AppConfig'
import { getPlatformRuntime } from './platform/runtime'
import type { AudioDeviceDetails } from '../shared/types'
import {
  buildDeviceMenuItems,
  handleDeviceAction,
} from './utils/device-actions'

export const setupApplicationMenu = (
  devices: Record<string, string>,
  deviceDetails: Record<string, AudioDeviceDetails> | undefined,
  appConfig: AppConfig,
  getOrCreateWindow: () => BrowserWindow,
  onDeviceSelected?: (device: number) => void,
  onOpenSettings?: () => void
): {
  rebuildDeviceMenu: (selectedDevice: number) => void
  updateDeviceList: (
    newDevices: Record<string, string>,
    selectedDevice: number,
    newDeviceDetails?: Record<string, AudioDeviceDetails>
  ) => void
} => {
  if (getPlatformRuntime() === 'windows') {
    ApplicationMenu.setApplicationMenu([])
    return {
      rebuildDeviceMenu: () => {},
      updateDeviceList: () => {},
    }
  }

  let currentDevices = devices
  // Carried so the device actions below can resolve a stable device id. Without it
  // handleDeviceAction resolves `deviceId = null` and persists that, wiping the id
  // resolveAudioDevice prefers - the tray path has always passed it.
  let currentDeviceDetails = deviceDetails

  const buildFullMenu = (selectedDevice: number) => [
    {
      submenu: [
        { label: 'Show Window', action: 'show-window' },
        { label: 'Settings', action: 'open-settings' },
        { type: 'separator' as const },
        {
          label: 'Quit Codictate',
          role: 'quit' as const,
          accelerator: 'q',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'pasteAndMatchStyle' as const },
        { role: 'delete' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'Device',
      submenu: [
        {
          label: 'Microphone',
          submenu: buildDeviceMenuItems(currentDevices, selectedDevice),
        },
      ],
    },
  ]

  ApplicationMenu.setApplicationMenu(
    buildFullMenu(
      appConfig.resolveAudioDevice(currentDevices, currentDeviceDetails)
    )
  )

  Electrobun.events.on('application-menu-clicked', (e) => {
    if (e.data.action === 'show-window') {
      getOrCreateWindow().focus()
      return
    }
    if (e.data.action === 'open-settings') {
      onOpenSettings?.()
      return
    }
    handleDeviceAction(
      e.data.action,
      appConfig,
      currentDevices,
      (device) => {
        ApplicationMenu.setApplicationMenu(buildFullMenu(device))
        onDeviceSelected?.(device)
      },
      currentDeviceDetails
    )
  })

  return {
    rebuildDeviceMenu: (selectedDevice: number) =>
      ApplicationMenu.setApplicationMenu(buildFullMenu(selectedDevice)),
    updateDeviceList: (
      newDevices: Record<string, string>,
      selectedDevice: number,
      newDeviceDetails?: Record<string, AudioDeviceDetails>
    ) => {
      currentDevices = newDevices
      if (newDeviceDetails) currentDeviceDetails = newDeviceDetails
      ApplicationMenu.setApplicationMenu(buildFullMenu(selectedDevice))
    },
  }
}
