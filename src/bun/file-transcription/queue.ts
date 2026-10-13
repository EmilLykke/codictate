/**
 * The File Transcription queue: one job at a time, first in first out, shared by the
 * command line and Codictate's window.
 *
 * A job is: resolve the plan (ADR-0005's one resolver, read-only), decode the file to a
 * 16 kHz mono WAV in a temp directory of its own, run the Speech Engine on it, and return
 * the Raw Transcript (in English when Translate to English is on), with its Timed Transcript
 * when the Speech Engine timed it. No Dictionary, no Formatting Mode, nothing pasted: a file is not a
 * Dictation. And a Dictation never waits for one. The queue holds no lock a Dictation takes,
 * and the decoder and the engine run at lowered OS priority.
 *
 * Everything that touches the machine comes in through `FileTranscriptionDeps`, so the
 * queue itself is tested hermetically (queue.test.ts). `productionFileTranscriptionDeps`
 * (production-deps.ts) wires the real ones.
 */

import { basename, isAbsolute, join } from 'node:path'
import { engineProcessTimeoutMs } from '../utils/whisper/engines/process-supervisor'
import type {
  SpeechModelLocations,
  TranscriptionRequest,
  TranscriptionResult,
} from '../utils/whisper/engines/transcription'
import type { DecodeAudioOptions, DecodeAudioResult } from './extract-audio'
import {
  engineFailureLine,
  fileTranscriptionFailure,
  fileTranscriptionRequest,
  planFileTranscription,
  publicEngineName,
  resultLanguage,
  selectFileTranscription,
  type FileTranscriptionSelection,
  type FileTranscriptionSettingsReader,
} from './plan'
import type {
  FileTranscriptionEvent,
  FileTranscriptionJob,
  FileTranscriptionJobSnapshot,
  FileTranscriptionJobState,
  FileTranscriptionQueue,
  FileTranscriptionRequest,
  FileTranscriptionResult,
  FileTranscriptionStage,
} from './types'

export interface FileTranscriptionClock {
  /** Epoch milliseconds. */
  now(): number
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

/** Everything the queue needs from outside itself. */
export interface FileTranscriptionDeps {
  /** The File Transcription Settings and the translate default, read when a job is queued. */
  settings: FileTranscriptionSettingsReader
  /** `modelManager.isModelAvailable`: a question, never a write. */
  isModelAvailable(speechModelId: string): boolean
  locations: SpeechModelLocations
  /** Whether the path names an existing regular file. */
  inspectInput(filePath: string): 'file' | 'missing' | 'not_a_file'
  /** A new empty directory owned by one job. */
  createWorkDir(): string
  /** Removes a directory from `createWorkDir`. Called once per job, also on cancel and failure. */
  removeWorkDir(dir: string): void
  /**
   * Removes work directories an earlier run left behind. Called once, when the queue is
   * created, before it owns any job.
   */
  removeStaleWorkDirs?(): void
  /** Any audio or video file to a 16 kHz mono WAV at `outputPath`. */
  decode(
    inputPath: string,
    outputPath: string,
    options: Required<DecodeAudioOptions>
  ): Promise<DecodeAudioResult>
  /** Seconds of audio in a WAV, or `null` when it is not a WAV whose length can be read. */
  wavDurationSeconds(wavPath: string): number | null
  /** `runTranscription`. Parakeet's adapter waits for an in-flight preparation itself. */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
  clock: FileTranscriptionClock
  newJobId(): string
  log(message: string, data?: Record<string, unknown>): void
}

/** How often a running job reports progress after a stage change. */
export const PROGRESS_INTERVAL_MS = 1000

interface JobRecord {
  readonly id: string
  readonly request: FileTranscriptionRequest
  readonly enqueuedAt: number
  readonly controller: AbortController
  readonly listeners: Set<(event: FileTranscriptionEvent) => void>
  readonly handle: FileTranscriptionJob
  selection: FileTranscriptionSelection | null
  /** Work directories not yet removed. */
  readonly workDirs: string[]
  state: FileTranscriptionJobState
  startedAt: number | null
  audioSeconds: number | null
  /** The last `queued` position sent, so an unchanged position is not sent again. */
  position: number | null
  settled: boolean
  settle: (result: FileTranscriptionResult) => void
}

const roundTo = (value: number, places: number) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

const cancelledResult = (): FileTranscriptionResult =>
  fileTranscriptionFailure('cancelled', 'The File Transcription was cancelled.')

export function createFileTranscriptionQueue(
  deps: FileTranscriptionDeps
): FileTranscriptionQueue {
  let running: JobRecord | null = null
  const waiting: JobRecord[] = []
  try {
    deps.removeStaleWorkDirs?.()
  } catch (err) {
    deps.log('could not remove stale work directories', { err: String(err) })
  }
  const changeListeners = new Set<
    (jobs: FileTranscriptionJobSnapshot[]) => void
  >()

  function emit(record: JobRecord, event: FileTranscriptionEvent): void {
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch (err) {
        deps.log('event listener threw', {
          jobId: record.id,
          err: String(err),
        })
      }
    }
  }

