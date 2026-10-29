/**
 * The Detected Language of a Dictation, found while the user is still speaking.
 *
 * Under automatic detection the decode has to know the language before it starts, to choose
 * its prompt (ADR-0011), and detecting it is a second crispasr run that loads the model again:
 * about 0.6 s. Detected after the recording stops, that is 0.6 s more before the text arrives.
 * Detected while the user speaks, it costs nothing they wait for.
 *
 * The recorder writes its WAV as it records (`utils/audio/growing-wav.ts`), so this follows the
 * file, counts the speech in it with the `--until silence` meter (`end-of-speech.ts`, which
 * skips the start chime), and detects the language of everything recorded so far once there
 * are 3 s of speech, then again at 10 s and 30 s. Speech, not time: a Dictation that opens
 * with silence checks later, because crispasr answers `en` for silence. Below 2 s of speech
 * detection was wrong on 3 of 22 clips (an English "Okay" before Danish won); from 3 s it
 * agreed with the full recording on all of them. Whisper detects on the first 30 s of speech
 * only, so nothing is checked after that.
 *
 * When the recording stops, the latest check that finished is the answer, and one still
 * running is waited for: it is closer to done than a new one. With under 3 s of speech there
 * is no answer, and the decode detects for itself.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnableDictationPlan } from '../../shared/dictation-plan'
import { EKKO_ENGINE_ID, PARAKEET_ENGINE_ID } from '../../shared/speech-models'
import { watchGrowingWav } from '../utils/audio/growing-wav'
import { log } from '../utils/logger'
import { detectSpokenLanguage } from '../utils/whisper/engines/crispasr-engine'
import { needsLanguageDetection } from '../utils/whisper/whisper-harness-command'
import {
  createEndOfSpeechDetector,
  createLevelMeter,
  DEFAULT_END_OF_SPEECH_OPTIONS,
} from './end-of-speech'

/** Speech heard before each check. */
export const LANGUAGE_CHECK_SPEECH_MS = [3_000, 10_000, 30_000] as const

/** Audio kept for the checks. Past this nothing is added, so a long silent recording stays small. */
const MAX_RECORDED_SECONDS = 300

/** A check that takes longer than this is abandoned, and the decode detects for itself. */
const CHECK_TIMEOUT_MS = 30_000

export interface LanguageWhileRecording {
  /**
   * The recording stopped: the Detected Language from the latest check, waiting for one that
   * is still running. `null` when none had enough speech or none succeeded.
   */
  finish(): Promise<string | null>
  /** The Dictation is not transcribed: stops any check and keeps nothing. */
  cancel(): void
}

export interface LanguageWhileRecordingDeps {
  /** Calls `onSamples` with each new run of samples the recorder writes. */
  watch(onSamples: (samples: Int16Array, sampleRate: number) => void): {
    stop(): void
  }
  /** The Detected Language of a WAV, or `null` when the run failed or was cancelled. */
  detect(audioPath: string, signal: AbortSignal): Promise<string | null>
  /** A directory for the snapshots, removed by the caller. */
  makeTempDir(): string
}

/**
 * Starts checking the language of a Batch Dictation as it records, or returns `null` when the
 * decode needs no Detected Language (a pinned Transcription Language, Translate to English,
 * hviske, Parakeet, ekko, or a Speech Model that decodes without the prompt). ekko is Danish
 * only and has no crispasr `-dl` run of its own, so it never gets one.
 */
export function startLanguageWhileRecording(
  plan: RunnableDictationPlan,
  options: {
    recordingPath: string
    startedAtMs: number
    /** The start chime, which plays into the microphone. */
    ignoreLeadingMs: number
    modelPath: string
  }
): LanguageWhileRecording | null {
  if (
    plan.mode !== 'batch' ||
    plan.engineId === PARAKEET_ENGINE_ID ||
    plan.engineId === EKKO_ENGINE_ID
  ) {
    return null
  }
  if (
    !needsLanguageDetection({
      crispasrBackend: plan.crispasrBackend ?? undefined,
      translateToEnglish: plan.translateToEnglish,
      language: plan.languageCode,
      speechModelId: plan.speechModelId,
    })
  ) {
    return null
  }
  return detectLanguageWhileRecording(options.ignoreLeadingMs, {
    watch: (onSamples) =>
      watchGrowingWav({
        path: options.recordingPath,
        startedAtMs: options.startedAtMs,
        intervalMs: 250,
        onSamples,
      }),
    detect: (audioPath, signal) =>
      detectSpokenLanguage({
        speechModelId: plan.speechModelId,
        modelPath: options.modelPath,
        audioPath,
        timeoutMs: CHECK_TIMEOUT_MS,
        signal,
      }),
    makeTempDir: () =>
      mkdtempSync(join(tmpdir(), 'codictate-language-while-recording-')),
  })
}

