import { availableParallelism } from 'node:os'
import { whisperCliLanguageArg } from '../../../shared/transcription-languages'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
  type CrispasrBackendId,
} from '../../../shared/asr-harness'
import {
  findAsrHarnessBinary,
  resolveAsrHarnessBinary,
} from './find-asr-harness'

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
 * --no-prints -nt`), which is why one builder covers both, and it is now the shipping
 * default: measurably faster and lighter at equal WER.
 *
 * Translate is not an exception and gets no Harness special-casing. `-tr` was measured
 * equivalent on a translate-capable Speech Model (large-v3, Danish and Spanish FLEURS):
 * both Harnesses returned English on every sample, differing only by ordinary decoding
 * variance. An earlier turbo-model test that came back in Danish was the wrong model, not a
 * crispasr defect - `large-v3-turbo` is a transcribe-only distillation and returns the
 * source language under either Harness, which is exactly why `resolveTranslateModelId()`
 * swaps the Speech Model before a translate run. Translate is a Speech Model concern, not a
 * Harness one.
 *
 * A pinned `crispasrBackend` (hviske) is the one case that constrains the Harness: the
 * weights load under that backend alone, and a translate request there is rejected outright
 * instead of silently producing a run on the wrong weights. crispasr's own
 * `--list-backends` reports translate support for `cohere`, but that is unverified here, so
 * it stays unavailable until the benchmark says otherwise.
 *
 * The returned `harness` is the one whose binary actually resolved. A non-hviske run
 * degrades to `whisper-cli` when the requested Harness has no binary, so that a missing
 * crispasr costs speed rather than all dictation.
 */
export async function buildWhisperHarnessCommand(
  options: WhisperHarnessCommandOptions
): Promise<WhisperHarnessCommand> {
  const requestedHarness = options.harness ?? DEFAULT_ASR_HARNESS
  const backend = options.crispasrBackend

  if (backend != null) {
    if (requestedHarness !== 'crispasr') {
      throw new Error(
        `ASR harness ${requestedHarness} has no --backend flag; ${backend} requires the crispasr harness`
      )
    }
    if (options.translateToEnglish) {
      throw new Error(
        `translate to English is not available on the crispasr ${backend} backend`
      )
    }
  }

  // A pinned backend must not degrade: whisper-cli has no --backend flag, so an hviske run
  // either gets crispasr or fails loudly.
  const resolved =
    backend == null
      ? await resolveAsrHarnessBinary(requestedHarness)
      : {
          harness: requestedHarness,
          binary: await findAsrHarnessBinary(requestedHarness),
        }
  const harness = resolved.harness
  const binary = resolved.binary
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
