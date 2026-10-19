/**
 * File Transcription in Codictate's window: the Transcribe page, the tray's "Transcribe
 * File…" and a file dropped on the window all come through here. A dropped file arrives as
 * a temporary copy (dropped-files.ts) with no source folder: its results carry
 * `sourcePath: null`, so History keeps no path for it and its Transcript Export does not
 * start in the temporary folder.
 *
 * It sits on the one File Transcription queue it shares with the command line
 * (docs/adr/0009-command-line-talks-to-the-running-app.md). Every job it adds has origin
 * `window`. It shows command-line jobs while they wait or run, and can cancel them, but
 * keeps only its own results: those stay in memory for the session and, when History is on,
 * go to History (GLOSSARY.md: File Transcription, History), Timed Transcript included.
 *
 * A Transcript Export of a session result or a History entry also runs here: render, ask
 * for a folder in the native folder picker, write a new file there named after the
 * transcribed file. It is started by an RPC message and reports back with one, because the
 * picker must never be awaited inside a request (#156).
 *
 * Everything that touches the machine comes in through the deps, so it is tested
 * hermetically (controller.test.ts).
 */

import { basename, dirname } from 'node:path'
import type {
  FileTranscriptionQueue,
  FileTranscriptionResult,
} from '../file-transcription'
import type { FileTranscriptionHistoryRecord } from '../utils/history/history-manager'
import type {
  FileTranscriptionFailureCode,
  FileTranscriptionOutcome,
  FileTranscriptionsState,
  TranscriptExportResult,
  TranscriptExportTarget,
} from '../../shared/types'
import type { TimedTranscript } from '../../shared/timed-transcript'
import {
  renderTranscript as renderTranscriptDefault,
  transcriptExportFileName as transcriptExportFileNameDefault,
  type TranscriptExportFormat,
  type TranscriptExportSource,
} from '../../shared/transcript-export'
import { transcriptExportFailureMessage } from '../../shared/file-transcription-copy'
import { exportStartFolder, uniqueExportPath } from './paths'
import {
  belongsInHistory,
  outcomeFromResult,
  queueItemsFromSnapshot,
} from './view'

/** How many finished results the page keeps for the session. */
export const FINISHED_LIMIT = 100

const GONE_MESSAGE = "That transcript isn't here anymore."

/**
 * How many names an export tries when the exclusive write finds its name taken after all,
 * because something else created that file between the check and the write.
 */
const EXPORT_WRITE_ATTEMPTS = 5

export interface WindowFileTranscriptionsDeps {
  queue: FileTranscriptionQueue
  /** The native open dialog. Resolves `[]` when the user cancels. */
  chooseFiles(startingFolder: string | null): Promise<string[]>
  /**
   * Keep a finished transcript in History when History is on. Resolves whether it was kept.
   * No audio: the file stays the user's own.
   */
  saveToHistory(record: FileTranscriptionHistoryRecord): Promise<boolean>
  /**
   * The native folder picker, opened in `startingFolder`. Resolves the chosen folder, or
   * `null` when the user cancels.
   */
  chooseExportFolder(startingFolder: string): Promise<string | null>
  /** The folder the last Transcript Export went to, remembered across launches. */
  lastExportFolder(): string | null
  rememberExportFolder(folder: string): Promise<void>
  /**
   * What a History entry's Transcript Export is made from, and the transcribed file's path
   * when History kept it. `null` when there is no File Transcription entry with that id.
   */
  loadHistoryExportSource(
    id: string
  ): Promise<{ source: TranscriptExportSource; filePath: string | null } | null>
  /** How a Transcript Export ended. Called whether or not a window is open to receive it. */
  pushExportResult(result: TranscriptExportResult): void
  isDirectory(path: string): boolean
  /** Whether anything is at the path, so an export picks a free name. */
  pathExists(path: string): boolean
  homeFolder(): string
  /**
   * Create the file, never replacing one: throws an error with code `EEXIST` when the name is
   * taken.
   */
  writeNewFile(path: string, text: string): void
  /** Show a file in Finder / Explorer. */
  reveal(path: string): void
  now(): number
  /** The page's state changed. Called whether or not a window is open to receive it. */
  onChange(state: FileTranscriptionsState): void
  /** A window File Transcription finished, after History has had its say. */
  onFinished?(outcome: FileTranscriptionOutcome): void
  log(message: string, data?: Record<string, unknown>): void
  /** Injected in tests; the shared renderer otherwise. */
  renderTranscript?: typeof renderTranscriptDefault
  /** The exported file's name. Injected in tests; the shared namer otherwise. */
  transcriptExportFileName?: typeof transcriptExportFileNameDefault
}

