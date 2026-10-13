import { availableParallelism } from 'node:os'
import { asrHarnessLanguageArg } from '../../../shared/transcription-languages'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
  type CrispasrBackendId,
} from '../../../shared/asr-harness'
import { whisperDecodingForModel } from '../../../shared/speech-models'
import { requireRuntimeBinary } from '../../platform/binaries'
import { findAsrHarnessBinary } from './find-asr-harness'

export interface WhisperHarnessCommandOptions {
  harness?: AsrHarnessId
  /**
   * Which Speech Model this is. Decides how crispasr decodes it (`whisperDecodingForModel`):
   * only a Speech Model that passed the long-audio check decodes with timestamps.
   */
  speechModelId: string
  /** Absolute path to the Whisper Speech Model weights. */
  modelPath: string
  /** Transcription Language code, or null/undefined for automatic detection. */
  language: string | null | undefined
  audioPath: string
  translateToEnglish?: boolean
  /**
   * crispasr `--backend` to load the weights with. Omitted for whisper.cpp GGML weights,
   * which the default backend reads. Set to `cohere` for hviske GGUF weights, which no
   * other backend can load.
   */
  crispasrBackend?: CrispasrBackendId
  /**
   * Where crispasr writes its JSON, without the extension: `-of <base>` writes
   * `<base>.json`. A path in a directory the caller made for this one run and removes after.
   */
  jsonOutputBase: string
}

/**
 * How this run decodes (ADR-0010).
 * - `timestamps`: stock Whisper without `-nt`, so nothing is lost at 30 s window edges.
 * - `nt-vad`: `-nt` on `--backend whisper`, with the audio split at pauses by the bundled
 *   Silero VAD. Edda, and every Whisper Speech Model not yet checked without `-nt`.
 * - `cohere`: hviske. `-nt` only changes the stdout display on that backend.
 */
export type CrispasrDecoding = 'timestamps' | 'nt-vad' | 'cohere'

export interface WhisperHarnessCommand {
  harness: AsrHarnessId
  binary: string
  argv: string[]
  /** The value passed to `--language`: a language code, or `auto`. */
  languageArg: string
  /** The `--backend` value, when one was pinned. */
  crispasrBackend?: CrispasrBackendId
  decoding: CrispasrDecoding
  /** The JSON file crispasr writes: `${jsonOutputBase}.json`. */
  jsonPath: string
}

export interface WhisperHarnessCommandDependencies {
  resolveBinary: (harness: AsrHarnessId) => Promise<string>
  threadCount: () => number
  /** The bundled Silero VAD weights. Only asked for on the `nt-vad` path. */
  resolveVadModel: () => string
}

function whisperHarnessThreadCount(): number {
  return Math.max(4, availableParallelism?.() ?? 4)
}

function crispasrDecoding(
  options: WhisperHarnessCommandOptions
): CrispasrDecoding {
  if (options.crispasrBackend === 'cohere') return 'cohere'
  // An unknown Speech Model id has not been checked either, so it takes Edda's path.
  return whisperDecodingForModel(options.speechModelId) ?? 'nt-vad'
}

/**
 * The argv for one Whisper or hviske transcription on the crispasr ASR Harness, and the JSON
 * file it writes.
 *
 * Every run writes crispasr's own structured output, `--no-prints -ojf -of <base>`, and
 * Codictate reads the Raw Transcript and the Timed Transcript from `<base>.json`. Never from
 * stdout: `-of -` reaches stdout only on the stock whisper path and only on macOS (Windows
 * opens `CON`, which is not the pipe), and the `--backend` dispatcher writes a file literally
 * named `-.json` and prints plain text to stdout anyway. Stdout is drained and ignored.
 *
 * Three ways to decode (ADR-0010):
 * - `timestamps`, for a Speech Model with `whisperDecoding: 'timestamps'`: no `-nt`. On the
 *   whisper backend `-nt` puts the no-timestamps token in the prompt and decodes in fixed
 *   30 s windows, which loses speech that crosses a window edge.
 * - `nt-vad`, for Edda and every Whisper Speech Model not yet checked without `-nt`: keeps
 *   `-nt` (Edda turns to foreign-script noise without it) and runs `--backend whisper --vad`
 *   with the bundled Silero weights, which splits at pauses instead of every 30 s. The VAD
 *   path is passed explicitly so crispasr never downloads it at runtime.
 * - `cohere`, hviske: `--backend cohere -nt`. There `-nt` only changes how stdout is printed.
 *
 * Translate needs no special-casing. `-tr` was measured equivalent across Harnesses on a
 * translate-capable Speech Model (large-v3, Danish and Spanish FLEURS), and `large-v3-turbo`
 * is a transcribe-only distillation that returns the source language whatever runs it, which
 * is why translate is a Speech Model concern, not a Harness one.
 *
 * The `translateToEnglish` + pinned-backend combination is rejected rather than run,
 * because hviske's weights are Danish-only and cannot translate: a run there would
 * silently produce Danish for a user who asked for English. crispasr's own
 * `--list-backends` claims translate support for `cohere`, but that is unverified, so it
 * stays unavailable until the benchmark says otherwise. This is a last-resort invariant
 * and should be unreachable: Translate to English cannot be turned on under an hviske
 * selection (settings-heal.ts) and `buildDictationPlan` blocks the Dictation rather than
 * building a command for it. See ADR-0005.
 */
export async function buildWhisperHarnessCommand(
  options: WhisperHarnessCommandOptions,
  dependencies: WhisperHarnessCommandDependencies = {
    resolveBinary: findAsrHarnessBinary,
    threadCount: whisperHarnessThreadCount,
    resolveVadModel: () => requireRuntimeBinary('silero-vad'),
  }
): Promise<WhisperHarnessCommand> {
  const harness = options.harness ?? DEFAULT_ASR_HARNESS
  const pinnedBackend = options.crispasrBackend

  if (pinnedBackend != null && options.translateToEnglish) {
    throw new Error(
      `translate to English is not available on the crispasr ${pinnedBackend} backend`
    )
  }

  const decoding = crispasrDecoding(options)
  const binary = await dependencies.resolveBinary(harness)
  const languageArg = asrHarnessLanguageArg(options.language)
  const jsonPath = `${options.jsonOutputBase}.json`

  const argv = [binary]
  if (decoding === 'cohere') argv.push('--backend', 'cohere')
  if (decoding === 'nt-vad') argv.push('--backend', 'whisper')

  argv.push(
    '-m',
    options.modelPath,
    '-t',
    String(dependencies.threadCount()),
    '--language',
    languageArg,
    '-f',
    options.audioPath,
    '--no-prints'
  )

  if (decoding === 'nt-vad') {
    argv.push('-nt', '--vad', '-vm', dependencies.resolveVadModel())
  }
  if (decoding === 'cohere') argv.push('-nt')

  argv.push('-ojf', '-of', options.jsonOutputBase)

  if (options.translateToEnglish) argv.push('-tr')

  return {
    harness,
    binary,
    argv,
    languageArg,
    crispasrBackend: pinnedBackend,
    decoding,
    jsonPath,
  }
}
