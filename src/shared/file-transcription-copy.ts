/**
 * What the Transcribe page says about a File Transcription: the queue line, the error in
 * plain words, and which Speech Model and Transcription Language a new file will use.
 * Pure, so every line is tested without a webview.
 */

import type {
  FileTranscriptionFailureCode,
  FileTranscriptionQueueItem,
} from './types'
import {
  coerceTranscriptionLanguageIdForModel,
  getSpeechModel,
  pinnedTranscriptionLanguageId,
} from './speech-models'
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from './transcription-languages'

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
 * The Speech Model and Transcription Language a new file will use: the selected ones,
 * with the language as the Speech Model would run it (Parakeet detects it; hviske and Edda
 * are always Danish).
 */
export function transcribeSettingsSummary(
  speechModelId: string,
  transcriptionLanguageId: string
): { model: string; language: string } {
  const languageId =
    pinnedTranscriptionLanguageId(speechModelId) ??
    coerceTranscriptionLanguageIdForModel(
      speechModelId,
      transcriptionLanguageId
    )
  return {
    model: getSpeechModel(speechModelId)?.label ?? speechModelId,
    language:
      TRANSCRIPTION_LANGUAGE_OPTIONS.find((o) => o.id === languageId)?.label ??
      languageId,
  }
}
