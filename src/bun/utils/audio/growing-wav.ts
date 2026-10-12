/**
 * Samples from the WAV a recorder is still writing.
 *
 * Neither recorder reports levels to the main process (MicRecorder on macOS, the `record`
 * command of CodictateWindowsHelper on Windows), but both write their 16 kHz mono 16-bit WAV
 * progressively: AVAudioRecorder appends as it records, and hound writes through an 8 KB
 * buffer (a quarter of a second). The header's sizes are only final once the recorder stops,
 * so the data chunk is read up to the end of the file rather than up to its declared size.
 *
 * Used by `--until silence` (see `dictation/end-of-speech.ts`).
 */

import { stat } from 'node:fs/promises'
import { log } from '../logger'

export type WavDataLocation =
  | {
      status: 'ok'
      /** Byte offset of the first sample. */
      dataOffset: number
      sampleRate: number
      channels: number
      bitsPerSample: number
    }
  /** The header has not been written far enough yet. Ask again with more bytes. */
  | { status: 'incomplete' }
  | { status: 'unreadable'; reason: string }

function ascii(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + 4))
}

/**
 * Where the samples start in a WAV whose sizes may still be placeholders. Walks the chunks
 * (AVAudioRecorder puts a `FLLR` padding chunk before `data`) and stops at the `data` header.
 */
export function locateWavData(bytes: Uint8Array): WavDataLocation {
  if (bytes.length < 12) return { status: 'incomplete' }
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') {
    return { status: 'unreadable', reason: 'not a RIFF/WAVE file' }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let format: Omit<
    Extract<WavDataLocation, { status: 'ok' }>,
    'status' | 'dataOffset'
  > | null = null

  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'data') {
      if (format === null) {
        return { status: 'unreadable', reason: 'data chunk before fmt chunk' }
      }
      return { status: 'ok', dataOffset: body, ...format }
    }
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return { status: 'incomplete' }
      const audioFormat = view.getUint16(body, true)
      // 1 is PCM; 0xFFFE is WAVE_FORMAT_EXTENSIBLE, which can still carry 16-bit PCM.
      if (audioFormat !== 1 && audioFormat !== 0xfffe) {
        return { status: 'unreadable', reason: `audio format ${audioFormat}` }
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    }
    offset = body + size + (size % 2)
  }
  return { status: 'incomplete' }
}

export interface GrowingWavWatcher {
  stop(): void
}

export interface GrowingWavOptions {
  path: string
  /** When the recording started. A file older than this is the previous recording. */
  startedAtMs: number
  /** Mono 16-bit samples, in order, as they reach the disk. */
  onSamples(samples: Int16Array, sampleRate: number): void
  intervalMs?: number
}

const HEADER_PROBE_BYTES = 64 * 1024

/**
 * Poll the recording and hand each new run of samples to `onSamples`. Stops by itself when
 * the file cannot be read as 16-bit mono PCM, and logs why: the Dictation then ends the
 * usual ways (Enter, `stop`, the shortcut, the maximum duration).
 */
export function watchGrowingWav(options: GrowingWavOptions): GrowingWavWatcher {
  const intervalMs = options.intervalMs ?? 100
  let stopped = false
  let busy = false
  let inode: number | null = null
  let location: Extract<WavDataLocation, { status: 'ok' }> | null = null
  let readOffset = 0
  let leftover: number | null = null

  const reset = () => {
    location = null
    readOffset = 0
    leftover = null
  }

  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(options.path)
      } catch {
        return // Not created yet.
      }
      // The recorder replaces the previous recording's file; until it has, skip it.
      if (info.mtimeMs < options.startedAtMs - 50) return
      if (inode !== info.ino || info.size < readOffset) {
        inode = info.ino
        reset()
      }

      const file = Bun.file(options.path)
      if (location === null) {
        const header = new Uint8Array(
          await file
            .slice(0, Math.min(info.size, HEADER_PROBE_BYTES))
            .arrayBuffer()
        )
        const found = locateWavData(header)
        if (found.status === 'incomplete') return
        if (
          found.status === 'unreadable' ||
          found.bitsPerSample !== 16 ||
          found.channels !== 1
        ) {
          log('mic', 'cannot follow the recording for --until silence', {
            reason:
              found.status === 'unreadable'
                ? found.reason
                : `${found.bitsPerSample}-bit, ${found.channels} channels`,
          })
          stopped = true
          return
        }
        location = found
        readOffset = found.dataOffset
      }

      if (info.size <= readOffset) return
      const chunk = new Uint8Array(
        await file.slice(readOffset, info.size).arrayBuffer()
      )
      readOffset += chunk.length
      if (stopped) return

      // Samples are two bytes; a write can end between them.
      const bytes =
        leftover === null ? chunk : new Uint8Array([leftover, ...chunk])
      const whole = bytes.length - (bytes.length % 2)
      leftover = whole < bytes.length ? bytes[whole] : null
      if (whole === 0) return
      const samples = new Int16Array(whole / 2)
      const view = new DataView(bytes.buffer, bytes.byteOffset, whole)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true)
      }
      options.onSamples(samples, location.sampleRate)
    } catch (err) {
      log('mic', 'reading the recording for --until silence failed', {
        err: String(err),
      })
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
