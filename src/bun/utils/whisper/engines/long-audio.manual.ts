/**
 * The long-audio check (ADR-0010): whether a Whisper Speech Model may decode without `-nt`.
 * Opt-in (`.manual.ts`, so `bun test` never discovers it): it spawns the real crispasr on
 * installed weights and reads the local benchmark datasets.
 *
 *   bun test ./src/bun/utils/whisper/engines/long-audio.manual.ts
 *
 * Test audio is built in a temp directory from `benchmarks/datasets`: LibriSpeech test-clean
 * and FLEURS `da_dk` utterances joined with 1 s of silence into 60 s and 5 min English, and
 * 2 min and 5 min Danish, plus about 90 s of each with the utterances' own silence trimmed and
 * 0.05 s between them, so the VAD finds no pause to split at (`*_continuous_90s`). With no
 * `CODICTATE_LONG_AUDIO_MODELS`, every installed curated Whisper Speech Model, Edda and hviske
 * runs through the crispasr Speech Engine Adapter, exactly as a Dictation or a File
 * Transcription would, so an `nt-vad` model decodes Codictate's own cuts (`--vad-import`,
 * issue #83). `CODICTATE_LONG_AUDIO_MODELS` (comma separated Speech Model ids) picks the run
 * instead, and may name any Whisper Speech Model, curated or not. Weights are looked for in
 * the app's models directory and `vendors/whisper`, plus any directory in
 * `CODICTATE_LONG_AUDIO_MODEL_DIRS` (path-delimiter separated). Missing datasets, crispasr or
 * weights skip with a message.
 *
 * Three knobs change the `nt-vad` decode, for measuring it (issue #83); unset, the run is the
 * app's:
 * - `CODICTATE_LONG_AUDIO_SLICE_SECONDS`: the slice cap, in seconds (the app cuts at 30).
 * - `CODICTATE_LONG_AUDIO_NT_BEAM=0`: greedy decoding instead of `-bs 5`.
 * - `CODICTATE_LONG_AUDIO_NT_PROMPT=0`: no dictation `--prompt`, whatever the Speech Model's
 *   `ntVadPrompt` says.
 * The printed table starts with the values the run used.
 *
 * Asserted per Speech Model:
 * - No utterance lost: at least 30% of each utterance's reference words heard, in order.
 * - On `nt-vad`, no words lost at a cut (issue #83). For each long clip, the slices the app
 *   cuts it into (the adapter's own `writeNtVadSlices`, with this run's slice cap), and at
 *   each cut every utterance whose speech the cut falls inside or within 0.3 s of, plus the
 *   utterances either side of it. Each of those is decoded alone, uncut (one slice), with the
 *   same model and argv, and both transcripts are aligned against its reference as the
 *   VAD-loss check below does. An utterance fails when the long run misses reference words
 *   where the solo decode wrote 3 or more words more, or loses its first or last word where
 *   the solo decode heard it and a cut is within 1 s of that end (one lost at the far end,
 *   inside a slice, is listed but does not fail). The 30% rule alone passes a cut that drops
 *   one clause. Only the clips with real pauses between utterances (`en_60s`, `en_5min`,
 *   `da_2min`, `da_5min`) fail on it. On the `*_continuous_90s` clips a loss is reported in
 *   the table ("reported, not gated: continuous clip") and fails nothing: their 0.05 s
 *   between sentences is under the planner's 98 ms pause minimum, so every cut there lands
 *   inside a sentence (decision 2026-10-18, an accepted limitation; overlapping slices are
 *   the follow-up only if a real dictation shows the loss).
 * - Short single clips within one word of the legacy `-nt` argv, spawned here by hand, or,
 *   when decoding variance moved more than a word, no worse against the reference.
 * - Danish: under 1% of letters outside the Latin script (Edda's failure without `-nt`).
 * - With a Timed Transcript: times in order and inside the audio (+0.5 s), every
 *   utterance's window overlaps a part, and no part of three words or more repeats the one
 *   before it (a decoding loop, which the heard share alone does not catch).
 * - Translate (every selected installed model with `translationSupport`, `-tr` on Danish):
 *   English; when timed, no utterance window without a part and no repeated parts.
 * - On the `timestamps` path, the VAD loses nothing (ADR-0011): 20 short LibriSpeech clips,
 *   and 10 FLEURS `da_dk` clips for a multilingual model, run with the app's argv and with
 *   the same argv minus `--vad -vm <path> -vt <x>`. Each transcript is aligned against the
 *   reference, and a clip fails when, where the VAD run misses reference words the other run
 *   heard, the VAD run has 3 or more words fewer, or the clip's first word is gone. A
 *   misheard stretch has about as many words either way, so it does not count.
 * - On the `timestamps` and `nt-vad` paths, no transcript repeats the dictation `--prompt`
 *   (four of its words in a row): without the VAD, small-q5_1 once wrote the Danish prompt out
 *   three times.
 * - Punctuation, printed for every long clip: sentence ends (`.`, `!`, `?`) and commas per 100
 *   words, with the reference's sentence ends beside them. On `nt-vad` a clip with real pauses
 *   fails when the reference has 4 or more sentence ends per 100 words and the transcript
 *   under 2. Only FLEURS references are punctuated (LibriSpeech's are upper case without
 *   punctuation), so in practice that gates `da_2min` and `da_5min`; English is printed, not
 *   judged. At a 20 s cap Edda wrote no full stop in a 65 s real dictation (ADR-0010).
 * - The local dictation, when `benchmarks/datasets/local/edda-dictation-da-65s.wav` exists:
 *   a real 65 s Danish dictation, private and never committed, so absent everywhere but the
 *   machine that recorded it and skipped without a word there. Every Danish-capable Speech
 *   Model transcribes it through the adapter, and fails when fewer than 4 sentence ends come
 *   out or any of `LOCAL_DICTATION_PHRASES` (one per sentence) is missing, case and
 *   punctuation ignored. Words, sentence ends and commas are printed.
 *
 * A table is printed at the end. A Speech Model gets `whisperDecoding: 'timestamps'` in
 * src/shared/speech-models.ts only after its rows pass here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import { computeWer, tokenizeForWer } from '../../../../../benchmarks/stt/wer'
import {
  pinnedTranscriptionLanguageId,
  SPEECH_MODELS,
  whisperDecodingForModel,
  type SpeechModel,
} from '../../../../shared/speech-models'
import type { TimedTranscript } from '../../../../shared/timed-transcript'
import { findBinary } from '../../../platform/binaries'
import { MODELS_DIR } from '../../../platform/runtime'
import {
  buildWhisperHarnessCommand,
  DICTATION_PROMPT,
} from '../whisper-harness-command'
import {
  transcribeWithCrispasrTuned,
  writeNtVadSlices,
  type NtVadTuning,
} from './crispasr-engine'
import { crispasrTranscript, parseCrispasrJson } from './crispasr-json'
import type { HarnessTranscriptionRequest } from './transcription'
import { DEFAULT_VAD_SLICE_OPTIONS, type VadSliceOptions } from './vad-slices'

const REPO = resolve(import.meta.dir, '../../../../..')
const DATASETS = join(REPO, 'benchmarks/datasets')
const LIBRISPEECH = join(DATASETS, 'librispeech')
const FLEURS_DA = join(DATASETS, 'fleurs/da_dk')
const SAMPLE_RATE = 16_000
const GAP_SECONDS = 1
/**
 * The continuous clips: utterances trimmed of their own silence and joined with 0.05 s, so
 * the VAD finds no pause and hands Whisper one long region. With `-nt`, 2026-10-17, large-v3
 * lost 29-60 s of the English one and Edda the last utterance of the Danish one. They start
 * at the recordings it was found on: which speech is lost moves with the audio, and another
 * recording of the first Danish sentence hid Edda's loss.
 */
const CONTINUOUS_GAP_SECONDS = 0.05
const CONTINUOUS_FROM = {
  en: '1320-122612-0000',
  da: '4524951591374662777',
} as const
const MAX_CLIP_SECONDS = 25
/**
 * Clips the VAD-loss check always runs, because the VAD lost speech on them at `-vt 0.35`
 * (ADR-0011): small and turbo clipped "Stuff it into you", and medium.en lost seven words.
 */
