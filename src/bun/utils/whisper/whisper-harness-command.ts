import { availableParallelism } from 'node:os'
import { asrHarnessLanguageArg } from '../../../shared/transcription-languages'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
  type CrispasrBackendId,
} from '../../../shared/asr-harness'
import {
  ntVadPromptForModel,
  whisperDecodingForModel,
} from '../../../shared/speech-models'
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
  /**
   * The `--vad-import` file Codictate wrote for this run: where the audio is cut before an
   * `nt-vad` decode (`planVadSlices`, issue #83). Required on `nt-vad`, ignored on the other
   * paths. In the same per-run directory as the JSON.
   */
  vadImportPath?: string
  /**
   * `-bs 5` on `nt-vad`. Defaults to on, which is what the app runs; only the long-audio
   * check turns it off, to measure beam search against greedy decoding.
   */
  ntVadBeamSearch?: boolean
  /**
   * The dictation `--prompt` on `nt-vad`. Defaults to the Speech Model's own
   * (`ntVadPromptForModel`), which is what the app runs; only the long-audio check turns it
   * off, to measure the prompt's effect.
   */
  ntVadPrompt?: boolean
}

/**
 * How this run decodes (ADR-0010, ADR-0011).
 * - `timestamps`: stock Whisper without `-nt`, so nothing is lost at 30 s window edges, with
 *   whisper.cpp's own VAD, beam search and a punctuated prompt, so a pause mid-sentence does
 *   not end the sentence.
 * - `nt-vad`: `-nt` on `--backend whisper`, decoding the slices Codictate cut at pauses and
 *   passed with `--vad-import`. Edda, and every Whisper Speech Model not yet checked without
 *   `-nt`.
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
  /**
   * The `--vad-import` file the argv reads, which the caller writes before spawning, or
   * `null` off the `nt-vad` path.
   */
  vadImportPath: string | null
}

export interface WhisperHarnessCommandDependencies {
  resolveBinary: (harness: AsrHarnessId) => Promise<string>
  threadCount: () => number
  /**
   * The bundled Silero VAD weights. Asked for on the `timestamps` path and by the language
   * detection run.
   */
  resolveVadModel: () => string
}

function whisperHarnessThreadCount(): number {
  return Math.max(4, availableParallelism?.() ?? 4)
}

const DEFAULT_DEPENDENCIES: WhisperHarnessCommandDependencies = {
  resolveBinary: findAsrHarnessBinary,
  threadCount: whisperHarnessThreadCount,
  resolveVadModel: () => requireRuntimeBinary('silero-vad'),
}

/**
 * The `--prompt` for the `timestamps` and `nt-vad` paths (ADR-0011): one punctuated sentence
 * in the language Whisper will write, so beam search keeps capitals and full stops instead of
 * running on with commas. English also covers Translate to English. Auto-detect never reaches
 * here as `auto`: Whisper follows the prompt's language over the detected language token, so
 * the English prompt turned Danish speech into English. The adapter detects the language first
 * (`buildLanguageDetectionCommand`) and decodes with it pinned, so the prompt matches what was
 * spoken. Any other pinned language gets none: untested, so unbiased. On `nt-vad` it is what Edda's card does
 * too (previous text in the prompt slot), and without it Edda wrote no full stop in a 65 s
 * dictation (ADR-0010). Exported for the long-audio check, which fails a Speech Model that
 * writes it back out.
 */
export const DICTATION_PROMPT = {
  en: 'Hello, this is a dictation. I write in full sentences, with commas where I pause.',
  da: 'Hej, dette er en diktering. Jeg skriver i hele sætninger, med kommaer hvor jeg holder pause.',
} as const

function dictationPrompt(
  languageArg: string,
  translateToEnglish: boolean | undefined
): string | null {
  if (translateToEnglish || languageArg === 'en') {
    return DICTATION_PROMPT.en
  }
  if (languageArg === 'da') return DICTATION_PROMPT.da
  return null
}

/**
 * `-vt` on the `timestamps` path (ADR-0011). Above it the VAD starts a speech region late or
 * skips quiet speech, and Whisper never hears it. At the default 0.5, and still at 0.35, small
 * and turbo turned "Stuff it into you" into "Stuffed into you", and medium.en dropped seven
 * words at the start of a LibriSpeech clip. At 0.25 both are back, no model missed more
 * reference words on 40 clips than at 0.35, and sentence breaks on real dictations did not
 * change. A wider `-vp` pad fixes a first word too but keeps more of each pause, and the full
 * stops come back. Not on `nt-vad`: that path runs no Silero VAD, because `--vad-import`
 * replaces it with Codictate's own cuts.
 */
const VAD_THRESHOLD = '0.25'

