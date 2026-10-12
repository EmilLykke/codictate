/**
 * File Transcription in Codictate's window: the Transcribe page, the tray's "Transcribe
 * File…" and a file dropped on the window all come through here.
 *
 * It sits on the one File Transcription queue it shares with the command line
 * (docs/adr/0009-command-line-talks-to-the-running-app.md). Every job it adds has origin
 * `window`. It shows command-line jobs while they wait or run, and can cancel them, but
 * keeps only its own results: those stay in memory for the session and, when History is on,
 * go to History (GLOSSARY.md: File Transcription, History). Raw Transcript only.
 *
 * Everything that touches the machine comes in through the deps, so it is tested
 * hermetically (controller.test.ts).
 */

import { basename, dirname, join } from 'node:path'
import type {
  FileTranscriptionQueue,
  FileTranscriptionResult,
} from '../file-transcription'
import type {
  FileTranscriptionFailureCode,
  FileTranscriptionOutcome,
  FileTranscriptionsState,
  SaveTranscriptResult,
} from '../../shared/types'
import { transcriptTextFileName } from './paths'
import {
  belongsInHistory,
  outcomeFromResult,
  queueItemsFromSnapshot,
} from './view'

/** How many finished results the page keeps for the session. */
export const FINISHED_LIMIT = 100

/** How many `name N.txt` names "Save as text" tries before giving up. */
const TEXT_NAME_ATTEMPTS = 500

export interface WindowFileTranscriptionsDeps {
  queue: FileTranscriptionQueue
  /** The native open dialog. Resolves `[]` when the user cancels. */
  chooseFiles(startingFolder: string | null): Promise<string[]>
  /**
   * Keep a finished transcript in History when History is on. Resolves whether it was kept.
   * No audio: the file stays the user's own.
   */
  saveToHistory(entry: {
    transcript: string
    fileName: string
    durationMs: number
  }): Promise<boolean>
  /** Create a new file; must throw an error with `code: 'EEXIST'` when the path exists. */
  writeNewFile(path: string, text: string): void
  /** Where "Save as text" writes when the original file's folder cannot be written. */
  fallbackFolder(): string
  /** Show a file in Finder / Explorer. */
  reveal(path: string): void
  now(): number
  /** The page's state changed. Called whether or not a window is open to receive it. */
  onChange(state: FileTranscriptionsState): void
  /** A window File Transcription finished, after History has had its say. */
  onFinished?(outcome: FileTranscriptionOutcome): void
  log(message: string, data?: Record<string, unknown>): void
}

export interface WindowFileTranscriptions {
  /** Queue each file as its own File Transcription. Returns how many were queued. */
  transcribe(paths: readonly string[]): number
  /** Open the native dialog and queue what is chosen. Resolves how many were queued. */
  chooseAndTranscribe(): Promise<number>
  cancel(id: string): boolean
  dismiss(id: string): boolean
  saveAsText(id: string): SaveTranscriptResult
  reveal(id: string): void
  state(): FileTranscriptionsState
  dispose(): void
}

// The window shows the command line's error codes, so the two unions must stay one.
type SameCodes<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never
const codesMatch: SameCodes<
  Extract<FileTranscriptionResult, { status: 'failed' }>['code'],
  FileTranscriptionFailureCode
> = true
void codesMatch

function errorCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : null
}