const VAD_LOSS_CLIPS = ['1089-134686-0001', '5764-299665-0017']
const VAD_LOSS_ENGLISH_CLIPS = 20
const VAD_LOSS_DANISH_CLIPS = 10
const VAD_LOSS_MAX_SECONDS = 20
const RUN_TIMEOUT_MS = 15 * 60_000
/** A cut this close to an utterance's speech counts as at that utterance. */
const CUT_MARGIN_SECONDS = 0.3
/**
 * An utterance's first word is at a cut when the cut is before its speech or less than this
 * into it, and its last word likewise at the other end.
 */
const CUT_EDGE_SECONDS = 1
/**
 * The solo decode of an utterance is one slice: no cap under Whisper's 30 s window (every
 * utterance is `MAX_CLIP_SECONDS` or less) and no pause long enough to end it.
 */
const SOLO_SLICE_OPTIONS: Partial<VadSliceOptions> = {
  maxSliceSeconds: 30,
  maxMergeGapMs: 30_000,
}
/**
 * The punctuation gate on `nt-vad`, per 100 words: a transcript under `minSentenceEnds` fails
 * where the reference has `referenceSentenceEnds` or more (FLEURS has about 5).
 */
const PUNCTUATION_GATE = { minSentenceEnds: 2, referenceSentenceEnds: 4 }
/** A real dictation (see the header). Never committed. */
const LOCAL_DICTATION = join(DATASETS, 'local/edda-dictation-da-65s.wav')
/**
 * What the local dictation must keep, one phrase from each of four sentences. "mangler penge"
 * ends the sentence Edda lost when it stopped early in a 12 s slice at the 20 s cap. The
 * third sentence ends in the show's name, "Bruxellesboblen", which Edda writes and every
 * stock model misspells whatever the cap or prompt ("Bruxellesbubblen", "Brusselboblen",
 * "Brusselbomberlen", 2026-10-18), so the words before it stand for that sentence.
 */
const LOCAL_DICTATION_PHRASES = [
  'mangler penge',
  'mette frederiksen',
  'denne uges udgave af',
  'økonomiske problemer',
]
const LOCAL_DICTATION_MIN_SENTENCE_ENDS = 4

/** The `nt-vad` knobs from the environment (see the header). */
function ntVadTuning(): NtVadTuning {
  const sliceSeconds = process.env.CODICTATE_LONG_AUDIO_SLICE_SECONDS
  const maxSliceSeconds =
    sliceSeconds === undefined || sliceSeconds === ''
      ? undefined
      : Number(sliceSeconds)
  if (
    maxSliceSeconds !== undefined &&
    !(Number.isFinite(maxSliceSeconds) && maxSliceSeconds > 0)
  )
    throw new Error(
      `CODICTATE_LONG_AUDIO_SLICE_SECONDS is not a positive number: ${sliceSeconds}`
    )
  return {
    sliceOptions:
      maxSliceSeconds === undefined ? undefined : { maxSliceSeconds },
    beamSearch: process.env.CODICTATE_LONG_AUDIO_NT_BEAM !== '0',
    prompt:
      process.env.CODICTATE_LONG_AUDIO_NT_PROMPT === '0' ? false : undefined,
  }
}

const NT_VAD_TUNING = ntVadTuning()

/** One run through the crispasr adapter, with the `nt-vad` knobs. */
function transcribe(request: HarnessTranscriptionRequest) {
  return transcribeWithCrispasrTuned(request, NT_VAD_TUNING)
}

type Lang = 'en' | 'da'

interface Utterance {
  wav: string
  text: string
}

interface Window {
  text: string
  start: number
  end: number
  /** The utterance's speech, without its own leading and trailing silence. */
  speechStart: number
  speechEnd: number
  /** The utterance's WAV in the dataset. */
  source: string
}

interface LongClip {
  name: string
  lang: Lang
  path: string
  seconds: number
  windows: Window[]
  /** Each utterance had its own silence cut off. */
  trimmed: boolean
  /** Silence between two utterances. */
  gapSeconds: number
}

/** Where the app cut a long clip on `nt-vad`, in seconds. */
interface Cut {
  /** The end of the slice before the cut. */
  from: number
  /** The start of the slice after it: `from` when the slices meet. */
  to: number
}

interface CutLoss {
  model: string
  clip: string
  /** The loss fails the model (`cutLossGated`). */
  gated: boolean
  cut: string
  utterance: string
  /** Where the cut sits relative to the utterance's speech. */
  position: string
  soloHeard: number
  cutHeard: number
  words: number
  missing: string
}

interface ShortClip {
  name: string
  lang: Lang
  path: string
  text: string
}

interface Row {
  model: string
  clip: string
  decoding: string
  seconds: number
  wallSeconds: number
  heard: number
  lost: string[]
  nonLatin: number | null
  parts: number | null
  timesOk: boolean | null
  windowsCovered: string
  /** Parts of three words or more that repeat the part before them: a decoding loop. */
  repeats: number | null
  /** Per 100 words of the transcript. */
  sentenceEnds: number
  commas: number
  /** Per 100 words of the reference, or `null` without one (translate). */
  referenceSentenceEnds: number | null
  note: string
}

const rows: Row[] = []
const vadLossRows: VadLoss[] = []
const vadChecked: { model: string; clips: number; flagged: number }[] = []
const promptEchoes: { model: string; clip: string; phrase: string }[] = []
const localDictationRows: {
  model: string
  decoding: string
  wallSeconds: number
  words: number
  sentenceEnds: number
  commas: number
  missing: string[]
}[] = []
const cutLossRows: CutLoss[] = []
const cutChecked: {
  model: string
  cuts: number
  utterances: number
  flagged: number
  reported: number
}[] = []
/** Each long clip's `nt-vad` transcript, by `model|clip`, for the cut-loss check. */
const longTranscripts = new Map<string, string>()
const parity: {
  model: string
  clip: string
  diff: number
  legacyErrors: number
  newErrors: number
}[] = []

/** Word edits between two transcripts (substitutions, insertions and deletions). */
function wordEdits(reference: string, hypothesis: string): number {
  const ops = computeWer(reference, hypothesis)
  return ops.substitutions + ops.insertions + ops.deletions
}

// -- WAV ------------------------------------------------------------------------------

/** 16 kHz mono samples as int16, from a PCM16 or float32 WAV. `null` for anything else. */
function readWavSamples(path: string): Int16Array | null {
  const buf = readFileSync(path)
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null
  let offset = 12
  let format = 0
  let channels = 0
  let rate = 0
  let bits = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24)
    } else if (id === 'data') {
      if (channels !== 1 || rate !== SAMPLE_RATE) return null
      const end = Math.min(buf.length, body + size)
      if (format === 1 && bits === 16) {
        const out = new Int16Array((end - body) >> 1)
        for (let i = 0; i < out.length; i += 1)
          out[i] = buf.readInt16LE(body + i * 2)
        return out
      }
      if (format === 3 && bits === 32) {
        const out = new Int16Array((end - body) >> 2)
        for (let i = 0; i < out.length; i += 1) {
          const v = Math.max(-1, Math.min(1, buf.readFloatLE(body + i * 4)))
          out[i] = Math.round(v * 32767)
        }
        return out
      }
      return null
    }
    offset = body + size + (size & 1)
  }
  return null
}

/**
 * A WAV's length from its size and the bits per sample in its header, without reading the
 * samples: 16 kHz mono with `fmt ` first, as both datasets are. Close enough to pick short
 * clips from a pool of thousands.
 */
function wavSeconds(path: string): number {
  const header = Buffer.alloc(36)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, header, 0, 36, 0)
  } finally {
    closeSync(fd)
  }
  const bytesPerSample = Math.max(1, header.readUInt16LE(34) / 8)
  return statSync(path).size / (SAMPLE_RATE * bytesPerSample)
}

function writeWav(path: string, samples: Int16Array): void {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples.length * 2, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length * 2, 40)
  writeFileSync(
    path,
    Buffer.concat([
      header,
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    ])
  )
}

