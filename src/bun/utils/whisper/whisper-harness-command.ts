import { availableParallelism } from 'node:os'
import { whisperCliLanguageArg } from '../../../shared/transcription-languages'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
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
}

export interface WhisperHarnessCommand {
  harness: AsrHarnessId
  binary: string
  argv: string[]
  /** The value passed to `--language`: a language code, or `auto`. */
  languageArg: string
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
 */
export async function buildWhisperHarnessCommand(
  options: WhisperHarnessCommandOptions
): Promise<WhisperHarnessCommand> {
  const requested = options.harness ?? DEFAULT_ASR_HARNESS
  const harness =
    options.translateToEnglish && requested !== DEFAULT_ASR_HARNESS
      ? DEFAULT_ASR_HARNESS
      : requested
  const binary = await findAsrHarnessBinary(harness)
  const languageArg = whisperCliLanguageArg(options.language)

  const argv = [
    binary,
    '-m',
    options.modelPath,
    '-t',
    String(whisperHarnessThreadCount()),
    '--language',
    languageArg,
    '-f',
    options.audioPath,
    '--no-prints',
    '-nt', // No timestamps
  ]

  if (options.translateToEnglish) {
    argv.push('-tr')
  }

  return { harness, binary, argv, languageArg }
}