export function createWindowFileTranscriptions(
  deps: WindowFileTranscriptionsDeps
): WindowFileTranscriptions {
  /** Newest first. */
  let finished: FileTranscriptionOutcome[] = []
  /** The dialog opens where the last pick came from. */
  let lastFolder: string | null = null

  function state(): FileTranscriptionsState {
    return {
      active: queueItemsFromSnapshot(deps.queue.snapshot()),
      finished: finished.slice(),
    }
  }

  function push(): void {
    try {
      deps.onChange(state())
    } catch (err) {
      deps.log('state push failed', { err: String(err) })
    }
  }

  function replace(outcome: FileTranscriptionOutcome): void {
    finished = finished.map((existing) =>
      existing.id === outcome.id ? outcome : existing
    )
  }

  async function settle(
    id: string,
    filePath: string,
    result: FileTranscriptionResult
  ): Promise<void> {
    let outcome = outcomeFromResult({
      id,
      filePath,
      fileName: basename(filePath),
      finishedAt: deps.now(),
      result,
    })
    finished = [outcome, ...finished].slice(0, FINISHED_LIMIT)
    push()

    if (outcome.status === 'ok' && belongsInHistory(outcome)) {
      let saved = false
      try {
        saved = await deps.saveToHistory({
          transcript: outcome.text,
          fileName: outcome.fileName,
          durationMs: outcome.audioSeconds * 1000,
        })
      } catch (err) {
        deps.log('history save failed', { id, err: String(err) })
      }
      if (saved) {
        outcome = { ...outcome, savedToHistory: true }
        replace(outcome)
        push()
      }
    }
    deps.onFinished?.(outcome)
  }

  const unsubscribe = deps.queue.onChange(() => push())

  function transcribe(paths: readonly string[]): number {
    let queued = 0
    for (const filePath of paths) {
      if (filePath.trim() === '') continue
      const job = deps.queue.enqueue({ filePath, origin: { kind: 'window' } })
      queued += 1
      lastFolder = dirname(filePath)
      void job.result.then((result) => settle(job.id, filePath, result))
    }
    deps.log('window files queued', { count: queued })
    return queued
  }

  function writeBeside(folder: string, fileName: string, text: string): string {
    for (let attempt = 1; attempt <= TEXT_NAME_ATTEMPTS; attempt += 1) {
      const path = join(folder, transcriptTextFileName(fileName, attempt))
      try {
        deps.writeNewFile(path, text)
        return path
      } catch (err) {
        if (errorCode(err) === 'EEXIST') continue
        throw err
      }
    }
    throw new Error(`No free name for ${fileName} in ${folder}`)
  }

  function saveAsText(id: string): SaveTranscriptResult {
    const outcome = finished.find((existing) => existing.id === id)
    if (outcome === undefined || outcome.status !== 'ok') {
      return { ok: false, message: "That transcript isn't here anymore." }
    }
    const text = outcome.text.endsWith('\n')
      ? outcome.text
      : `${outcome.text}\n`
    let path: string
    let location: 'source-folder' | 'fallback-folder' = 'source-folder'
    try {
      path = writeBeside(dirname(outcome.filePath), outcome.fileName, text)
    } catch (err) {
      deps.log('save beside source failed', { id, err: String(err) })
      try {
        path = writeBeside(deps.fallbackFolder(), outcome.fileName, text)
        location = 'fallback-folder'
      } catch (fallbackErr) {
        deps.log('save to fallback failed', { id, err: String(fallbackErr) })
        return { ok: false, message: "Couldn't save the text file." }
      }
    }
    replace({ ...outcome, savedTextPath: path })
    push()
    return { ok: true, path, location }
  }

  return {
    transcribe,
    async chooseAndTranscribe() {
      let paths: string[]
      try {
        paths = await deps.chooseFiles(lastFolder)
      } catch (err) {
        deps.log('file dialog failed', { err: String(err) })
        return 0
      }
      return transcribe(paths)
    },
    cancel(id) {
      return deps.queue.cancel(id)
    },
    dismiss(id) {
      const before = finished.length
      finished = finished.filter((outcome) => outcome.id !== id)
      if (finished.length === before) return false
      push()
      return true
    },
    saveAsText,
    reveal(id) {
      const outcome = finished.find((existing) => existing.id === id)
      if (outcome?.status === 'ok' && outcome.savedTextPath !== null) {
        deps.reveal(outcome.savedTextPath)
      }
    },
    state,
    dispose() {
      unsubscribe()
    },
  }
}
