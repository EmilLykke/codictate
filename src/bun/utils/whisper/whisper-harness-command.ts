import { availableParallelism } from 'node:os'
import { whisperCliLanguageArg } from '../../../shared/transcription-languages'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
  type CrispasrBackendId,
} from '../../../shared/asr-harness'
import { findAsrHarnessBinary } from './find-asr-harness'

export interface WhisperHarnessCommandOptions {
  harness?: AsrHarnessId
  /** Absolute path to the Whisper Speech Model weights. */
  modelPath: string
  /** Transcription Language code, or null/undefined for automatic detection. */
  language: string | null | undefined
  audioPath: string
  translateToEnglish?: boolean
  /**
   * crispasr `--backend` to load the weights with. Omitted for whisper.cpp GGML weights,
   * which both Harnesses read with their default backend. Set to `cohere` for hviske
   * GGUF weights, which no other backend can load.
   */
  crispasrBackend?: CrispasrBackendId
}

export interface WhisperHarnessCommand {
  harness: AsrHarnessId
  binary: string
  argv: string[]
  /** The value passed to `--language`: a language code, or `auto`. */
  languageArg: string
  /** The `--backend` value, when one was pinned. */
  crispasrBackend?: CrispasrBackendId
}

function whisperHarnessThreadCount(): number {
  return Math.max(4, availableParallelism?.() ?? 4)
}

/**
 * The argv for one Whisper transcription, for either ASR Harness.
 *
 * crispasr is a verified drop-in for this exact flag set (`-m -t --language -f
 * --no-prints -nt`), which is why one builder covers both.
 *
 * Translate is the exception. `-tr` is accepted by crispasr but was not confirmed
 * equivalent (a turbo-model test returned Danish rather than English), so a translate
 * run is forced back onto the default Harness here rather than merely documented as
 * such. See docs/adr/0002-asr-harness-abstraction.md.
 *
 * A pinned `crispasrBackend` (hviske) is the one case that cannot be moved: the weights
 * load under that backend alone, so the translate fallback is skipped and a translate
 * request is rejected outright instead of silently producing a run on the wrong weights.
 * crispasr's own `--list-backends` reports translate support for `cohere`, but that is
 * unverified here, so it stays unavailable until the benchmark says otherwise.
 */
export async function buildWhisperHarnessCommand(
  options: WhisperHarnessCommandOptions
): Promise<WhisperHarnessCommand> {
  const requested = options.harness ?? DEFAULT_ASR_HARNESS
  const backend = options.crispasrBackend
  const harness =
    backend == null &&
    options.translateToEnglish &&
    requested !== DEFAULT_ASR_HARNESS
      ? DEFAULT_ASR_HARNESS
      : requested

  if (backend != null) {
    if (harness !== 'crispasr') {
      throw new Error(
        `ASR harness ${harness} has no --backend flag; ${backend} requires the crispasr harness`
      )
    }
    if (options.translateToEnglish) {
      throw new Error(
        `translate to English is not available on the crispasr ${backend} backend`
      )
    }
  }

  const binary = await findAsrHarnessBinary(harness)
  const languageArg = whisperCliLanguageArg(options.language)

  const argv = [binary]

  if (backend != null) {
    argv.push('--backend', backend)
  }

  argv.push(
    '-m',
    options.modelPath,
    '-t',
    String(whisperHarnessThreadCount()),
    '--language',
    languageArg,
    '-f',
    options.audioPath,
    '--no-prints',
    '-nt' // No timestamps
  )

  if (options.translateToEnglish) {
    argv.push('-tr')
  }

  return { harness, binary, argv, languageArg, crispasrBackend: backend }
}
