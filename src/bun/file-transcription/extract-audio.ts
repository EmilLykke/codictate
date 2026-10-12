/**
 * Any audio or video file, as the 16 kHz mono WAV every Speech Engine accepts.
 *
 * The decoding is the platform's, in the media Native Helper: AVFoundation in
 * `CodictateMediaHelper` (native/CodictateMediaHelper) on macOS, Media Foundation in
 * `CodictateWindowsHelper` on Windows. Both take `extract-audio <input> <output.wav>` and
 * exit with the same codes. crispasr reads only WAV, MP3, FLAC and OGG on its own, and the
 * Parakeet Native Helper reads no video container, so every input is converted, WAV
 * included: both engines get one input shape, and "is this file usable" has one answer.
 */

import { basename } from 'node:path'
import { requireRuntimeBinary } from '../platform/binaries'
import { decodeEngineStderr } from '../utils/whisper/engines/drain-stream'
import { lowerProcessPriority } from '../utils/whisper/engines/process-priority'
import { superviseProcess } from '../utils/whisper/engines/process-supervisor'
import { oneLine } from './plan'

export type DecodeAudioResult =
  | { status: 'ok' }
  | {
      status: 'failed'
      /** `input_unreadable` and `no_audio` are the file's fault; `internal` is this installation's. */
      code: 'input_unreadable' | 'no_audio' | 'internal' | 'cancelled'
      message: string
    }

export interface DecodeAudioOptions {
  signal?: AbortSignal
  /** Run the helper at lowered OS priority, so a Dictation never waits behind it. */
  lowPriority?: boolean
}

/** Decoding is far faster than real time; this only bounds a wedged decoder. */
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * The helper's exit code, read. The codes are documented at the top of
 * native/CodictateMediaHelper/main.swift and shared by the Windows helper: 3 is unreadable
 * media, 4 is no audio track, anything else is this side's fault.
 */
export function extractAudioOutcome(
  exitCode: number,
  stderr: string,
  helperName = 'The media helper'
): DecodeAudioResult {
  if (exitCode === 0) return { status: 'ok' }
  const said = oneLine(stderr)
  if (exitCode === 3) {
    return {
      status: 'failed',
      code: 'input_unreadable',
      message: said || 'not a readable audio or video file',
    }
  }
  if (exitCode === 4) {
    return {
      status: 'failed',
      code: 'no_audio',
      message: said || 'the file has no audio track',
    }
  }
  return {
    status: 'failed',
    code: 'internal',
    message: `${helperName} failed (exit ${exitCode})${said ? `: ${said}` : ''}`,
  }
}

const cancelled: DecodeAudioResult = {
  status: 'failed',
  code: 'cancelled',
  message: 'the File Transcription was cancelled',
}

export async function extractAudioToWav(
  inputPath: string,
  outputPath: string,
  options: DecodeAudioOptions = {}
): Promise<DecodeAudioResult> {
  const { signal, lowPriority = false } = options
  if (signal?.aborted) return cancelled

  let helper: string
  try {
    helper = requireRuntimeBinary('media')
  } catch (err) {
    return {
      status: 'failed',
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const helperName = basename(helper).replace(/\.exe$/i, '')

  const proc = Bun.spawn([helper, 'extract-audio', inputPath, outputPath], {
    stdout: 'ignore',
    stderr: 'pipe',
    signal,
  })
  if (lowPriority) lowerProcessPriority(proc.pid, 'file-transcription')

  const supervised = await superviseProcess(proc, {
    stderr: proc.stderr,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  })
  if (signal?.aborted) return cancelled
  if (supervised.status === 'timed_out') {
    return {
      status: 'failed',
      code: 'internal',
      message: `${helperName} took too long to decode the file`,
    }
  }
  return extractAudioOutcome(
    supervised.exitCode,
    decodeEngineStderr(supervised.stderr),
    helperName
  )
}
