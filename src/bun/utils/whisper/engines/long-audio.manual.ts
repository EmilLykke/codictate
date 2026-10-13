/**
 * The long-audio check (ADR-0010): whether a Whisper Speech Model may decode without `-nt`.
 * Opt-in (`.manual.ts`, so `bun test` never discovers it): it spawns the real crispasr on
 * installed weights and reads the local benchmark datasets.
 *
 *   bun test ./src/bun/utils/whisper/engines/long-audio.manual.ts
 *
 * Test audio is built in a temp directory from `benchmarks/datasets`: LibriSpeech test-clean
 * and FLEURS `da_dk` utterances joined with 1 s of silence into 60 s and 5 min English, and
 * 2 min and 5 min Danish. Every installed curated Whisper Speech Model, Edda and hviske runs
 * through `runTranscription`, exactly as a Dictation or a File Transcription would. Weights
 * are looked for in the app's models directory and `vendors/whisper`, plus any directory in
 * `CODICTATE_LONG_AUDIO_MODEL_DIRS` (path-delimiter separated). `CODICTATE_LONG_AUDIO_MODELS`
 * (comma separated Speech Model ids) narrows the run. Missing datasets, crispasr or weights
 * skip with a message.
 *
 * Asserted per Speech Model:
 * - No utterance lost: at least 30% of each utterance's reference words heard, in order.
 * - Short single clips within one word of the legacy `-nt` argv, spawned here by hand, or,
 *   when decoding variance moved more than a word, no worse against the reference.
 * - Danish: under 1% of letters outside the Latin script (Edda's failure without `-nt`).
 * - With a Timed Transcript: times in order and inside the audio (+0.5 s), every
 *   utterance's window overlaps a part, and no part of three words or more repeats the one
 *   before it (a decoding loop, which the heard share alone does not catch).
 * - Translate (each installed of small-q5_1 and large-v3-q5_0, `-tr` on Danish): English;
 *   when timed, no utterance window without a part and no repeated parts.
 *
 * A table is printed at the end. A Speech Model gets `whisperDecoding: 'timestamps'` in
 * src/shared/speech-models.ts only after its rows pass here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
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
import { runTranscription } from './run-transcription'
import type { HarnessTranscriptionRequest } from './transcription'

const REPO = resolve(import.meta.dir, '../../../../..')
const DATASETS = join(REPO, 'benchmarks/datasets')
const LIBRISPEECH = join(DATASETS, 'librispeech')
const FLEURS_DA = join(DATASETS, 'fleurs/da_dk')
const SAMPLE_RATE = 16_000
const GAP_SECONDS = 1
const MAX_CLIP_SECONDS = 25
const RUN_TIMEOUT_MS = 15 * 60_000

type Lang = 'en' | 'da'

interface Utterance {
  wav: string
  text: string
}

interface Window {
  text: string
  start: number
  end: number
}

interface LongClip {
  name: string
  lang: Lang
  path: string
  seconds: number
  windows: Window[]
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
  note: string
}

const rows: Row[] = []
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

/** Utterances joined with 1 s of silence until `targetSeconds`, and where each one sits. */
function buildLongClip(
  dir: string,
  name: string,
  lang: Lang,
  pool: readonly Utterance[],
  targetSeconds: number
): LongClip {
  const pieces: Int16Array[] = []
  const windows: Window[] = []
  const gap = new Int16Array(GAP_SECONDS * SAMPLE_RATE)
  let at = 0
  for (const utterance of pool) {
    const samples = readWavSamples(utterance.wav)
    if (samples === null) continue
    const seconds = samples.length / SAMPLE_RATE
    if (seconds > MAX_CLIP_SECONDS || at + seconds > targetSeconds * 1.05)
      continue
    if (pieces.length > 0) {
      pieces.push(gap)
      at += GAP_SECONDS
    }
    pieces.push(samples)
    windows.push({ text: utterance.text, start: at, end: at + seconds })
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
  return { name, lang, path, seconds: all.length / SAMPLE_RATE, windows }
}

// -- Datasets -------------------------------------------------------------------------

function librispeechPool(): Utterance[] {
  const text = new Map<string, string>()
  const root = join(LIBRISPEECH, 'test-clean')
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
  const wavDir = join(LIBRISPEECH, 'wav/test-clean')
  return [...text.keys()]
    .sort()
    .filter((id) => existsSync(join(wavDir, `${id}.wav`)))
    .map((id) => ({ wav: join(wavDir, `${id}.wav`), text: text.get(id)! }))
}

function fleursDanishPool(): Utterance[] {
  const seen = new Set<string>()
  const out: Utterance[] = []
  for (const line of readFileSync(join(FLEURS_DA, 'test.tsv'), 'utf8').split(
    '\n'
  )) {
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
    if (!(
      isHviske ||
      isEdda ||
      (model.engine === 'whisper_cpp' && model.curated)
    ))
      continue
    if (only.length > 0 && !only.includes(model.id)) continue
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
}, 120_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  if (rows.length === 0) return
  const lines = [
    '| Speech Model | Clip | Decoding | Audio s | Wall s | Heard | Lost utterances | Non-Latin | Parts | Repeats | Times | Windows covered | Note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.model} | ${r.clip} | ${r.decoding} | ${r.seconds.toFixed(0)} | ${r.wallSeconds.toFixed(1)} | ${Number.isNaN(r.heard) ? '-' : `${(r.heard * 100).toFixed(0)}%`} | ${r.lost.length === 0 ? 'none' : r.lost.join(', ')} | ${r.nonLatin === null ? '-' : `${(r.nonLatin * 100).toFixed(2)}%`} | ${r.parts ?? '-'} | ${r.repeats ?? '-'} | ${r.timesOk === null ? '-' : r.timesOk ? 'ok' : 'BAD'} | ${r.windowsCovered} | ${r.note} |`
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
  console.log(`\n[long-audio]\n${[...lines, ...parityLines].join('\n')}\n`)
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
          const result = await runTranscription(
            request(installed, clip.path, clip.lang)
          )
          const wallSeconds = (performance.now() - started) / 1000
          if (result.status !== 'ok') {
            failures.push(
              `${clip.name}: ${result.reason} ${result.diagnostic ?? ''}`
            )
            continue
          }
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
            windowsCovered:
              uncovered === null
                ? '-'
                : `${clip.windows.length - uncovered.length}/${clip.windows.length}`,
            note: '',
          })
          if (lost.length > 0)
            failures.push(`${clip.name}: lost ${lost.join(', ')}`)
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
          const result = await runTranscription(
            request(installed, clip.path, clip.lang)
          )
          if (result.status !== 'ok') {
            failures.push(`${clip.name}: ${result.reason}`)
            continue
          }
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

  // Every installed translate-capable one: a timed one must keep its timings sane while
  // translating, and one on Edda's path must still translate without losing speech.
  const translators = ['small-q5_1', 'large-v3-q5_0']
    .map((id) => models.find((m) => m.model.id === id))
    .filter((m) => m !== undefined)
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
        const result = await runTranscription(
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
          windowsCovered:
            uncovered === null
              ? '-'
              : `${clip.windows.length - uncovered.length}/${clip.windows.length}`,
          note: `English words ${(english * 100).toFixed(0)}%, Danish ${(danish * 100).toFixed(0)}%`,
        })
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
})