export interface WindowFileTranscriptions {
  /** Queue each file as its own File Transcription. Returns how many were queued. */
  transcribe(paths: readonly string[]): number
  /**
   * Queue Codictate's temporary copy of a file dropped on the window. `fileName` is the
   * original name, shown on the page and kept in History; the copy's path is never kept.
   * Resolves once the job has settled and History has had its say, when the copy can go.
   */
  transcribeDroppedCopy(copy: {
    filePath: string
    fileName: string
  }): Promise<void>
  /** Open the native dialog and queue what is chosen. Resolves how many were queued. */
  chooseAndTranscribe(): Promise<number>
  cancel(id: string): boolean
  dismiss(id: string): boolean
  /**
   * Ask for a folder in the native folder picker and write the transcript there in `format`,
   * as a new file named after the transcribed file.
   * How it ended goes to `pushExportResult`; the returned promise resolves with the same
   * result.
   */
  exportTranscript(
    target: TranscriptExportTarget,
    format: TranscriptExportFormat
  ): Promise<TranscriptExportResult>
  /** Show the file the last Transcript Export of `target` wrote. */
  revealExport(target: TranscriptExportTarget): void
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
  const render = deps.renderTranscript ?? renderTranscriptDefault
  const exportFileName =
    deps.transcriptExportFileName ?? transcriptExportFileNameDefault

  /** Newest first. */
  let finished: FileTranscriptionOutcome[] = []
  /**
   * The Timed Transcripts of `finished`, by id. They stay in this process: the page is told
   * only whether there is one (`hasTimedTranscript`).
   */
  const timings = new Map<string, TimedTranscript>()
  /** Where each History entry was last exported to this session, for "Show". */
  const historyExports = new Map<string, string>()
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

  /** Forget the timings of results no longer on the page. */
  function pruneTimings(): void {
    const kept = new Set(finished.map((outcome) => outcome.id))
    for (const id of timings.keys()) {
      if (!kept.has(id)) timings.delete(id)
    }
  }