function crispasrDecoding(
  options: Pick<
    WhisperHarnessCommandOptions,
    'crispasrBackend' | 'speechModelId'
  >
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
 *   30 s windows, which loses speech that crosses a window edge. Left alone, Whisper closes a
 *   sentence at every pause on this path, so it adds (ADR-0011) `--vad -vm` with the bundled
 *   Silero weights, which joins the speech into one stream with short gaps while keeping the
 *   original timeline for segment times, `-bs 5` beam search, and a punctuated `--prompt` in
 *   the language Whisper will write (`dictationPrompt`). No `--backend`: the dispatcher's VAD
 *   decodes each slice on its own and breaks sentences more, not less.
 * - `nt-vad`, for Edda and every Whisper Speech Model that has not passed the check without
 *   `-nt`: keeps `-nt` (Edda turns to foreign-script noise without it) on `--backend whisper`,
 *   and decodes the slices in `vadImportPath` (issue #83). With `-nt`, whisper.cpp always
 *   skips ahead a whole 30 s window after an early end-of-text, so any slice over 30 s loses
 *   speech; Codictate cuts at pauses into slices of 30 s or less instead, one window each,
 *   which is also Edda's card (`chunk_length_s=30`). crispasr uses imported chunks as written
 *   (no merge, no re-pack), and `--vad-import` turns its VAD on by itself without loading a
 *   VAD model, so there is no `--vad` and no `-vm` (checked on v0.8.41: same transcript with
 *   them, Silero never loaded, nothing downloaded). Also `-sns`, which suppresses non-speech
 *   tokens as OpenAI whisper, faster-whisper and WhisperX do by default, `-bs 5`, from Edda's
 *   model card, and the same `--prompt` as `timestamps` unless the Speech Model opts out
 *   (`ntVadPrompt: false`). Temperature fallback stays on.
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
  dependencies: WhisperHarnessCommandDependencies = DEFAULT_DEPENDENCIES
): Promise<WhisperHarnessCommand> {
  const harness = options.harness ?? DEFAULT_ASR_HARNESS
  const pinnedBackend = options.crispasrBackend

  if (pinnedBackend != null && options.translateToEnglish) {
    throw new Error(
      `translate to English is not available on the crispasr ${pinnedBackend} backend`
    )
  }

  const decoding = crispasrDecoding(options)
  const vadImportPath = options.vadImportPath
  if (decoding === 'nt-vad' && !vadImportPath) {
    throw new Error(
      `${options.speechModelId} decodes on nt-vad, which needs a --vad-import slices file`
    )
  }
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

  if (decoding === 'timestamps') {
    argv.push(
      '--vad',
      '-vm',
      dependencies.resolveVadModel(),
      '-vt',
      VAD_THRESHOLD,
      '-bs',
      '5'
    )
    const prompt = dictationPrompt(languageArg, options.translateToEnglish)
    if (prompt !== null) argv.push('--prompt', prompt)
  }
  if (decoding === 'nt-vad' && vadImportPath) {
    argv.push('-nt', '--vad-import', vadImportPath, '-sns')
    if (options.ntVadBeamSearch !== false) argv.push('-bs', '5')
    const prompt =
      (options.ntVadPrompt ?? ntVadPromptForModel(options.speechModelId))
        ? dictationPrompt(languageArg, options.translateToEnglish)
        : null
    if (prompt !== null) argv.push('--prompt', prompt)
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
    vadImportPath: decoding === 'nt-vad' ? (vadImportPath ?? null) : null,
  }
}

/**
 * Whether a decode has to know the Detected Language before it starts, to choose its prompt.
 * No for a pinned language, for Translate to English (the English prompt matches its English
 * output whatever was spoken), for a pinned backend (hviske takes no prompt), and for a Speech
 * Model whose `nt-vad` decode runs without the prompt. Asked by the adapter, and by a Dictation
 * that detects while the user is still speaking.
 */
export function needsLanguageDetection(
  options: Pick<
    WhisperHarnessCommandOptions,
    | 'crispasrBackend'
    | 'translateToEnglish'
    | 'language'
    | 'speechModelId'
    | 'ntVadPrompt'
  >
): boolean {
  if (options.crispasrBackend != null || options.translateToEnglish) {
    return false
  }
  if (asrHarnessLanguageArg(options.language) !== 'auto') return false
  const decoding = crispasrDecoding(options)
  if (decoding === 'cohere') return false
  return (
    decoding === 'timestamps' ||
    (options.ntVadPrompt ?? ntVadPromptForModel(options.speechModelId))
  )
}

/** The `-dl` run that detects the language before an auto-detect decode. */
export interface LanguageDetectionCommand {
  binary: string
  argv: string[]
  /** The JSON file it writes, with the language in `result.language`. */
  jsonPath: string
}

/**
 * The run that detects the spoken language before the decode, or `null` when the decode
 * needs none (ADR-0011).
 *
 * Under auto-detect the decode cannot take the dictation prompt as it is: Whisper writes the
 * prompt's language over the language it detected, so one prompt for every language turns the
 * other languages into it. So the adapter runs this first, then builds the decode with the
 * detected language pinned, and `dictationPrompt` picks the prompt for it. Detection is the
 * decode's own: one decision on the first 30 s of the speech, with the same VAD the
 * `timestamps` path uses, and it never sees a prompt. It costs a second model load, about
 * 0.6 s.
 *
 * `null` when `needsLanguageDetection` says the decode needs none.
 */
export async function buildLanguageDetectionCommand(
  options: WhisperHarnessCommandOptions,
  dependencies: WhisperHarnessCommandDependencies = DEFAULT_DEPENDENCIES
): Promise<LanguageDetectionCommand | null> {
  if (!needsLanguageDetection(options)) return null

  const binary = await dependencies.resolveBinary(
    options.harness ?? DEFAULT_ASR_HARNESS
  )
  const jsonOutputBase = `${options.jsonOutputBase}-language`
  return {
    binary,
    argv: [
      binary,
      '-m',
      options.modelPath,
      '-t',
      String(dependencies.threadCount()),
      '--language',
      'auto',
      '-f',
      options.audioPath,
      '--no-prints',
      '--vad',
      '-vm',
      dependencies.resolveVadModel(),
      '-vt',
      VAD_THRESHOLD,
      '-dl',
      '-ojf',
      '-of',
      jsonOutputBase,
    ],
    jsonPath: `${jsonOutputBase}.json`,
  }
}
