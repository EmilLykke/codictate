/**
 * The real machine behind the File Transcription queue: `modelManager`, the media Native
 * Helper, the Speech Engine Adapters, the temp directory and the wall clock.
 *
 *   const fileTranscriptions = createFileTranscriptionQueue(
 *     productionFileTranscriptionDeps(UserAppConfig)
 *   )
 */

import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { estimateWavDurationSecFromBytes } from '../../shared/wav-duration'
import { log } from '../utils/logger'
import { runTranscription } from '../utils/whisper/engines/run-transcription'
import { modelManager } from '../utils/whisper/model-manager'
import { extractAudioToWav } from './extract-audio'
import type { FileTranscriptionSettingsReader } from './plan'
import type { FileTranscriptionDeps } from './queue'
import { createWorkDir, removeStaleWorkDirs } from './work-dirs'

/** The WAV header is all the duration walk needs; the data can be hours long. */
export function wavDurationSeconds(path: string): number | null {
  const fd = openSync(path, 'r')
  try {
    const header = new Uint8Array(4096)
    const read = readSync(fd, header, 0, header.length, 0)
    return estimateWavDurationSecFromBytes(header.subarray(0, read))
  } finally {
    closeSync(fd)
  }
}

export function inspectInputFile(
  filePath: string
): 'file' | 'missing' | 'not_a_file' {
  try {
    return statSync(filePath).isFile() ? 'file' : 'not_a_file'
  } catch {
    return 'missing'
  }
}

/** `settings` is usually `UserAppConfig`; only its getters are read, never a write. */
export function productionFileTranscriptionDeps(
  settings: FileTranscriptionSettingsReader
): FileTranscriptionDeps {
  return {
    settings,
    isModelAvailable: (id) => modelManager.isModelAvailable(id),
    locations: modelManager,
    inspectInput: inspectInputFile,
    // One directory per job, so two jobs, or a job and a Dictation (which records to its
    // own fixed path), never touch the same file.
    createWorkDir: () => createWorkDir(tmpdir()),
    removeWorkDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    removeStaleWorkDirs: () => {
      const removed = removeStaleWorkDirs(tmpdir(), { now: Date.now() })
      if (removed.length > 0) {
        log('file-transcription', 'removed stale work directories', {
          count: removed.length,
        })
      }
    },
    decode: extractAudioToWav,
    wavDurationSeconds,
    transcribe: runTranscription,
    clock: {
      now: () => Date.now(),
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    },
    newJobId: () => crypto.randomUUID(),
    log: (message, data) => log('file-transcription', message, data),
  }
}