  async function settle(
    id: string,
    file: { fileName: string; sourcePath: string | null },
    result: FileTranscriptionResult
  ): Promise<void> {
    let outcome = outcomeFromResult({
      id,
      sourcePath: file.sourcePath,
      fileName: file.fileName,
      finishedAt: deps.now(),
      result,
    })
    const timedTranscript =
      result.status === 'ok' ? (result.timedTranscript ?? null) : null
    if (timedTranscript !== null) timings.set(id, timedTranscript)
    finished = [outcome, ...finished].slice(0, FINISHED_LIMIT)
    pruneTimings()
    push()

    if (outcome.status === 'ok' && belongsInHistory(outcome)) {
      let saved = false
      try {
        saved = await deps.saveToHistory({
          transcript: outcome.text,
          fileName: outcome.fileName,
          filePath: outcome.sourcePath,
          durationMs: outcome.audioSeconds * 1000,
          processingSeconds: outcome.processingSeconds,
          speechModelId: outcome.speechModelId,
          language: outcome.language,
          translated: outcome.translated,
          timedTranscript,
        })
      } catch (err) {
        deps.log('history save failed', { id, err: String(err) })
      }
      if (saved) {
        // Re-read: an export may have finished while History was being written.
        const current = finished.find((existing) => existing.id === id)
        if (current?.status === 'ok') {
          outcome = { ...current, savedToHistory: true }
          replace(outcome)
          push()
        }
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
      const file = { fileName: basename(filePath), sourcePath: filePath }
      void job.result.then((result) => settle(job.id, file, result))
    }
    deps.log('window files queued', { count: queued })
    return queued
  }

  function transcribeDroppedCopy(copy: {
    filePath: string
    fileName: string
  }): Promise<void> {
    // No `lastFolder`: the open dialog must not start in the temporary folder.
    const job = deps.queue.enqueue({
      filePath: copy.filePath,
      fileName: copy.fileName,
      origin: { kind: 'window' },
    })
    deps.log('dropped file queued', { id: job.id })
    return job.result.then((result) =>
      settle(job.id, { fileName: copy.fileName, sourcePath: null }, result)
    )
  }

  async function resolveSource(target: TranscriptExportTarget): Promise<{
    source: TranscriptExportSource
    filePath: string | null
  } | null> {
    if (target.kind === 'history') {
      return deps.loadHistoryExportSource(target.id)
    }
    const outcome = finished.find((existing) => existing.id === target.id)
    if (outcome === undefined || outcome.status !== 'ok') return null
    return {
      filePath: outcome.sourcePath,
      source: {
        fileName: outcome.fileName,
        speechModelId: outcome.speechModelId,
        language: outcome.language,
        translated: outcome.translated,
        audioSeconds: outcome.audioSeconds,
        processingSeconds: outcome.processingSeconds,
        text: outcome.text,
        timedTranscript: timings.get(outcome.id) ?? null,
      },
    }
  }

  async function runExport(
    target: TranscriptExportTarget,
    format: TranscriptExportFormat
  ): Promise<TranscriptExportResult> {
    let resolved: Awaited<ReturnType<typeof resolveSource>>
    try {
      resolved = await resolveSource(target)
    } catch (err) {
      deps.log('export source failed', { target, err: String(err) })
      resolved = null
    }
    if (resolved === null) {
      return { target, status: 'failed', format, message: GONE_MESSAGE }
    }
    // A dropped file has no source folder (`null`): the last export folder, then home.
    const { source, filePath } = resolved

    // Before the picker: a Caption File without timings is refused without asking where.
    let rendered: ReturnType<typeof render>
    try {
      rendered = render(format, source)
    } catch (err) {
      deps.log('export render failed', { target, format, err: String(err) })
      return {
        target,
        status: 'failed',
        format,
        message: transcriptExportFailureMessage(null),
      }
    }
    if (!rendered.ok) {
      return { target, status: 'failed', format, message: rendered.message }
    }

    const start = exportStartFolder({
      lastExportFolder: deps.lastExportFolder(),
      sourceFolder: filePath ? dirname(filePath) : null,
      homeFolder: deps.homeFolder(),
      isDirectory: (path) => deps.isDirectory(path),
    })
    let folder: string | null
    try {
      folder = await deps.chooseExportFolder(start)
    } catch (err) {
      deps.log('folder picker failed', { err: String(err) })
      return {
        target,
        status: 'failed',
        format,
        message: transcriptExportFailureMessage(null),
      }
    }
    if (folder === null) return { target, status: 'cancelled' }
    if (!deps.isDirectory(folder)) {
      deps.log('export folder is not a folder', { target })
      return {
        target,
        status: 'failed',
        format,
        message: transcriptExportFailureMessage(null),
      }
    }

    // A taken name moves on to `talk 2.srt`. The write is exclusive, so a file that appears
    // after the check is never replaced: that name counts as taken and the next one is tried.
    // A name the write refused stays taken even if `pathExists` still says it is free.
    const fileName = exportFileName(source.fileName, format)
    const refused = new Set<string>()
    let path: string | null = null
    let failure: unknown = null
    for (let attempt = 0; attempt < EXPORT_WRITE_ATTEMPTS; attempt++) {
      const candidate = uniqueExportPath(
        folder,
        fileName,
        (p) => refused.has(p) || deps.pathExists(p)
      )
      try {
        deps.writeNewFile(candidate, rendered.content)
        path = candidate
        break
      } catch (err) {
        failure = err
        if (errorCode(err) !== 'EEXIST') break
        refused.add(candidate)
      }
    }
    if (path === null) {
      deps.log('export write failed', {
        target,
        format,
        err: String(failure),
      })
      return {
        target,
        status: 'failed',
        format,
        message: transcriptExportFailureMessage(errorCode(failure)),
      }
    }

    try {
      await deps.rememberExportFolder(folder)
    } catch (err) {
      deps.log('remember export folder failed', { err: String(err) })
    }
    if (target.kind === 'history') {
      historyExports.set(target.id, path)
    } else {
      const current = finished.find((existing) => existing.id === target.id)
      if (current?.status === 'ok') {
        replace({ ...current, lastExport: { format, path } })
        push()
      }
    }
    deps.log('transcript exported', { target, format })
    return { target, status: 'saved', format, path }
  }

  async function exportTranscript(
    target: TranscriptExportTarget,
    format: TranscriptExportFormat
  ): Promise<TranscriptExportResult> {
    const result = await runExport(target, format)
    try {
      deps.pushExportResult(result)
    } catch (err) {
      deps.log('export result push failed', { err: String(err) })
    }
    return result
  }

  return {
    transcribe,
    transcribeDroppedCopy,
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
      pruneTimings()
      push()
      return true
    },
    exportTranscript,
    revealExport(target) {
      if (target.kind === 'history') {
        const path = historyExports.get(target.id)
        if (path !== undefined) deps.reveal(path)
        return
      }
      const outcome = finished.find((existing) => existing.id === target.id)
      if (outcome?.status === 'ok' && outcome.lastExport !== null) {
        deps.reveal(outcome.lastExport.path)
      }
    },
    state,
    dispose() {
      unsubscribe()
    },
  }
}
