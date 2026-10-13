/**
 * What the Transcribe page is sent: the queue as the window shows it, and a finished window
 * File Transcription as a card. Pure.
 */

import type {
  FileTranscriptionJobSnapshot,
  FileTranscriptionResult,
} from '../file-transcription'
import type {
  FileTranscriptionOutcome,
  FileTranscriptionQueueItem,
} from '../../shared/types'

/** The running job first, then the queued ones with their place in line. */
export function queueItemsFromSnapshot(
  jobs: readonly FileTranscriptionJobSnapshot[]
): FileTranscriptionQueueItem[] {
  let position = 0
  return jobs.map((job) => {
    const queued = job.state === 'queued'
    if (queued) position += 1
    return {
      id: job.id,
      fileName: job.fileName,
      origin: job.origin.kind,
      callerName:
        job.origin.kind === 'command-line' ? job.origin.callerName : null,
      state: job.state,
      position: queued ? position : null,
      startedAt: job.startedAt,
      audioSeconds: job.audioSeconds,
    }
  })
}

export function outcomeFromResult(args: {
  id: string
  filePath: string
  fileName: string
  finishedAt: number
  result: FileTranscriptionResult
}): FileTranscriptionOutcome {
  const { id, filePath, fileName, finishedAt, result } = args
  if (result.status === 'failed') {
    return {
      id,
      fileName,
      filePath,
      finishedAt,
      status: 'failed',
      code: result.code,
      message: result.message,
    }
  }
  return {
    id,
    fileName,
    filePath,
    finishedAt,
    status: 'ok',
    text: result.text,
    audioSeconds: result.audioSeconds,
    speechModelId: result.speechModelId,
    savedToHistory: false,
    processingSeconds: result.processingSeconds ?? 0,
    language: result.language,
    translated: result.translated ?? false,
    hasTimedTranscript: (result.timedTranscript ?? null) !== null,
    lastExport: null,
  }
}

/** A transcript worth keeping in History: anything but silence. */
export function belongsInHistory(outcome: FileTranscriptionOutcome): boolean {
  return outcome.status === 'ok' && outcome.text.trim() !== ''
}