  function progressEvent(record: JobRecord): FileTranscriptionEvent {
    const stage: FileTranscriptionStage =
      record.state === 'transcribing' ? 'transcribing' : 'decoding'
    const startedAt = record.startedAt ?? deps.clock.now()
    return {
      type: 'progress',
      stage,
      elapsedSeconds: roundTo(
        Math.max(0, deps.clock.now() - startedAt) / 1000,
        1
      ),
      audioSeconds: record.audioSeconds,
    }
  }

  function snapshotOf(record: JobRecord): FileTranscriptionJobSnapshot {
    return {
      id: record.id,
      fileName: record.request.fileName ?? basename(record.request.filePath),
      filePath: record.request.filePath,
      origin: record.request.origin,
      state: record.state,
      enqueuedAt: record.enqueuedAt,
      startedAt: record.startedAt,
      audioSeconds: record.audioSeconds,
    }
  }

  function snapshot(): FileTranscriptionJobSnapshot[] {
    return [...(running ? [running] : []), ...waiting].map(snapshotOf)
  }

  function notifyChange(): void {
    if (changeListeners.size === 0) return
    const jobs = snapshot()
    for (const listener of [...changeListeners]) {
      try {
        listener(jobs)
      } catch (err) {
        deps.log('change listener threw', { err: String(err) })
      }
    }
  }

  function settle(record: JobRecord, result: FileTranscriptionResult): void {
    if (record.settled) return
    record.settled = true
    record.listeners.clear()
    record.settle(result)
  }

  /** Start the next job if nothing runs, tell queued jobs their new position, announce. */
  function advance(): void {
    if (running === null) {
      const next = waiting.shift()
      if (next !== undefined) start(next)
    }
    waiting.forEach((record, index) => {
      const position = index + 1
      if (record.position === position) return
      record.position = position
      emit(record, { type: 'queued', position })
    })
    notifyChange()
  }

  function start(record: JobRecord): void {
    running = record
    record.state = 'decoding'
    record.startedAt = deps.clock.now()
    emit(record, progressEvent(record))
    deps.log('job started', {
      jobId: record.id,
      origin: record.request.origin.kind,
    })
    void run(record)
  }

  function enterTranscribing(record: JobRecord): void {
    record.state = 'transcribing'
    emit(record, progressEvent(record))
    notifyChange()
  }

  function removeWorkDirs(record: JobRecord): void {
    for (const dir of record.workDirs.splice(0)) {
      try {
        deps.removeWorkDir(dir)
      } catch (err) {
        deps.log('could not remove work directory', { dir, err: String(err) })
      }
    }
  }

