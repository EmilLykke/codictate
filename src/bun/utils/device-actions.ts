import { AppConfig } from '../AppConfig/AppConfig'
import type { AudioDeviceDetails } from '../../shared/types'

export const DEVICE_ACTION_PREFIX = 'select-device-action'

export const buildDeviceMenuItems = (
  devices: Record<string, string>,
  selectedDevice?: number
): { type: 'normal'; label: string; action: string; checked?: boolean }[] =>
  Object.keys(devices).map((deviceKey) => ({
    type: 'normal' as const,
    label: devices[deviceKey],
    action: `${DEVICE_ACTION_PREFIX}-${deviceKey}`,
    checked:
      selectedDevice !== undefined && Number(deviceKey) === selectedDevice,
  }))

export const handleDeviceAction = async (
  action: string,
  appConfig: AppConfig,
  devices: Record<string, string>,
  onSelected?: (device: number) => void,
  deviceDetails?: Record<string, AudioDeviceDetails>
) => {
  if (!action.startsWith(DEVICE_ACTION_PREFIX)) return
  try {
    const indexStr = action.split(`${DEVICE_ACTION_PREFIX}-`)[1]
    const selectedDevice = Number(indexStr)
    const deviceName = devices[indexStr]
    const deviceId = deviceDetails?.[indexStr]?.id ?? null
    await appConfig.setAudioDevice(selectedDevice, deviceName, deviceId)
    onSelected?.(selectedDevice)
    console.log('Selected device:', selectedDevice, deviceName)
  } catch (error) {
    console.error('Error selecting audio device:', error)
  }
}
