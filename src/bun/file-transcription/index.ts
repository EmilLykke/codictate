/**
 * File Transcription inside the app: one queue, shared by the command line and Codictate's
 * window. See GLOSSARY.md (File Transcription), docs/CLI.md (`transcribe`) and
 * docs/adr/0009-command-line-talks-to-the-running-app.md.
 */

export type {
  FileTranscriptionErrorCode,
  FileTranscriptionEvent,
  FileTranscriptionJob,
  FileTranscriptionJobSnapshot,
  FileTranscriptionJobState,
  FileTranscriptionOrigin,
  FileTranscriptionQueue,
  FileTranscriptionRequest,
  FileTranscriptionResult,
  FileTranscriptionStage,
  PublicSpeechEngineName,
} from './types'
export {
  createFileTranscriptionQueue,
  PROGRESS_INTERVAL_MS,
  type FileTranscriptionClock,
  type FileTranscriptionDeps,
} from './queue'
export type { FileTranscriptionSettingsReader } from './plan'
export { productionFileTranscriptionDeps } from './production-deps'
