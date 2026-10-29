/**
 * The public shapes of File Transcription inside the app: what a caller asks for, what it
 * hears while it waits, and what it gets back.
 *
 * Two callers share one queue: the command line (`codictate transcribe`, docs/CLI.md) and
 * Codictate's own window. The event and error-code names are the command line's contract,
 * so renaming one is a breaking change for the `codictate` client (docs/CLI.md).
 */

import type { TimedTranscript } from '../../shared/timed-transcript'

/** Who asked. Shown to the user in the queue; never used to grant anything. */
export type FileTranscriptionOrigin =
  | { kind: 'window' }
  | {
      kind: 'command-line'
      /** The client's parent process, self-reported (`caller.name` on the wire). */
      callerName: string | null
    }

export interface FileTranscriptionRequest {
  /** Absolute path to an audio or video file. */
  filePath: string
  /**
   * The name the queue shows for the file. Absent uses the path's own name. The window sets
   * it for a dropped file, which is transcribed from a temporary copy.
   */
  fileName?: string
  /**
   * A Speech Model for this call only. `null` or absent uses the File Transcription Settings'
   * one. Settings do not change, and nothing is downloaded: it must be installed.
   */
  speechModelId?: string | null
  /**
   * A Transcription Language id (`da`, `zh-cn`) or `auto`, for this call only; `null` or
   * absent uses the File Transcription Settings' one. Coerced for the Speech Model exactly as
   * a settings write would be: Parakeet is always `auto`, hviske and Edda are always `da`.
   */
  languageId?: string | null
  /**
   * Translate to English for this call only. `null` or absent uses the File Transcription
   * Settings.
   */
  translateToEnglish?: boolean | null
  origin: FileTranscriptionOrigin
}

export type FileTranscriptionStage = 'decoding' | 'transcribing'

export type FileTranscriptionEvent =
  /** Waiting behind other File Transcriptions. `1` means next. */
  | { type: 'queued'; position: number }
  /**
   * Running. Sent when the stage changes and about once a second after that.
   * `elapsedSeconds` counts from when the job started running, not from when it was queued;
   * `audioSeconds` is the length of the decoded audio, `null` until decoding has finished.
   */
  | {
      type: 'progress'
      stage: FileTranscriptionStage
      elapsedSeconds: number
      audioSeconds: number | null
    }

/** The `error.code` values File Transcription can end with. Mapped to exit codes in docs/CLI.md. */
export type FileTranscriptionErrorCode =
  | 'input_unreadable'
  | 'no_audio'
  | 'model_not_installed'
  | 'unknown_model'
  | 'unknown_language'
  | 'language_not_allowed'
  | 'engine_failed'
  | 'cannot_translate'
  | 'cancelled'
  | 'internal'

/** The Speech Engine by the name a user sees. Never the internal id. */
export type PublicSpeechEngineName = 'whisper' | 'parakeet' | 'hviske' | 'ekko'

export type FileTranscriptionResult =
  | {
      status: 'ok'
      filePath: string
      /**
       * The Raw Transcript, after Punctuation Restoration when the plan asks for it (hviske
       * with Add punctuation on). Empty for silence, which is a success.
       */
      text: string
      /** The Transcription Language the run was fixed to, or `null` when the engine detected it. */
      language: string | null
      speechModelId: string
      engine: PublicSpeechEngineName
      /** Length of the audio, not of the run. */
      audioSeconds: number
      /** Whether `text` is Translate to English output. */
      translated: boolean
      /**
       * Processing Time, in seconds rounded to 0.1: from when the job started reading the file
       * until the transcript was ready. Time spent queued behind other File Transcriptions is
       * not counted.
       */
      processingSeconds: number
      /** When each part of `text` was spoken; `null` when the Speech Engine gave no usable timings. */
      timedTranscript: TimedTranscript | null
    }
  | {
      status: 'failed'
      code: FileTranscriptionErrorCode
      /** One line, written for the person who asked. */
      message: string
    }

export type FileTranscriptionJobState = 'queued' | FileTranscriptionStage

export interface FileTranscriptionJobSnapshot {
  id: string
  fileName: string
  filePath: string
  origin: FileTranscriptionOrigin
  state: FileTranscriptionJobState
  /** Epoch milliseconds. */
  enqueuedAt: number
  /** Epoch milliseconds, `null` while queued. */
  startedAt: number | null
  audioSeconds: number | null
}

export interface FileTranscriptionJob {
  readonly id: string
  /** Settles exactly once, and never rejects: every failure is a `failed` result. */
  readonly result: Promise<FileTranscriptionResult>
  /**
   * Listen for `queued` and `progress` events. A subscriber that arrives late is sent the
   * current state first. Returns the unsubscribe function.
   */
  onEvent(listener: (event: FileTranscriptionEvent) => void): () => void
  /**
   * Abandon the job. A queued job leaves the queue; a running one has its decoder or Speech
   * Engine stopped. Either way the result is `cancelled`. A finished job ignores it.
   */
  cancel(): void
}

export interface FileTranscriptionQueue {
  enqueue(request: FileTranscriptionRequest): FileTranscriptionJob
  /** The running job first, then the queued ones in the order they will run. */
  snapshot(): FileTranscriptionJobSnapshot[]
  /**
   * Called with a fresh snapshot whenever a job is added, starts, changes stage, learns its
   * audio length, or leaves. Not on every progress tick. Returns the unsubscribe function.
   */
  onChange(listener: (jobs: FileTranscriptionJobSnapshot[]) => void): () => void
  /** `true` when the job was queued or running and is now cancelled. */
  cancel(jobId: string): boolean
  /**
   * Cancels every job at once, for quitting: aborts each job's controller synchronously, so
   * the decoder or Speech Engine process is signalled before the app exits, and empties the
   * queue so nothing else starts. Returns how many jobs were cancelled.
   */
  cancelAll(): number
}
