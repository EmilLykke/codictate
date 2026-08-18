import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPlatform } from '../../platform'
import { getPlatformRuntime } from '../../platform/runtime'

const soundPath = (filename: string) =>
  join(import.meta.dir, `../sounds/${filename}`)

const DICTATION_START_WAV = soundPath('dictation-start.wav')
const FUN_MODE_START_MP3 = soundPath('funmode-dictation-start.mp3')
const DICTATION_STOP_WAV = soundPath('dictation-stop.wav')
const FUN_MODE_STOP_MP3 = soundPath('funmode-dication-end.mp3')
/** Extra ms after measured WAV length before MicRecorder lowers system volume. */
const DUCK_AFTER_CHIME_PAD_MS = 28
const FALLBACK_CHIME_MS = 220
const FUN_MODE_START_CHIME_MS = 432

const cachedDuckDelayMs: { normal: number | null; fun: number | null } = {
  normal: null,
  fun: null,
}

function parseWavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44) return null
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return null
  if (buf.subarray(8, 12).toString('ascii') !== 'WAVE') return null
  let off = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataSize = 0
  while (off + 8 <= buf.length) {
    const chunkId = buf.subarray(off, off + 4).toString('ascii')
    const chunkSize = buf.readUInt32LE(off + 4)
    const dataStart = off + 8
    off += 8 + chunkSize + (chunkSize % 2)
    if (chunkId === 'fmt ') {
      if (dataStart + 18 > buf.length) return null
      channels = buf.readUInt16LE(dataStart + 2)
      sampleRate = buf.readUInt32LE(dataStart + 4)
      bitsPerSample = buf.readUInt16LE(dataStart + 14)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
  }
  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return null
  const bytesPerSample = bitsPerSample / 8
  if (bytesPerSample <= 0 || !Number.isInteger(bytesPerSample)) return null
  const bytesPerFrame = channels * bytesPerSample
  if (!bytesPerFrame) return null
  const frames = dataSize / bytesPerFrame
  if (!Number.isFinite(frames) || frames <= 0) return null
  return (frames / sampleRate) * 1000
}

/**
 * Delay before MicRecorder ducks system output: matches `dictation-start.wav` length + pad.
 * Cached after first read so spawn stays cheap. Does not block recording startup.
 */
export function duckDelayAfterStartChimeMs(funModeEnabled = false): number {
  const cacheKey = funModeEnabled ? 'fun' : 'normal'
  if (cachedDuckDelayMs[cacheKey] !== null) return cachedDuckDelayMs[cacheKey]
  let baseMs = FALLBACK_CHIME_MS
  if (funModeEnabled) {
    baseMs = FUN_MODE_START_CHIME_MS
  } else if (existsSync(DICTATION_START_WAV)) {
    try {
      const ms = parseWavDurationMs(readFileSync(DICTATION_START_WAV))
      if (ms != null && ms > 0 && ms < 30_000) baseMs = Math.ceil(ms)
    } catch {
      // keep fallback
    }
  }
  cachedDuckDelayMs[cacheKey] = Math.min(
    10_000,
    baseMs + DUCK_AFTER_CHIME_PAD_MS
  )
  return cachedDuckDelayMs[cacheKey]!
}

// Fire-and-forget — does not block the caller
export const playStartSound = (funModeEnabled = false) => {
  getPlatform().playSound(
    getPlatformRuntime() === 'macos' && funModeEnabled
      ? FUN_MODE_START_MP3
      : DICTATION_START_WAV
  )
}

export const playEndSound = (funModeEnabled = false) => {
  getPlatform().playSound(
    getPlatformRuntime() === 'macos' && funModeEnabled
      ? FUN_MODE_STOP_MP3
      : DICTATION_STOP_WAV
  )
}

export const playCancelSound = () => {
  getPlatform().playSound(soundPath('dictation-cancel.wav'))
}

/**
 * A Dictation that refused to start.
 *
 * The same chime as a cancelled Dictation, because it is the same message - nothing was
 * recorded - and Codictate ships no separate error asset. The name exists so the blocked
 * path is not calling something named "cancel", and so a dedicated chime is a one-line
 * change here rather than a hunt through the shortcut path. See ADR-0005.
 */
export const playErrorSound = () => {
  getPlatform().playSound(soundPath('dictation-cancel.wav'))
}
