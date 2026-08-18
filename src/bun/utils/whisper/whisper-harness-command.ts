import { availableParallelism } from 'node:os'
import { asrHarnessLanguageArg } from '../../../shared/transcription-languages'
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
   * which the default backend reads. Set to `cohere` for hviske GGUF weights, which no
   * other backend can load.
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
 * The argv for one Whisper transcription on the crispasr ASR Harness.
 *
 * crispasr was verified a drop-in for this exact flag set (`-m -t --language -f
 * --no-prints -nt`) before it replaced `whisper-cli`, and is now the only Harness, so
 * there is one binary to resolve and no degrade path.
 *
 * Translate needs no special-casing. `-tr` was measured equivalent across Harnesses on a
 * translate-capable Speech Model (large-v3, Danish and Spanish FLEURS): English on every
 * sample, differing only by ordinary decoding variance. An earlier turbo-model test that
 * came back in Danish was the wrong model, not a crispasr defect - `large-v3-turbo` is a
 * transcribe-only distillation and returns the source language whatever runs it, which is
 * why translate depends on the Speech Model selection. Translate is a Speech Model concern,
 * not a Harness one.
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
  options: WhisperHarnessCommandOptions
): Promise<WhisperHarnessCommand> {
  const harness = options.harness ?? DEFAULT_ASR_HARNESS
  const backend = options.crispasrBackend

  if (backend != null && options.translateToEnglish) {
    throw new Error(
      `translate to English is not available on the crispasr ${backend} backend`
    )
  }

  const binary = await findAsrHarnessBinary(harness)
  const languageArg = asrHarnessLanguageArg(options.language)

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