  async function run(record: JobRecord): Promise<void> {
    const ticker = deps.clock.setInterval(() => {
      if (!record.settled) emit(record, progressEvent(record))
    }, PROGRESS_INTERVAL_MS)
    let result: FileTranscriptionResult
    try {
      result = await execute(record, (dir) => record.workDirs.push(dir))
    } catch (err) {
      result = fileTranscriptionFailure(
        'internal',
        `File Transcription failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      deps.clock.clearInterval(ticker)
    }
    removeWorkDirs(record)
    // A cancel wins over whatever the run produced in the same turn.
    if (record.controller.signal.aborted) result = cancelledResult()
    deps.log('job finished', {
      jobId: record.id,
      status: result.status,
      code: result.status === 'failed' ? result.code : undefined,
    })
    running = null
    settle(record, result)
    advance()
  }

  async function execute(
    record: JobRecord,
    ownWorkDir: (dir: string) => void
  ): Promise<FileTranscriptionResult> {
    const { signal } = record.controller
    const { filePath } = record.request
    // Availability is asked again at the start of the run: weights deleted while the job
    // waited are reported, not substituted.
    const planned = planFileTranscription(
      record.selection!,
      deps.isModelAvailable
    )
    if (planned.status === 'failed') return planned
    const { plan } = planned
    if (signal.aborted) return cancelledResult()

    const workDir = deps.createWorkDir()
    ownWorkDir(workDir)
    const audioPath = join(workDir, 'audio.wav')
    const decoded = await deps.decode(filePath, audioPath, {
      signal,
      lowPriority: true,
    })
    if (signal.aborted) return cancelledResult()
    if (decoded.status === 'failed') {
      switch (decoded.code) {
        case 'cancelled':
          return cancelledResult()
        case 'input_unreadable':
        case 'no_audio':
          return fileTranscriptionFailure(
            decoded.code,
            `${decoded.message}: ${filePath}`
          )
        case 'internal':
          return fileTranscriptionFailure('internal', decoded.message)
      }
    }

    const seconds = deps.wavDurationSeconds(audioPath)
    if (seconds === null) {
      return fileTranscriptionFailure(
        'internal',
        'The decoded audio is not a valid WAV file.'
      )
    }
    record.audioSeconds = roundTo(seconds, 3)
    enterTranscribing(record)

    const transcribed = await deps.transcribe(
      fileTranscriptionRequest(
        plan,
        audioPath,
        engineProcessTimeoutMs(seconds * 1000),
        deps.locations,
        signal
      )
    )
    if (signal.aborted) return cancelledResult()
    if (transcribed.status === 'failed') {
      if (transcribed.reason === 'cancelled') return cancelledResult()
      return fileTranscriptionFailure(
        'engine_failed',
        engineFailureLine(
          transcribed.reason,
          plan.speechModelId,
          transcribed.diagnostic
        )
      )
    }

    return {
      status: 'ok',
      filePath,
      text: transcribed.rawTranscript,
      language: resultLanguage(plan),
      speechModelId: plan.speechModelId,
      engine: publicEngineName(plan.engineId),
      audioSeconds: record.audioSeconds,
      translated: plan.translateToEnglish,
      // Processing Time: `startedAt` is when the job left the queue and began decoding.
      processingSeconds: roundTo(
        Math.max(0, deps.clock.now() - record.startedAt!) / 1000,
        1
      ),
      timedTranscript: transcribed.timedTranscript ?? null,
    }
  }

  /** What can be refused before the job joins the queue, so a bad call fails at once. */
  function refuse(
    record: JobRecord
  ): Extract<FileTranscriptionResult, { status: 'failed' }> | null {
    const { filePath } = record.request
    if (!isAbsolute(filePath)) {
      return fileTranscriptionFailure(
        'internal',
        `File Transcription needs an absolute path, got ${filePath}`
      )
    }
    const selected = selectFileTranscription(deps.settings, record.request)
    if (selected.status === 'failed') return selected
    record.selection = selected.selection

    switch (deps.inspectInput(filePath)) {
      case 'missing':
        return fileTranscriptionFailure(
          'input_unreadable',
          `No such file: ${filePath}`
        )
      case 'not_a_file':
        return fileTranscriptionFailure(
          'input_unreadable',
          `Not a file: ${filePath}`
        )
      case 'file':
        break
    }

    const planned = planFileTranscription(
      selected.selection,
      deps.isModelAvailable
    )
    return planned.status === 'failed' ? planned : null
  }

  function cancelRecord(record: JobRecord): boolean {
    if (record.settled) return false
    if (record === running) {
      // The run stops its decoder or engine, cleans up, settles and starts the next job.
      record.controller.abort()
      return true
    }
    const index = waiting.indexOf(record)
    if (index === -1) return false
    waiting.splice(index, 1)
    record.controller.abort()
    deps.log('job cancelled while queued', { jobId: record.id })
    settle(record, cancelledResult())
    advance()
    return true
  }

  function cancelAll(): number {
    const queued = waiting.splice(0, waiting.length)
    let count = 0
    if (running !== null && !running.settled) {
      // The run settles itself once its process is gone; nothing is waiting to follow it.
      // Its work directory goes now too, since the app may exit before the run gets there.
      running.controller.abort()
      removeWorkDirs(running)
      count += 1
    }
    for (const record of queued) {
      record.controller.abort()
      settle(record, cancelledResult())
      count += 1
    }
    if (count > 0) {
      deps.log('all jobs cancelled', { count })
      notifyChange()
    }
    return count
  }

  const records = new Map<string, JobRecord>()

  function enqueue(request: FileTranscriptionRequest): FileTranscriptionJob {
    const id = deps.newJobId()
    let resolveResult!: (result: FileTranscriptionResult) => void
    const result = new Promise<FileTranscriptionResult>((resolve) => {
      resolveResult = resolve
    })
    const listeners = new Set<(event: FileTranscriptionEvent) => void>()

    const record: JobRecord = {
      id,
      request,
      enqueuedAt: deps.clock.now(),
      controller: new AbortController(),
      listeners,
      selection: null,
      workDirs: [],
      state: 'queued',
      startedAt: null,
      audioSeconds: null,
      position: null,
      settled: false,
      settle: (value) => {
        records.delete(id)
        resolveResult(value)
      },
      handle: {
        id,
        result,
        onEvent(listener) {
          if (record.settled) return () => {}
          listeners.add(listener)
          // Replay the current state, so a subscriber that arrives late is not left blank.
          try {
            if (record.state === 'queued') {
              if (record.position !== null) {
                listener({ type: 'queued', position: record.position })
              }
            } else {
              listener(progressEvent(record))
            }
          } catch (err) {
            deps.log('event listener threw', { jobId: id, err: String(err) })
          }
          return () => {
            listeners.delete(listener)
          }
        },
        cancel() {
          cancelRecord(record)
        },
      },
    }

    let refused: FileTranscriptionResult | null
    try {
      refused = refuse(record)
    } catch (err) {
      refused = fileTranscriptionFailure(
        'internal',
        `File Transcription failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (refused !== null) {
      deps.log('job refused', {
        jobId: id,
        code: refused.status === 'failed' ? refused.code : undefined,
      })
      settle(record, refused)
      return record.handle
    }

    records.set(id, record)
    waiting.push(record)
    advance()
    return record.handle
  }

  return {
    enqueue,
    snapshot,
    onChange(listener) {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    cancel(jobId) {
      const record = records.get(jobId)
      return record === undefined ? false : cancelRecord(record)
    },
    cancelAll,
  }
}