/**
 * Where the speech is, in samples (`end` exclusive): the samples without their leading and
 * trailing 20 ms frames quieter than 2% of the loudest frame.
 */
function speechBounds(samples: Int16Array): { start: number; end: number } {
  const frame = SAMPLE_RATE / 50
  const rms: number[] = []
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let energy = 0
    for (let j = i; j < i + frame; j += 1) energy += samples[j] * samples[j]
    rms.push(Math.sqrt(energy / frame))
  }
  const quiet = Math.max(0, ...rms) * 0.02
  let first = 0
  let last = rms.length - 1
  while (first < last && rms[first] < quiet) first += 1
  while (last > first && rms[last] < quiet) last -= 1
  return { start: first * frame, end: (last + 1) * frame }
}

function trimSilence(samples: Int16Array): Int16Array {
  const { start, end } = speechBounds(samples)
  return samples.slice(start, end)
}

/**
 * Utterances joined with `gapSeconds` of silence (1 s by default) until `targetSeconds`, and
 * where each one sits. `trim` cuts each utterance's own leading and trailing silence first.
 */
function buildLongClip(
  dir: string,
  name: string,
  lang: Lang,
  pool: readonly Utterance[],
  targetSeconds: number,
  { gapSeconds = GAP_SECONDS, trim = false } = {}
): LongClip {
  const pieces: Int16Array[] = []
  const windows: Window[] = []
  const gap = new Int16Array(Math.round(gapSeconds * SAMPLE_RATE))
  let at = 0
  for (const utterance of pool) {
    const read = readWavSamples(utterance.wav)
    if (read === null) continue
    const samples = trim ? trimSilence(read) : read
    const seconds = samples.length / SAMPLE_RATE
    if (seconds > MAX_CLIP_SECONDS || at + seconds > targetSeconds * 1.05)
      continue
    if (pieces.length > 0) {
      pieces.push(gap)
      at += gap.length / SAMPLE_RATE
    }
    pieces.push(samples)
    const speech = speechBounds(samples)
    windows.push({
      text: utterance.text,
      start: at,
      end: at + seconds,
      speechStart: at + speech.start / SAMPLE_RATE,
      speechEnd: at + speech.end / SAMPLE_RATE,
      source: utterance.wav,
    })
    at += seconds
    if (at >= targetSeconds * 0.95) break
  }
  const all = new Int16Array(pieces.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of pieces) {
    all.set(p, o)
    o += p.length
  }
  const path = join(dir, `${name}.wav`)
  writeWav(path, all)
  return {
    name,
    lang,
    path,
    seconds: all.length / SAMPLE_RATE,
    windows,
    trimmed: trim,
    gapSeconds,
  }
}

// -- Datasets -------------------------------------------------------------------------

function librispeechPool(
  subset: 'test-clean' | 'test-other' = 'test-clean'
): Utterance[] {
  const text = new Map<string, string>()
  const root = join(LIBRISPEECH, subset)
  for (const speaker of readdirSync(root).sort()) {
    const speakerDir = join(root, speaker)
    for (const chapter of readdirSync(speakerDir).sort()) {
      const trans = join(speakerDir, chapter, `${speaker}-${chapter}.trans.txt`)
      if (!existsSync(trans)) continue
      for (const line of readFileSync(trans, 'utf8').split('\n')) {
        const space = line.indexOf(' ')
        if (space > 0)
          text.set(line.slice(0, space), line.slice(space + 1).trim())
      }
    }
  }
  const wavDir = join(LIBRISPEECH, 'wav', subset)
  return [...text.keys()]
    .sort()
    .filter((id) => existsSync(join(wavDir, `${id}.wav`)))
    .map((id) => ({ wav: join(wavDir, `${id}.wav`), text: text.get(id)! }))
}

/** One recording per sentence, in `test.tsv` order; with `fromFile`, from that recording on. */
function fleursDanishPool(fromFile?: string): Utterance[] {
  const seen = new Set<string>()
  const out: Utterance[] = []
  const lines = readFileSync(join(FLEURS_DA, 'test.tsv'), 'utf8').split('\n')
  const from =
    fromFile === undefined
      ? 0
      : Math.max(
          0,
          lines.findIndex((line) => line.split('\t')[1] === `${fromFile}.wav`)
        )
  for (const line of lines.slice(from)) {
    const [sentenceId, file, text] = line.split('\t')
    if (!file || !text || seen.has(sentenceId) || seen.has(file)) continue
    seen.add(sentenceId)
    seen.add(file)
    const wav = join(FLEURS_DA, 'audio/test', file)
    if (existsSync(wav)) out.push({ wav, text })
  }
  return out
}

// -- Scoring --------------------------------------------------------------------------

/** For each window, the share of its reference words heard, in order, in `hypothesis`. */
function heardPerWindow(
  windows: readonly Window[],
  hypothesis: string
): number[] {
  const ref: { word: string; window: number }[] = []
  windows.forEach((w, index) => {
    for (const word of tokenizeForWer(w.text)) ref.push({ word, window: index })
  })
  const hyp = tokenizeForWer(hypothesis)
  const n = ref.length
  const m = hyp.length
  const width = m + 1
  const d = new Uint32Array((n + 1) * width)
  for (let i = 0; i <= n; i += 1) d[i * width] = i
  for (let j = 0; j <= m; j += 1) d[j] = j
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sub =
        d[(i - 1) * width + j - 1] + (ref[i - 1].word === hyp[j - 1] ? 0 : 1)
      d[i * width + j] = Math.min(
        d[(i - 1) * width + j] + 1,
        d[i * width + j - 1] + 1,
        sub
      )
    }
  }
  const hits = windows.map(() => 0)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const same = ref[i - 1].word === hyp[j - 1]
    if (d[i * width + j] === d[(i - 1) * width + j - 1] + (same ? 0 : 1)) {
      if (same) hits[ref[i - 1].window] += 1
      i -= 1
      j -= 1
    } else if (d[i * width + j] === d[(i - 1) * width + j] + 1) i -= 1
    else j -= 1
  }
  return windows.map((w, index) => {
    const words = tokenizeForWer(w.text).length
    return words === 0 ? 1 : hits[index] / words
  })
}

/**
 * Words, sentence ends and commas in a text. A sentence end is a run of `.`, `!` and `?`, and
 * a comma a `,`, before whitespace, a closing quote or bracket, or the end: "4.5" and "4,5"
 * are numbers, not punctuation.
 */