/** The checks themselves, with the recorder, crispasr and the disk injected. */
export function detectLanguageWhileRecording(
  ignoreLeadingMs: number,
  deps: LanguageWhileRecordingDeps
): LanguageWhileRecording {
  // Never ends: a pause in the middle of a Dictation must not stop the count.
  const speech = createEndOfSpeechDetector({
    ignoreLeadingMs,
    trailingSilenceMs: Number.POSITIVE_INFINITY,
  })
  const abort = new AbortController()
  const chunks: Int16Array[] = []
  let recordedSamples = 0
  let sampleRate = 0
  let meter: ((samples: Int16Array) => void) | null = null
  let nextCheck = 0
  let running: Promise<void> | null = null
  let latest: string | null = null
  let closed = false
  let dir: string | null = null
  let snapshots = 0

  const check = () => {
    if (closed || running !== null) return
    if (nextCheck >= LANGUAGE_CHECK_SPEECH_MS.length) return
    const heardMs = speech.speechMs
    if (heardMs < LANGUAGE_CHECK_SPEECH_MS[nextCheck]) return
    while (
      nextCheck < LANGUAGE_CHECK_SPEECH_MS.length &&
      heardMs >= LANGUAGE_CHECK_SPEECH_MS[nextCheck]
    ) {
      nextCheck += 1
    }

    let path: string
    try {
      dir ??= deps.makeTempDir()
      path = join(dir, `recorded-${snapshots++}.wav`)
      writeFileSync(path, wavBytes(chunks, recordedSamples, sampleRate))
    } catch (err) {
      log('whisper', 'no snapshot for the language check', {
        err: String(err),
      })
      return
    }
    // Whisper only looks at the first 30 s of speech, so after the last check the audio is
    // no longer needed.
    if (nextCheck >= LANGUAGE_CHECK_SPEECH_MS.length) chunks.length = 0

    const startedAt = performance.now()
    running = deps
      .detect(path, abort.signal)
      .then((language) => {
        if (language === null) return
        latest = language
        log('whisper', 'language detected while recording', {
          language,
          speechSeconds: heardMs / 1000,
          checkSeconds: (performance.now() - startedAt) / 1000,
        })
      })
      .catch((err) => {
        log('whisper', 'language check while recording failed', {
          err: String(err),
        })
      })
      .finally(() => {
        rmSync(path, { force: true })
        running = null
        check()
      })
  }

  const watcher = deps.watch((samples, rate) => {
    if (closed) return
    sampleRate = rate
    meter ??= createLevelMeter(
      Math.round((rate * DEFAULT_END_OF_SPEECH_OPTIONS.frameMs) / 1000),
      (levelDb) => speech.push(levelDb)
    )
    if (
      nextCheck < LANGUAGE_CHECK_SPEECH_MS.length &&
      recordedSamples < rate * MAX_RECORDED_SECONDS
    ) {
      chunks.push(samples)
      recordedSamples += samples.length
    }
    meter(samples)
    check()
  })

  const removeDir = () => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
  }

  return {
    async finish() {
      closed = true
      watcher.stop()
      if (running !== null) await running
      removeDir()
      return latest
    },
    cancel() {
      closed = true
      watcher.stop()
      abort.abort()
      if (running === null) removeDir()
      else void running.finally(removeDir)
    },
  }
}

/** A 16-bit mono PCM WAV of the samples recorded so far. */
export function wavBytes(
  chunks: readonly Int16Array[],
  samples: number,
  sampleRate: number
): Uint8Array {
  const dataBytes = samples * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i)
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && offset < bytes.length; i++) {
      view.setInt16(offset, chunk[i], true)
      offset += 2
    }
  }
  return bytes
}
