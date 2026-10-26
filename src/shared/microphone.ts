/**
 * Which Microphone a Dictation records from (GLOSSARY.md, docs/adr/0012).
 *
 * The user's pick when it is connected. Otherwise, for that Dictation only: the built-in
 * microphone, then any connected microphone that is neither Bluetooth nor virtual, then the
 * system default. Bluetooth comes last because recording from it switches the headset into its
 * call profile, which degrades whatever the user is listening to. Virtual devices (BlackHole,
 * aggregate devices) are loopbacks, not microphones.
 *
 * The pick is never overwritten by the fallback, so the moment it reconnects it is used again.
 * Pure: no platform, no subprocess. Both platform helpers report the transport and the system
 * default in `--list-devices`, and this function decides.
 */

/** How a microphone is connected, as the platform helper reports it. */
export type MicrophoneTransport =
  'built-in' | 'bluetooth' | 'usb' | 'virtual' | 'other'

export interface MicrophoneDevice {
  /** The helper's index for this device in the current listing. */
  index: number
  name: string
  /** Stable across reconnects: CoreAudio device UID on macOS, endpoint ID on Windows. */
  id: string | null
  transport: MicrophoneTransport
  /** The system default input. */
  isDefault: boolean
}

/** The user's pick as it is stored. Both null means the user never picked one. */
export interface MicrophonePick {
  id: string | null
  name: string | null
}

export interface MicrophoneChoice {
  device: MicrophoneDevice
  /** The user's pick, rather than a fallback. */
  isPick: boolean
}

export function findPickedMicrophone(
  pick: MicrophonePick,
  devices: readonly MicrophoneDevice[]
): MicrophoneDevice | null {
  if (pick.id !== null) {
    const byId = devices.find((device) => device.id === pick.id)
    if (byId) return byId
  }
  // Configs written before ids were stored on macOS hold only the name.
  if (pick.name !== null) {
    const byName = devices.find((device) => device.name === pick.name)
    if (byName) return byName
  }
  return null
}

/** The Microphone to use when the pick is missing, or `null` with no microphone at all. */
export function fallbackMicrophone(
  devices: readonly MicrophoneDevice[]
): MicrophoneDevice | null {
  return (
    devices.find((device) => device.transport === 'built-in') ??
    devices.find(
      (device) =>
        device.transport !== 'bluetooth' && device.transport !== 'virtual'
    ) ??
    devices.find((device) => device.isDefault) ??
    devices[0] ??
    null
  )
}

export function resolveMicrophone(
  pick: MicrophonePick,
  devices: readonly MicrophoneDevice[]
): MicrophoneChoice | null {
  const picked = findPickedMicrophone(pick, devices)
  if (picked) return { device: picked, isPick: true }
  const fallback = fallbackMicrophone(devices)
  return fallback ? { device: fallback, isPick: false } : null
}

/** How a device should be named to its helper: the stable id when there is one. */
export function microphoneDeviceRef(device: MicrophoneDevice): string {
  return device.id ?? String(device.index)
}