function punctuation(text: string): {
  words: number
  sentenceEnds: number
  commas: number
} {
  return {
    words: tokenizeForWer(text).length,
    sentenceEnds: (text.match(/[.!?]+(?=["'”»)\]]*(?:\s|$))/gu) ?? []).length,
    commas: (text.match(/,(?=["'”»)\]]*(?:\s|$))/gu) ?? []).length,
  }
}

function per100(count: number, words: number): number {
  return words === 0 ? 0 : (count * 100) / words
}

/** The phrases of `LOCAL_DICTATION_PHRASES` the transcript lacks, case and punctuation ignored. */
function missingPhrases(transcript: string): string[] {
  const text = ` ${tokenizeForWer(transcript).join(' ')} `
  return LOCAL_DICTATION_PHRASES.filter(
    (phrase) => !text.includes(` ${tokenizeForWer(phrase).join(' ')} `)
  )
}

function nonLatinShare(text: string): number {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch))
  if (letters.length === 0) return 0
  return (
    letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length /
    letters.length
  )
}

function timesInOrder(t: TimedTranscript, seconds: number): boolean {
  return t.parts.every(
    (p, i) =>
      p.start >= 0 &&
      p.end <= seconds + 0.5 &&
      p.start <= p.end &&
      (i === 0 || p.start >= t.parts[i - 1].start)
  )
}

function repeatedParts(t: TimedTranscript): number {
  const texts = t.parts.map((p) => tokenizeForWer(p.text).join(' '))
  return texts.filter(
    (text, i) => i > 0 && text === texts[i - 1] && text.split(' ').length >= 3
  ).length
}

function uncoveredWindows(
  t: TimedTranscript,
  windows: readonly Window[]
): number[] {
  return windows
    .map((w, index) => ({ w, index }))
    .filter(({ w }) => !t.parts.some((p) => p.start < w.end && p.end > w.start))
    .map(({ index }) => index)
}

const ENGLISH_WORDS = new Set(
  'the a an and of to in is was it that he she they we you i his her for on with as at by be this are from or had not but'.split(
    ' '
  )
)
const DANISH_WORDS = new Set(
  'og i at det er en til på som de med af for ikke der var han hun den et har kan vil om fra'.split(
    ' '
  )
)

function shareOf(words: readonly string[], set: Set<string>): number {
  return words.length === 0
    ? 0
    : words.filter((w) => set.has(w)).length / words.length
}

interface Alignment {
  /** Per reference word: matched by a hypothesis word. */
  heard: boolean[]
  /**
   * Per hypothesis word, the reference position it sits at: the word it matches or
   * replaces, or, for an inserted word, half a step before the next reference word.
   */
  at: number[]
}

/** A minimum-edit alignment of the hypothesis words against the reference words. */
function alignWords(ref: readonly string[], hyp: readonly string[]): Alignment {
  const n = ref.length
  const m = hyp.length
  const width = m + 1
  const d = new Uint32Array((n + 1) * width)
  for (let i = 0; i <= n; i += 1) d[i * width] = i
  for (let j = 0; j <= m; j += 1) d[j] = j
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sub =
        d[(i - 1) * width + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      d[i * width + j] = Math.min(
        d[(i - 1) * width + j] + 1,
        d[i * width + j - 1] + 1,
        sub
      )
    }
  }
  const heard = ref.map(() => false)
  const at = hyp.map(() => 0)
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const same = i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]
    if (
      i > 0 &&
      j > 0 &&
      d[i * width + j] === d[(i - 1) * width + j - 1] + (same ? 0 : 1)
    ) {
      heard[i - 1] = same
      at[j - 1] = i - 1
      i -= 1
      j -= 1
    } else if (i > 0 && d[i * width + j] === d[(i - 1) * width + j] + 1) {
      i -= 1
    } else {
      at[j - 1] = i - 0.5
      j -= 1
    }
  }
  return { heard, at }
}

interface VadLoss {
  model: string
  clip: string
  /** The reference words the VAD run lost. */
  missing: string
  withoutVad: string
  withVad: string
}

/**
 * The stretches of reference words a run lost against a baseline run, both aligned against
 * `ref`, as text. A stretch is a run of reference words the run did not hear; it counts as
 * lost when the baseline wrote 3 or more words more there, or when it holds the first word
 * (with `firstWord`, the default) or the last word (with `lastWord`), the baseline heard that
 * word, and wrote more words there. A misheard stretch ("ved at give" as "når jeg giver") has
 * about as many words either way and does not count.
 */
function lostStretches(
  ref: readonly string[],
  baseline: Alignment,
  run: Alignment,
  { firstWord = true, lastWord = false } = {}
): string[] {
  const wordsIn = (a: Alignment, from: number, to: number) =>
    a.at.filter((p) => p >= from && p <= to).length
  const end = ref.length - 1
  const losses: string[] = []
  let from = 0
  while (from < ref.length) {
    if (run.heard[from]) {
      from += 1
      continue
    }
    let to = from
    while (to + 1 < ref.length && !run.heard[to + 1]) to += 1
    const drop = wordsIn(baseline, from, to) - wordsIn(run, from, to)
    const edgeGone =
      drop >= 1 &&
      ((firstWord && from === 0 && baseline.heard[0]) ||
        (lastWord && to === end && baseline.heard[end]))
    if (drop >= 3 || edgeGone) losses.push(ref.slice(from, to + 1).join(' '))
    from = to + 1
  }
  return losses
}

/** The stretches of reference words the VAD run lost against the same argv without it. */
function vadLosses(
  reference: string,
  withoutVad: string,
  withVad: string
): string[] {
  const ref = tokenizeForWer(reference)
  return lostStretches(
    ref,
    alignWords(ref, tokenizeForWer(withoutVad)),
    alignWords(ref, tokenizeForWer(withVad))
  )
}

/** Every four words in a row of each dictation prompt, normalised like the transcripts. */
const PROMPT_PHRASES = Object.values(DICTATION_PROMPT).flatMap((prompt) => {
  const words = tokenizeForWer(prompt)
  return words.slice(0, -3).map((_, i) => words.slice(i, i + 4).join(' '))
})

/** The dictation prompt phrase the transcript repeats, or `null`. */
function echoedPrompt(transcript: string): string | null {
  const text = ` ${tokenizeForWer(transcript).join(' ')} `
  return PROMPT_PHRASES.find((phrase) => text.includes(` ${phrase} `)) ?? null
}

// -- Speech Models -------------------------------------------------------------------

interface InstalledModel {
  model: SpeechModel
  path: string
  langs: Lang[]
  pinnedLanguage: string | null
}

function modelDirs(): string[] {
  const extra = (process.env.CODICTATE_LONG_AUDIO_MODEL_DIRS ?? '')
    .split(delimiter)
    .filter(Boolean)
  return [MODELS_DIR, join(REPO, 'vendors/whisper'), ...extra]
}

function installedModels(): InstalledModel[] {
  const only = (process.env.CODICTATE_LONG_AUDIO_MODELS ?? '')
    .split(',')
    .filter(Boolean)
  const out: InstalledModel[] = []
  for (const model of SPEECH_MODELS) {
    const isEdda = model.id.startsWith('edda-')
    const isHviske = model.engine === 'hviske'
    const isWhisper = model.engine === 'whisper_cpp'
    // Named models may be any Whisper one, so a browse-only model can be checked before it
    // gets `whisperDecoding: 'timestamps'`. Without names, the curated set.
    const selected =
      only.length > 0
        ? only.includes(model.id) && (isWhisper || isHviske)
        : isHviske || isEdda || (isWhisper && model.curated)
    if (!selected) continue
    const path = modelDirs()
      .map((dir) => join(dir, model.artifactName))
      .find((candidate) => existsSync(candidate))
    if (path === undefined) continue
    const danishOnly = isEdda || isHviske
    const englishOnly = model.id.includes('.en')
    out.push({
      model,
      path,
      langs: danishOnly ? ['da'] : englishOnly ? ['en'] : ['en', 'da'],
      pinnedLanguage: pinnedTranscriptionLanguageId(model.id),
    })
  }
  return out
}

function request(
  installed: InstalledModel,
  audioPath: string,
  lang: Lang,
  translateToEnglish = false
): HarnessTranscriptionRequest {
  const { model } = installed
  return {
    engineId: model.engine as HarnessTranscriptionRequest['engineId'],
    speechModelId: model.id,
    audioPath,
    timeoutMs: RUN_TIMEOUT_MS,
    modelPath: installed.path,
    languageCode: installed.pinnedLanguage ?? lang,
    translateToEnglish,
    crispasrBackend: model.engine === 'hviske' ? 'cohere' : null,
  }
}

function decodingOf(installed: InstalledModel): string {
  return installed.model.engine === 'hviske'
    ? 'cohere'
    : (whisperDecodingForModel(installed.model.id) ?? 'nt-vad')
}

/**
 * One `timestamps` run, spawned here so the argv can be changed: the app's argv as
 * `buildWhisperHarnessCommand` makes it, or, with `withoutVad`, the same minus
 * `--vad -vm <path> -vt <x>`. Returns the Raw Transcript.
 */
async function timestampsTranscript(
  installed: InstalledModel,
  audioPath: string,
  lang: Lang,
  outputBase: string,
  withoutVad: boolean
): Promise<string> {
  const command = await buildWhisperHarnessCommand({
    speechModelId: installed.model.id,
    modelPath: installed.path,
    language: installed.pinnedLanguage ?? lang,
    audioPath,
    jsonOutputBase: outputBase,
  })
  let argv = command.argv
  if (withoutVad) {
    const vadAt = argv.indexOf('--vad')
    const vmAt = argv.indexOf('-vm')
    const vtAt = argv.indexOf('-vt')
    if (vadAt === -1 || vmAt === -1 || vtAt === -1)
      throw new Error(
        `no --vad -vm -vt in the timestamps argv: ${argv.join(' ')}`
      )
    const drop = new Set([vadAt, vmAt, vmAt + 1, vtAt, vtAt + 1])
    argv = argv.filter((_, i) => !drop.has(i))
  }
  // The same UTF-8 locale `transcribeWithCrispasr` spawns with.
  const proc = Bun.spawnSync(argv, {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
  })
  if (proc.exitCode !== 0)
    throw new Error(
      `${withoutVad ? 'no-VAD' : 'app'} argv exited ${proc.exitCode}`
    )
  if (!existsSync(command.jsonPath)) {
    if (new TextDecoder().decode(proc.stderr).includes('no speech detected'))
      return ''
    throw new Error(`no JSON at ${command.jsonPath}`)
  }
  const parsed = parseCrispasrJson(
    new Uint8Array(readFileSync(command.jsonPath))
  )
  if (!parsed.ok) throw new Error(parsed.detail)
  return crispasrTranscript(parsed, command.decoding).rawTranscript
}

/** `count` items spread evenly over `pool`. */
function spread<T>(pool: readonly T[], count: number): T[] {
  if (pool.length <= count) return [...pool]
  return Array.from(
    { length: count },
    (_, i) => pool[Math.floor((i * pool.length) / count)]
  )
}

/** The argv every crispasr run used before ADR-0010, for the short-clip comparison. */
function legacyTranscript(
  binary: string,
  installed: InstalledModel,
  clip: ShortClip
): string {
  const argv = [binary]
  if (installed.model.engine === 'hviske') argv.push('--backend', 'cohere')
  argv.push(
    '-m',
    installed.path,
    '-t',
    '8',
    '--language',
    installed.pinnedLanguage ?? clip.lang,
    '-f',
    clip.path,
    '--no-prints',
    '-nt'
  )
  const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'ignore' })
  if (proc.exitCode !== 0)
    throw new Error(`legacy argv exited ${proc.exitCode}`)
  return new TextDecoder().decode(proc.stdout).trim()
}

// -- Suite ----------------------------------------------------------------------------

const crispasr = findBinary('crispasr')
const vad = findBinary('silero-vad')
const datasetsPresent =
  existsSync(join(LIBRISPEECH, 'wav/test-clean')) &&
  existsSync(join(FLEURS_DA, 'test.tsv'))
const models = datasetsPresent && crispasr !== null ? installedModels() : []
const skipReason =
  crispasr === null
    ? 'crispasr is not vendored: run `bun run scripts/pre-build.ts --crispasr-only`'
    : vad === null
      ? 'Silero VAD is not vendored: run `bun run scripts/pre-build.ts --crispasr-only`'
      : !datasetsPresent
        ? `benchmark datasets missing under ${DATASETS}`
        : models.length === 0
          ? 'no curated Whisper, Edda or hviske weights installed'
          : null
if (skipReason !== null) console.warn(`[long-audio] skipped: ${skipReason}`)

let dir = ''
const longClips: LongClip[] = []
const shortClips: ShortClip[] = []
/** Single utterances for the VAD-loss check: English, then Danish. */
const vadClips: ShortClip[] = []

/** A clip of one utterance, or `null` when it is unreadable or too long. */
function singleClip(
  name: string,
  lang: Lang,
  utterance: Utterance
): ShortClip | null {
  const clip = buildLongClip(dir, name, lang, [utterance], MAX_CLIP_SECONDS)
  return clip.windows.length === 1
    ? { name, lang, path: clip.path, text: utterance.text }
    : null
}

/**
 * Fails, and records, a transcript on a Whisper path (`timestamps` or `nt-vad`, both of which
 * pass the dictation prompt) that writes the prompt back out.
 */
function checkPromptEcho(
  installed: InstalledModel,
  clip: string,
  transcript: string,
  failures: string[]
): void {
  if (decodingOf(installed) === 'cohere') return
  const phrase = echoedPrompt(transcript)
  if (phrase === null) return
  promptEchoes.push({ model: installed.model.id, clip, phrase })
  failures.push(`${clip}: repeats the prompt ("${phrase}")`)
}

// -- Cut loss (nt-vad) ----------------------------------------------------------------

const clipCuts = new Map<string, { clip: LongClip; cuts: Cut[] }>()
const clipSamples = new Map<string, Int16Array>()
/** Each utterance's own audio as a WAV, by `soloAudioKey`. */
const soloWavs = new Map<string, string>()
/** Solo decodes, by `model|soloAudioKey`. */
const soloTranscripts = new Map<string, string>()

/**
 * Where the app cuts `clip` on `nt-vad`: the adapter's own `writeNtVadSlices` with this run's
 * slice options, read back from the `--vad-import` file it writes.
 */
function cutsOf(clip: LongClip): Cut[] {
  const known = clipCuts.get(clip.name)
  if (known !== undefined) return known.cuts
  const path = join(dir, `${clip.name}-slices.json`)
  const slicing = writeNtVadSlices(clip.path, path, NT_VAD_TUNING.sliceOptions)
  if (slicing.status !== 'written')
    throw new Error(`${clip.name}: no slices (${slicing.status})`)
  const { slices } = (
    JSON.parse(readFileSync(path, 'utf8')) as {
      crispasr_vad: { slices: { start: number; end: number }[] }
    }
  ).crispasr_vad
  const cuts = slices.slice(1).map((slice, i) => ({
    from: slices[i].end / SAMPLE_RATE,
    to: slice.start / SAMPLE_RATE,
  }))
  clipCuts.set(clip.name, { clip, cuts })
  return cuts
}

/**
 * Whether words lost at a cut in `clip` fail the model. Not where the clip has no pause
 * between utterances the planner counts (the continuous clips' 0.05 s against its 98 ms
 * minimum): every cut there must land inside a sentence. Decided 2026-10-18 (issue #83) as an
 * accepted limitation, with overlapping slices the follow-up only if a real dictation shows
 * the loss. Those losses are reported, not gated.
 */
function cutLossGated(clip: LongClip): boolean {
  return hasPauses(clip)
}

/** Whether the clip's gaps between utterances are pauses the planner counts. */
function hasPauses(clip: LongClip): boolean {
  return clip.gapSeconds * 1000 >= DEFAULT_VAD_SLICE_OPTIONS.minPauseMs
}

function cutLabel(cut: Cut): string {
  return cut.to - cut.from < 0.005
    ? `${cut.from.toFixed(2)} s`
    : `${cut.from.toFixed(2)}-${cut.to.toFixed(2)} s`
}

/** The utterance whose speech the middle of the cut falls inside, or -1 between two. */
function utteranceCut(clip: LongClip, cut: Cut): number {
  const middle = (cut.from + cut.to) / 2
  return clip.windows.findIndex(
    (w) => w.speechStart < middle && middle < w.speechEnd
  )
}

/** Where the middle of the cut sits relative to an utterance's speech. */
function cutPosition(w: Window, cut: Cut): string {
  const middle = (cut.from + cut.to) / 2
  if (middle <= w.speechStart)
    return `${(w.speechStart - middle).toFixed(2)} s before it`
  if (middle >= w.speechEnd)
    return `${(middle - w.speechEnd).toFixed(2)} s after it`
  return `inside, ${(middle - w.speechStart).toFixed(1)} s into ${(w.speechEnd - w.speechStart).toFixed(1)} s`
}

/**
 * The utterances a cut can cost words in: each one whose speech the cut falls inside or
 * within `CUT_MARGIN_SECONDS` of, and the ones either side of it.
 */
function utterancesAtCut(clip: LongClip, cut: Cut): number[] {
  const at = new Set<number>()
  let before = -1
  clip.windows.forEach((w, i) => {
    if (
      w.speechStart < cut.to + CUT_MARGIN_SECONDS &&
      w.speechEnd > cut.from - CUT_MARGIN_SECONDS
    )
      at.add(i)
    if (w.speechStart < cut.from) before = i
  })
  const after = clip.windows.findIndex((w) => w.speechEnd > cut.to)
  if (before !== -1) at.add(before)
  if (after !== -1) at.add(after)
  return [...at].sort((a, b) => a - b)
}

function soloAudioKey(clip: LongClip, w: Window): string {
  return `${w.source}|${clip.trimmed ? 'trimmed' : 'whole'}`
}

/**
 * Utterance `index` of `clip` decoded alone and uncut through the adapter: its own audio, the
 * same Speech Model and argv, one slice. Cached per Speech Model and utterance audio, which
 * `en_60s` and `en_5min` (and the two Danish clips) share.
 */
async function soloTranscript(
  installed: InstalledModel,
  clip: LongClip,
  index: number
): Promise<string> {
  const w = clip.windows[index]
  const audioKey = soloAudioKey(clip, w)
  const key = `${installed.model.id}|${audioKey}`
  const known = soloTranscripts.get(key)
  if (known !== undefined) return known
  let wav = soloWavs.get(audioKey)
  if (wav === undefined) {
    let samples = clipSamples.get(clip.name)
    if (samples === undefined) {
      const read = readWavSamples(clip.path)
      if (read === null) throw new Error(`${clip.name}: unreadable WAV`)
      samples = read
      clipSamples.set(clip.name, samples)
    }
    wav = join(dir, `solo-${soloWavs.size}.wav`)
    writeWav(
      wav,
      samples.slice(
        Math.round(w.start * SAMPLE_RATE),
        Math.round(w.end * SAMPLE_RATE)
      )
    )
    soloWavs.set(audioKey, wav)
  }
  const result = await transcribeWithCrispasrTuned(
    request(installed, wav, clip.lang),
    {
      ...NT_VAD_TUNING,
      sliceOptions: { ...NT_VAD_TUNING.sliceOptions, ...SOLO_SLICE_OPTIONS },
    }
  )
  if (result.status !== 'ok')
    throw new Error(
      `solo decode of ${basename(w.source)}: ${result.reason} ${result.diagnostic ?? ''}`
    )
  soloTranscripts.set(key, result.rawTranscript)
  return result.rawTranscript
}

beforeAll(() => {
  if (skipReason !== null) return
  dir = mkdtempSync(join(tmpdir(), 'codictate-long-audio-'))
  const en = librispeechPool()
  const da = fleursDanishPool()
  longClips.push(
    buildLongClip(dir, 'en_60s', 'en', en, 60),
    buildLongClip(dir, 'en_5min', 'en', en, 300),
    buildLongClip(dir, 'da_2min', 'da', da, 120),
    buildLongClip(dir, 'da_5min', 'da', da, 300)
  )
  const enFrom = en.findIndex(
    (u) => basename(u.wav, '.wav') === CONTINUOUS_FROM.en
  )
  for (const [lang, pool] of [
    ['en', en.slice(Math.max(0, enFrom))],
    ['da', fleursDanishPool(CONTINUOUS_FROM.da)],
  ] as const) {
    longClips.push(
      buildLongClip(dir, `${lang}_continuous_90s`, lang, pool, 90, {
        gapSeconds: CONTINUOUS_GAP_SECONDS,
        trim: true,
      })
    )
  }
  for (const [lang, pool] of [
    ['en', en],
    ['da', da],
  ] as const) {
    for (const [index, utterance] of pool.slice(0, 3).entries()) {
      const clip = buildLongClip(
        dir,
        `${lang}_short_${index}`,
        lang,
        [utterance],
        30
      )
      shortClips.push({
        name: clip.name,
        lang,
        path: clip.path,
        text: utterance.text,
      })
    }
  }

  const clean = en
  const other = librispeechPool('test-other')
  const idOf = (u: Utterance) => basename(u.wav, '.wav')
  const forced = [...clean, ...other].filter((u) =>
    VAD_LOSS_CLIPS.includes(idOf(u))
  )
  const short = (u: Utterance) => wavSeconds(u.wav) < VAD_LOSS_MAX_SECONDS
  const rest = (pool: Utterance[]) =>
    pool.filter((u) => !VAD_LOSS_CLIPS.includes(idOf(u)) && short(u))
  const perSubset = (VAD_LOSS_ENGLISH_CLIPS - forced.length) / 2
  for (const utterance of [
    ...forced,
    ...spread(rest(clean), Math.ceil(perSubset)),
    ...spread(rest(other), Math.floor(perSubset)),
  ]) {
    const clip = singleClip(`en_${idOf(utterance)}`, 'en', utterance)
    if (clip !== null) vadClips.push(clip)
  }
  for (const utterance of spread(da.filter(short), VAD_LOSS_DANISH_CLIPS)) {
    const clip = singleClip(
      `da_${basename(utterance.wav, '.wav')}`,
      'da',
      utterance
    )
    if (clip !== null) vadClips.push(clip)
  }
}, 120_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  if (rows.length === 0) return
  const lines = [
    '| Speech Model | Clip | Decoding | Audio s | Wall s | Heard | Lost utterances | Stops/100 (ref) | Commas/100 | Non-Latin | Parts | Repeats | Times | Windows covered | Note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.model} | ${r.clip} | ${r.decoding} | ${r.seconds.toFixed(0)} | ${r.wallSeconds.toFixed(1)} | ${Number.isNaN(r.heard) ? '-' : `${(r.heard * 100).toFixed(0)}%`} | ${r.lost.length === 0 ? 'none' : r.lost.join(', ')} | ${r.sentenceEnds.toFixed(1)}${r.referenceSentenceEnds === null ? '' : ` (${r.referenceSentenceEnds.toFixed(1)})`} | ${r.commas.toFixed(1)} | ${r.nonLatin === null ? '-' : `${(r.nonLatin * 100).toFixed(2)}%`} | ${r.parts ?? '-'} | ${r.repeats ?? '-'} | ${r.timesOk === null ? '-' : r.timesOk ? 'ok' : 'BAD'} | ${r.windowsCovered} | ${r.note} |`
    ),
  ]
  const parityLines = [
    '',
    '| Speech Model | Short clip | Words different from legacy `-nt` | Word errors legacy | Word errors new |',
    '|---|---|---|---|---|',
    ...parity.map(
      (p) =>
        `| ${p.model} | ${p.clip} | ${p.diff} | ${p.legacyErrors} | ${p.newErrors} |`
    ),
  ]
  const vadLines = [
    '',
    '| Speech Model | VAD-loss clips | Clips where the VAD lost speech |',
    '|---|---|---|',
    ...vadChecked.map((v) => `| ${v.model} | ${v.clips} | ${v.flagged} |`),
    ...(vadLossRows.length === 0
      ? []
      : [
          '',
          '| Speech Model | Clip | Lost with VAD | Without VAD | With VAD |',
          '|---|---|---|---|---|',
          ...vadLossRows.map(
            (v) =>
              `| ${v.model} | ${v.clip} | ${v.missing} | ${v.withoutVad} | ${v.withVad} |`
          ),
        ]),
    '',
    promptEchoes.length === 0
      ? 'Prompt echoes: none'
      : `Prompt echoes: ${promptEchoes.map((e) => `${e.model} ${e.clip} ("${e.phrase}")`).join('; ')}`,
  ]
  const cutLines =
    cutChecked.length === 0
      ? []
      : [
          '',
          '| Speech Model | Cuts | Utterances decoded alone | Utterances that lost words at a cut | Same on continuous clips (reported, not gated) |',
          '|---|---|---|---|---|',
          ...cutChecked.map(
            (c) =>
              `| ${c.model} | ${c.cuts} | ${c.utterances} | ${c.flagged} | ${c.reported} |`
          ),
          ...(cutLossRows.length === 0
            ? []
            : [
                '',
                '| Speech Model | Clip | Cut | Utterance | Cut sits | Heard solo / cut | Missing at the cut | Gated |',
                '|---|---|---|---|---|---|---|---|',
                ...cutLossRows.map(
                  (c) =>
                    `| ${c.model} | ${c.clip} | ${c.cut} | ${c.utterance} | ${c.position} | ${c.soloHeard}/${c.words} / ${c.cutHeard}/${c.words} | ${c.missing} | ${c.gated ? 'yes' : 'reported, not gated: continuous clip'} |`
                ),
              ]),
          '',
          ...[...clipCuts.values()].map(({ clip, cuts }) => {
            const inside = cuts.filter((cut) => utteranceCut(clip, cut) !== -1)
            return `Cuts in ${clip.name} (${inside.length} of ${cuts.length} inside an utterance${cutLossGated(clip) ? '' : '; reported, not gated: continuous clip'}): ${cuts.map((cut) => `${cutLabel(cut)} ${utteranceCut(clip, cut) === -1 ? 'between' : 'inside'}`).join(', ')}`
          }),
        ]
  const localLines =
    localDictationRows.length === 0
      ? []
      : [
          '',
          '| Speech Model | Local dictation | Decoding | Wall s | Words | Sentence ends | Commas | Missing phrases |',
          '|---|---|---|---|---|---|---|---|',
          ...localDictationRows.map(
            (l) =>
              `| ${l.model} | ${basename(LOCAL_DICTATION)} | ${l.decoding} | ${l.wallSeconds.toFixed(1)} | ${l.words} | ${l.sentenceEnds} | ${l.commas} | ${l.missing.length === 0 ? 'none' : l.missing.join(', ')} |`
          ),
        ]
  const tuning = `nt-vad: slices of ${NT_VAD_TUNING.sliceOptions?.maxSliceSeconds ?? DEFAULT_VAD_SLICE_OPTIONS.maxSliceSeconds} s or less, ${NT_VAD_TUNING.beamSearch === false ? 'greedy' : '-bs 5'}, ${NT_VAD_TUNING.prompt === false ? 'no prompt' : 'prompt unless the Speech Model opts out'}`
  console.log(
    `\n[long-audio] ${tuning}\n${[...lines, ...parityLines, ...vadLines, ...cutLines, ...localLines].join('\n')}\n`
  )
})

