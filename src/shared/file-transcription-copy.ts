/**
 * What the Transcribe page says about a File Transcription: the queue line, the finished
 * card's summary, the error in plain words, and how a Transcript Export went. Pure, so
 * every line is tested without a webview.
 */

import type {
  FileTranscriptionFailureCode,
  FileTranscriptionQueueItem,
} from './types'

/** `42` -> `0:42`, `3121.5` -> `52:01`, `4000` -> `1:06:40`. */
export function formatAudioClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Who asked, for a job the window did not start. `null` for the window's own. */
export function queueItemCallerLabel(
  item: Pick<FileTranscriptionQueueItem, 'origin' | 'callerName'>
): string | null {
  if (item.origin === 'window') return null
  const caller = item.callerName?.trim()
  return caller ? `From ${caller}` : 'From the command line'
}

/**
 * The status line under a queued or running file, e.g. `Transcribing · 0:42 · 52:01 of
 * audio`. `nowMs` is the page's clock; `startedAt` comes from the same machine.
 */
export function queueItemStatusLine(
  item: Pick<
    FileTranscriptionQueueItem,
    'state' | 'position' | 'startedAt' | 'audioSeconds'
  >,
  nowMs: number
): string {
  if (item.state === 'queued') {
    const ahead = (item.position ?? 1) - 1
    return ahead <= 0 ? 'Next up' : `Waiting, ${ahead} ahead`
  }
  const parts = [
    item.state === 'decoding' ? 'Reading the file' : 'Transcribing',
  ]
  if (item.startedAt !== null) {
    parts.push(formatAudioClock((nowMs - item.startedAt) / 1000))
  }
  if (item.audioSeconds !== null) {
    parts.push(`${formatAudioClock(item.audioSeconds)} of audio`)
  }
  return parts.join(' · ')
}

export interface FileTranscriptionFailureCopy {
  title: string
  detail: string | null
  /** Where the user can fix it, when there is such a place. */
  action: 'open-models' | null
}

/** A failed File Transcription in plain words. `message` is the queue's own line. */
export function describeFileTranscriptionFailure(
  code: FileTranscriptionFailureCode,
  message: string
): FileTranscriptionFailureCopy {
  switch (code) {
    case 'input_unreadable':
      return {
        title: "Couldn't open this file",
        detail: "It may have moved, or it's not a file Codictate can read.",
        action: null,
      }
    case 'no_audio':
      return {
        title: 'No audio in this file',
        detail: "There's no sound in it to transcribe.",
        action: null,
      }
    case 'model_not_installed':
      return {
        title: "Your speech model isn't downloaded",
        detail: 'Download it on the Models page, then try again.',
        action: 'open-models',
      }
    case 'unknown_model':
    case 'unknown_language':
    case 'language_not_allowed':
      return {
        title: "Your model and language don't work together",
        detail: 'Pick another one on the Models page, then try again.',
        action: 'open-models',
      }
    case 'engine_failed':
      return {
        title: 'Transcription failed',
        detail: message || null,
        action: null,
      }
    case 'cannot_translate':
      // The queue's line says why: the Speech Model, or Auto-detect as the language.
      return {
        title: "Can't translate this file",
        detail: message || null,
        action: null,
      }
    case 'cancelled':
      return { title: 'Cancelled', detail: null, action: null }
    case 'internal':
      return {
        title: 'Something went wrong',
        detail: message || null,
        action: null,
      }
  }
}

/**
 * The finished card's summary, e.g. `4:10 of audio · transcribed in 0:14`. Processing Time
 * is rounded to the second and never shows as `0:00`. `null` (a History entry saved before
 * Processing Time was recorded) leaves it out.
 */
export function resultSummaryLine(
  audioSeconds: number,
  processingSeconds: number | null
): string {
  const audio = `${formatAudioClock(audioSeconds)} of audio`
  if (processingSeconds === null || !Number.isFinite(processingSeconds)) {
    return audio
  }
  const took = formatAudioClock(Math.max(1, Math.round(processingSeconds)))
  return `${audio} · transcribed in ${took}`
}

/** What a saved Transcript Export says, e.g. `Saved as memo.srt.` */
export function transcriptExportSavedLine(path: string): string {
  const name = path.split(/[\\/]/).pop() || path
  return `Saved as ${name}.`
}

/** The folder refused the write: no permission, or a read-only disk. */
const UNWRITABLE_FOLDER_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

/** Why a Transcript Export could not be written, from the file system's error code. */
export function transcriptExportFailureMessage(
  errorCode: string | null
): string {
  return errorCode !== null && UNWRITABLE_FOLDER_CODES.has(errorCode)
    ? "Codictate can't save in that folder. Choose another folder."
    : "Couldn't save the file."
}
