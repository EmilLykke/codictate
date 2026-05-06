import { findMicRecorderBinary } from './find-mic-recorder'
import type { AudioDeviceDetails } from '../../../shared/types'

export interface AudioDeviceSnapshot {
  devices: Record<string, string>
  details: Record<string, AudioDeviceDetails>
}

const EMPTY_SNAPSHOT: AudioDeviceSnapshot = { devices: {}, details: {} }

function normalizeDeviceSnapshot(parsed: unknown): AudioDeviceSnapshot {
  const devices: Record<string, string> = {}
  const details: Record<string, AudioDeviceDetails> = {}

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return EMPTY_SNAPSHOT
  }

  for (const [key, value] of Object.entries(parsed)) {
    const index = Number(key)
    if (!Number.isInteger(index)) continue

    if (typeof value === 'string') {
      devices[key] = value
      details[key] = { index, name: value, id: null }
      continue
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const device = value as Record<string, unknown>
      const name = typeof device.name === 'string' ? device.name : null
      if (!name) continue
      devices[key] = name
      details[key] = {
        index:
          typeof device.index === 'number' && Number.isInteger(device.index)
            ? device.index
            : index,
        name,
        id:
          typeof device.id === 'string' && device.id.length > 0
            ? device.id
            : null,
      }
    }
  }

  return { devices, details }
}

/** Input device snapshot. Keys are current helper indices; Windows details include stable endpoint IDs. */
export async function findDevices(): Promise<AudioDeviceSnapshot> {
  let micPath: string
  try {
    micPath = await findMicRecorderBinary()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[recording] MicRecorder not found — device list empty. ${msg}`
    )
    return EMPTY_SNAPSHOT
  }

  const proc = Bun.spawn([micPath, '--list-devices'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdoutRaw, stderrText, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ])
  const stdout = stdoutRaw.trim()
  if (exitCode !== 0) {
    console.warn(
      `[recording] MicRecorder --list-devices failed (exit ${exitCode})`,
      stderrText.slice(0, 200) || ''
    )
    return EMPTY_SNAPSHOT
  }

  try {
    const parsed = JSON.parse(stdout) as unknown
    return normalizeDeviceSnapshot(parsed)
  } catch {
    console.warn('[recording] MicRecorder --list-devices returned invalid JSON')
  }
  return EMPTY_SNAPSHOT
}