describe('long-audio check', () => {
  for (const installed of models) {
    const id = installed.model.id
    test.skipIf(skipReason !== null)(
      `${id}: no speech lost, sane times, short clips unchanged`,
      async () => {
        const decoding = decodingOf(installed)
        const wantsTimings = decoding !== 'nt-vad'
        const failures: string[] = []

        for (const clip of longClips.filter((c) =>
          installed.langs.includes(c.lang)
        )) {
          const started = performance.now()
          const result = await transcribe(
            request(installed, clip.path, clip.lang)
          )
          const wallSeconds = (performance.now() - started) / 1000
          if (result.status !== 'ok') {
            failures.push(
              `${clip.name}: ${result.reason} ${result.diagnostic ?? ''}`
            )
            continue
          }
          checkPromptEcho(installed, clip.name, result.rawTranscript, failures)
          if (decoding === 'nt-vad')
            longTranscripts.set(`${id}|${clip.name}`, result.rawTranscript)
          const heard = heardPerWindow(clip.windows, result.rawTranscript)
          const lost = heard
            .map((share, index) => ({ share, index }))
            .filter(({ share }) => share < 0.3)
            .map(
              ({ index }) =>
                `${clip.windows[index].start.toFixed(0)}-${clip.windows[index].end.toFixed(0)} s`
            )
          const refWords = clip.windows.reduce(
            (n, w) => n + tokenizeForWer(w.text).length,
            0
          )
          const heardWords = clip.windows.reduce(
            (n, w, i) => n + heard[i] * tokenizeForWer(w.text).length,
            0
          )
          const said = punctuation(result.rawTranscript)
          const reference = punctuation(
            clip.windows.map((w) => w.text).join(' ')
          )
          const sentenceEnds = per100(said.sentenceEnds, said.words)
          const referenceSentenceEnds = per100(
            reference.sentenceEnds,
            reference.words
          )
          const timed = result.timedTranscript ?? null
          const nonLatin =
            clip.lang === 'da' ? nonLatinShare(result.rawTranscript) : null
          const timesOk =
            timed === null ? null : timesInOrder(timed, clip.seconds)
          const uncovered =
            timed === null ? null : uncoveredWindows(timed, clip.windows)
          rows.push({
            model: id,
            clip: clip.name,
            decoding,
            seconds: clip.seconds,
            wallSeconds,
            heard: heardWords / Math.max(1, refWords),
            lost,
            nonLatin,
            parts: timed?.parts.length ?? null,
            timesOk,
            repeats: timed === null ? null : repeatedParts(timed),
            sentenceEnds,
            commas: per100(said.commas, said.words),
            referenceSentenceEnds,
            windowsCovered:
              uncovered === null
                ? '-'
                : `${clip.windows.length - uncovered.length}/${clip.windows.length}`,
            note: '',
          })
          if (lost.length > 0)
            failures.push(`${clip.name}: lost ${lost.join(', ')}`)
          if (
            decoding === 'nt-vad' &&
            hasPauses(clip) &&
            referenceSentenceEnds >= PUNCTUATION_GATE.referenceSentenceEnds &&
            sentenceEnds < PUNCTUATION_GATE.minSentenceEnds
          )
            failures.push(
              `${clip.name}: ${sentenceEnds.toFixed(1)} sentence ends per 100 words, against ${referenceSentenceEnds.toFixed(1)} in the reference`
            )
          if (nonLatin !== null && nonLatin >= 0.01)
            failures.push(
              `${clip.name}: ${(nonLatin * 100).toFixed(2)}% non-Latin`
            )
          if (wantsTimings && timed === null)
            failures.push(`${clip.name}: no Timed Transcript`)
          if (timesOk === false)
            failures.push(`${clip.name}: times out of order or range`)
          const repeats = timed === null ? 0 : repeatedParts(timed)
          if (repeats > 0)
            failures.push(
              `${clip.name}: ${repeats} parts repeat the one before`
            )
          if (uncovered !== null && uncovered.length > 0)
            failures.push(
              `${clip.name}: ${uncovered.length} utterance windows without a part`
            )
        }

        // Within one word of the legacy argv, or, where decoding variance moved more than
        // one word, no further from the reference than the legacy transcript was.
        for (const clip of shortClips.filter((c) =>
          installed.langs.includes(c.lang)
        )) {
          const result = await transcribe(
            request(installed, clip.path, clip.lang)
          )
          if (result.status !== 'ok') {
            failures.push(`${clip.name}: ${result.reason}`)
            continue
          }
          checkPromptEcho(installed, clip.name, result.rawTranscript, failures)
          const legacy = legacyTranscript(crispasr!, installed, clip)
          const diff = wordEdits(legacy, result.rawTranscript)
          const legacyErrors = wordEdits(clip.text, legacy)
          const newErrors = wordEdits(clip.text, result.rawTranscript)
          parity.push({
            model: id,
            clip: clip.name,
            diff,
            legacyErrors,
            newErrors,
          })
          if (diff > 1 && newErrors > legacyErrors)
            failures.push(
              `${clip.name}: ${diff} words from legacy and worse against the reference ("${legacy}" vs "${result.rawTranscript}")`
            )
        }

        expect(failures).toEqual([])
      },
      RUN_TIMEOUT_MS * 4
    )
  }

  // Issue #83: no word on either side of an `nt-vad` cut lost that the same utterance,
  // decoded alone and uncut, hears. Reads the long-clip transcripts the test above wrote.
  for (const installed of models.filter((m) => decodingOf(m) === 'nt-vad')) {
    const id = installed.model.id
    test.skipIf(skipReason !== null)(
      `${id}: no words lost at an nt-vad cut`,
      async () => {
        const failures: string[] = []
        let cutCount = 0
        let utterances = 0
        let flagged = 0
        let reported = 0
        for (const clip of longClips.filter((c) =>
          installed.langs.includes(c.lang)
        )) {
          const transcript = longTranscripts.get(`${id}|${clip.name}`)
          if (transcript === undefined) {
            failures.push(`${clip.name}: no transcript from the long-clip run`)
            continue
          }
          const refs = clip.windows.map((w) => tokenizeForWer(w.text))
          const offsets = refs.map((_, i) =>
            refs.slice(0, i).reduce((n, words) => n + words.length, 0)
          )
          const long = alignWords(refs.flat(), tokenizeForWer(transcript))
          const cuts = cutsOf(clip)
          cutCount += cuts.length
          // Each utterance once, with every cut it sits at.
          const atCuts = new Map<number, Cut[]>()
          for (const cut of cuts) {
            for (const index of utterancesAtCut(clip, cut))
              atCuts.set(index, [...(atCuts.get(index) ?? []), cut])
          }
          for (const [index, near] of [...atCuts].sort((a, b) => a[0] - b[0])) {
            const ref = refs[index]
            const offset = offsets[index]
            const run: Alignment = {
              heard: long.heard.slice(offset, offset + ref.length),
              at: long.at.map((p) => p - offset),
            }
            const solo = alignWords(
              ref,
              tokenizeForWer(await soloTranscript(installed, clip, index))
            )
            utterances += 1
            const w = clip.windows[index]
            // The first and last words count where a cut is next to them. One lost at the
            // far end, inside a slice, is listed but is not a loss at a cut.
            const middles = near.map((c) => (c.from + c.to) / 2)
            const missing = lostStretches(ref, solo, run, {
              firstWord: middles.some(
                (m) => m <= w.speechStart + CUT_EDGE_SECONDS
              ),
              lastWord: middles.some(
                (m) => m >= w.speechEnd - CUT_EDGE_SECONDS
              ),
            })
            const farEdge = lostStretches(ref, solo, run, {
              firstWord: true,
              lastWord: true,
            }).filter((stretch) => !missing.includes(stretch))
            if (missing.length === 0 && farEdge.length === 0) continue
            const gated = cutLossGated(clip)
            if (missing.length > 0) {
              if (gated) flagged += 1
              else reported += 1
            }
            const cut = near.map(cutLabel).join(', ')
            const utterance = `${basename(w.source, '.wav')} ${w.speechStart.toFixed(1)}-${w.speechEnd.toFixed(1)} s`
            cutLossRows.push({
              model: id,
              clip: clip.name,
              gated,
              cut,
              utterance,
              position: near.map((c) => cutPosition(w, c)).join(', '),
              soloHeard: solo.heard.filter(Boolean).length,
              cutHeard: run.heard.filter(Boolean).length,
              words: ref.length,
              missing: [
                ...missing,
                ...farEdge.map(
                  (stretch) => `(${stretch}: far end, not at the cut)`
                ),
              ].join(' / '),
            })
            if (missing.length > 0 && gated)
              failures.push(
                `${clip.name}: the cut at ${cut} lost "${missing.join(' / ')}" (${utterance})`
              )
          }
        }
        cutChecked.push({
          model: id,
          cuts: cutCount,
          utterances,
          flagged,
          reported,
        })
        expect(failures).toEqual([])
      },
      RUN_TIMEOUT_MS * 4
    )
  }

  // A real dictation, where one exists (see the header): registered only then, so a machine
  // without it runs nothing and says nothing.
  const localDictation = existsSync(LOCAL_DICTATION)
    ? models.filter((m) => m.langs.includes('da'))
    : []
  for (const installed of localDictation) {
    const id = installed.model.id
    test.skipIf(skipReason !== null)(
      `${id}: the local Danish dictation keeps its sentences`,
      async () => {
        const started = performance.now()
        const result = await transcribe(
          request(installed, LOCAL_DICTATION, 'da')
        )
        const wallSeconds = (performance.now() - started) / 1000
        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        const said = punctuation(result.rawTranscript)
        const missing = missingPhrases(result.rawTranscript)
        localDictationRows.push({
          model: id,
          decoding: decodingOf(installed),
          wallSeconds,
          words: said.words,
          sentenceEnds: said.sentenceEnds,
          commas: said.commas,
          missing,
        })
        const failures: string[] = []
        checkPromptEcho(
          installed,
          'local dictation',
          result.rawTranscript,
          failures
        )
        if (missing.length > 0) failures.push(`missing ${missing.join(', ')}`)
        if (said.sentenceEnds < LOCAL_DICTATION_MIN_SENTENCE_ENDS)
          failures.push(`${said.sentenceEnds} sentence ends`)
        expect(failures).toEqual([])
      },
      RUN_TIMEOUT_MS
    )
  }

  // Every selected installed translate-capable one: a timed one must keep its timings sane
  // while translating, and one on Edda's path must still translate without losing speech.
  const translators = models.filter((m) => m.model.translationSupport)
  test.skipIf(skipReason !== null || translators.length > 0)(
    'translate to English on Danish (no translate-capable model installed)',
    () => {}
  )
  for (const translator of translators) {
    test.skipIf(skipReason !== null)(
      `translate to English on Danish (${translator.model.id})`,
      async () => {
        const clip = longClips.find((c) => c.name === 'da_2min')!
        const started = performance.now()
        const result = await transcribe(
          request(translator, clip.path, 'da', true)
        )
        const wallSeconds = (performance.now() - started) / 1000
        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        const words = tokenizeForWer(result.rawTranscript)
        const english = shareOf(words, ENGLISH_WORDS)
        const danish = shareOf(words, DANISH_WORDS)
        const timed = result.timedTranscript ?? null
        const uncovered =
          timed === null ? null : uncoveredWindows(timed, clip.windows)
        const said = punctuation(result.rawTranscript)
        rows.push({
          model: translator.model.id,
          clip: `${clip.name} -tr`,
          decoding: decodingOf(translator),
          seconds: clip.seconds,
          wallSeconds,
          heard: NaN,
          lost: [],
          nonLatin: null,
          parts: timed?.parts.length ?? null,
          timesOk: timed === null ? null : timesInOrder(timed, clip.seconds),
          repeats: timed === null ? null : repeatedParts(timed),
          sentenceEnds: per100(said.sentenceEnds, said.words),
          commas: per100(said.commas, said.words),
          referenceSentenceEnds: null,
          windowsCovered:
            uncovered === null
              ? '-'
              : `${clip.windows.length - uncovered.length}/${clip.windows.length}`,
          note: `English words ${(english * 100).toFixed(0)}%, Danish ${(danish * 100).toFixed(0)}%`,
        })
        const echoes: string[] = []
        checkPromptEcho(
          translator,
          `${clip.name} -tr`,
          result.rawTranscript,
          echoes
        )
        expect(echoes).toEqual([])
        expect(english).toBeGreaterThan(0.2)
        expect(danish).toBeLessThan(0.05)
        if (decodingOf(translator) !== 'timestamps') {
          expect(timed).toBeNull()
          return
        }
        expect(timed).not.toBeNull()
        expect(uncovered).toEqual([])
        expect(repeatedParts(timed!)).toBe(0)
      },
      RUN_TIMEOUT_MS
    )
  }

  // ADR-0011: the VAD must not cost a word the same argv without it hears.
  for (const installed of models.filter(
    (m) => decodingOf(m) === 'timestamps'
  )) {
    const id = installed.model.id
    test.skipIf(skipReason !== null)(
      `${id}: the VAD loses no speech and the prompt is not repeated`,
      async () => {
        const failures: string[] = []
        const clips = vadClips.filter((c) => installed.langs.includes(c.lang))
        let flagged = 0
        for (const clip of clips) {
          const base = join(dir, `vad-${id}-${clip.name}`)
          const withVad = await timestampsTranscript(
            installed,
            clip.path,
            clip.lang,
            `${base}-app`,
            false
          )
          const withoutVad = await timestampsTranscript(
            installed,
            clip.path,
            clip.lang,
            `${base}-novad`,
            true
          )
          checkPromptEcho(installed, clip.name, withVad, failures)
          const losses = vadLosses(clip.text, withoutVad, withVad)
          if (losses.length > 0) flagged += 1
          for (const missing of losses) {
            vadLossRows.push({
              model: id,
              clip: clip.name,
              missing,
              withoutVad,
              withVad,
            })
            failures.push(`${clip.name}: the VAD lost "${missing}"`)
          }
        }
        vadChecked.push({ model: id, clips: clips.length, flagged })
        expect(failures).toEqual([])
      },
      RUN_TIMEOUT_MS * 2
    )
  }
})
