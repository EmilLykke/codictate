// usage: bun long.ts <quant> <metal|cpu>
// long-audio.manual.ts's Danish clips, built the same way (da_2min, da_5min, da_continuous_90s,
// plus da_60min), and the private 65 s dictation, through the ekko app path (planVadSlices,
// one parakeet-cli per slice, ATT=128). Reports lost utterances (<30% heard, in order), peak
// memory per process, and word-time offsets against each utterance's speech bounds.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planVadSlices, readWavSamples as readF32 } from '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate/src/bun/utils/whisper/engines/vad-slices.ts'
import { computeWer, tokenizeForWer } from '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate/benchmarks/stt/wer.ts'

const REPO = '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate'
const P = process.env.EKKO_GATE_DIR!
const CLI = `${P}/bin/parakeet-v0.6.1-bin-macos-metal-arm64/parakeet-cli`
const [quant = 'q5_0', device = 'metal'] = process.argv.slice(2)
const MODEL = `${P}/model/ekko-v1-tiny-${quant}.gguf`
const FLEURS_DA = join(REPO, 'benchmarks/datasets/fleurs/da_dk')
const LOCAL = join(REPO, 'benchmarks/datasets/local/edda-dictation-da-65s.wav')
const SR = 16_000
const DIR = `${P}/long-${quant}-${device}`
mkdirSync(DIR, { recursive: true })
const PHRASES = ['mangler penge', 'mette frederiksen', 'denne uges udgave af', 'økonomiske problemer']

type Window = { text: string; start: number; end: number; speechStart: number; speechEnd: number }

function readI16(path: string): Int16Array {
  const { samples } = readF32(new Uint8Array(readFileSync(path)))
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767)
  return out
}
function writeWav(path: string, s: Int16Array) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + s.length * 2, 4); h.write('WAVE', 8, 'ascii'); h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(s.length * 2, 40)
  writeFileSync(path, Buffer.concat([h, Buffer.from(s.buffer, s.byteOffset, s.byteLength)]))
}
// long-audio.manual.ts's speechBounds/trimSilence/buildLongClip/fleursDanishPool, unchanged in behaviour.
function speechBounds(s: Int16Array) {
  const frame = SR / 50
  const rms: number[] = []
  for (let i = 0; i + frame <= s.length; i += frame) {
    let e = 0
    for (let j = i; j < i + frame; j += 1) e += s[j] * s[j]
    rms.push(Math.sqrt(e / frame))
  }
  const quiet = Math.max(0, ...rms) * 0.02
  let first = 0
  let last = rms.length - 1
  while (first < last && rms[first] < quiet) first += 1
  while (last > first && rms[last] < quiet) last -= 1
  return { start: first * frame, end: (last + 1) * frame }
}
function buildLongClip(name: string, pool: { wav: string; text: string }[], target: number, { gap = 1, trim = false } = {}) {
  const pieces: Int16Array[] = []
  const windows: Window[] = []
  const g = new Int16Array(Math.round(gap * SR))
  let at = 0
  for (const u of pool) {
    const read = readI16(u.wav)
    const b0 = speechBounds(read)
    const s = trim ? read.slice(b0.start, b0.end) : read
    const sec = s.length / SR
    if (sec > 25 || at + sec > target * 1.05) continue
    if (pieces.length > 0) { pieces.push(g); at += gap }
    pieces.push(s)
    const b = speechBounds(s)
    windows.push({ text: u.text, start: at, end: at + sec, speechStart: at + b.start / SR, speechEnd: at + b.end / SR })
    at += sec
    if (at >= target * 0.95) break
  }
  const all = new Int16Array(pieces.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of pieces) { all.set(p, o); o += p.length }
  const path = join(DIR, `${name}.wav`)
  writeWav(path, all)
  return { name, path, seconds: all.length / SR, windows }
}
function fleursDanishPool(fromFile?: string) {
  const seen = new Set<string>()
  const out: { wav: string; text: string }[] = []
  const lines = readFileSync(join(FLEURS_DA, 'test.tsv'), 'utf8').split('\n')
  const from = fromFile === undefined ? 0 : Math.max(0, lines.findIndex((l) => l.split('\t')[1] === `${fromFile}.wav`))
  for (const line of lines.slice(from)) {
    const [sid, file, text] = line.split('\t')
    if (!file || !text || seen.has(sid) || seen.has(file)) continue
    seen.add(sid); seen.add(file)
    out.push({ wav: join(FLEURS_DA, 'audio/test', file), text })
  }
  return out
}

function f32wav(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767)
  return out
}
const env = { ...process.env, PARAKEET_ATT_CONTEXT: '128', ...(device === 'cpu' ? { PARAKEET_DEVICE: 'cpu' } : {}) }
function transcribe(path: string) {
  const t0 = performance.now()
  const { samples, sampleRate } = readF32(new Uint8Array(readFileSync(path)))
  const slices = planVadSlices(samples, sampleRate)
  const texts: string[] = []
  const words: { w: string; start: number; end: number }[] = []
  let rss = 0, fp = 0, fails = 0
  for (const [i, sl] of slices.entries()) {
    const p = join(DIR, `slice.wav`)
    writeWav(p, f32wav(samples.subarray(sl.startSample, sl.endSample)))
    const r = Bun.spawnSync(['/usr/bin/time', '-l', CLI, 'transcribe', '--model', MODEL, '--input', p, '--json'], { env })
    const err = r.stderr.toString()
    rss = Math.max(rss, Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0))
    fp = Math.max(fp, Number(/(\d+)\s+peak memory footprint/.exec(err)?.[1] ?? 0))
    if (r.exitCode !== 0) { fails += 1; continue }
    const j = JSON.parse(r.stdout.toString())
    texts.push(j.text)
    const off = sl.startSample / sampleRate
    for (const w of j.words ?? []) words.push({ w: w.w, start: w.start + off, end: w.end + off })
  }
  return { text: texts.join(' ').replace(/\s+/g, ' ').trim(), words, slices: slices.length, rss, fp, fails, wallMs: performance.now() - t0 }
}

// Aligns hypothesis words to reference words; returns, per window, share heard and the
// hypothesis word indices matched into it.
function align(windows: Window[], hypWords: string[]) {
  const ref: { word: string; win: number }[] = []
  windows.forEach((w, k) => { for (const word of tokenizeForWer(w.text)) ref.push({ word, win: k }) })
  const hyp = hypWords.map((w) => tokenizeForWer(w).join(''))
  const n = ref.length, m = hyp.length, W = m + 1
  const d = new Uint32Array((n + 1) * W)
  for (let i = 0; i <= n; i += 1) d[i * W] = i
  for (let j = 0; j <= m; j += 1) d[j] = j
  for (let i = 1; i <= n; i += 1)
    for (let j = 1; j <= m; j += 1)
      d[i * W + j] = Math.min(d[(i - 1) * W + j] + 1, d[i * W + j - 1] + 1, d[(i - 1) * W + j - 1] + (ref[i - 1].word === hyp[j - 1] ? 0 : 1))
  const hits = windows.map(() => [] as number[])
  let i = n, j = m
  while (i > 0 && j > 0) {
    const same = ref[i - 1].word === hyp[j - 1]
    if (d[i * W + j] === d[(i - 1) * W + j - 1] + (same ? 0 : 1)) { if (same) hits[ref[i - 1].win].push(j - 1); i -= 1; j -= 1 }
    else if (d[i * W + j] === d[(i - 1) * W + j] + 1) i -= 1
    else j -= 1
  }
  return windows.map((w, k) => ({ share: hits[k].length / Math.max(1, tokenizeForWer(w.text).length), idx: hits[k].sort((a, b) => a - b) }))
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }

const da = fleursDanishPool()
const clips = [
  buildLongClip('da_2min', da, 120),
  buildLongClip('da_5min', da, 300),
  buildLongClip('da_continuous_90s', fleursDanishPool('4524951591374662777'), 90, { gap: 0.05, trim: true }),
  buildLongClip('da_60min', da, 3600),
]
const report: unknown[] = []
for (const c of clips) {
  const r = transcribe(c.path)
  const a = align(c.windows, r.words.map((w) => w.w))
  const lost = a.map((x, k) => ({ k, share: x.share })).filter((x) => x.share < 0.3)
  // Caption timing: first matched word's start vs the utterance's speech start, last word's end vs speech end.
  const startOff: number[] = [], endOff: number[] = []
  a.forEach((x, k) => {
    const w = c.windows[k]
    const first = tokenizeForWer(w.text)[0]
    if (x.idx.length && tokenizeForWer(r.words[x.idx[0]].w).join('') === first) startOff.push(r.words[x.idx[0]].start - w.speechStart)
    const lastRef = tokenizeForWer(w.text).at(-1)
    if (x.idx.length && tokenizeForWer(r.words[x.idx.at(-1)!].w).join('') === lastRef) endOff.push(r.words[x.idx.at(-1)!].end - w.speechEnd)
  })
  const ref = c.windows.map((w) => w.text).join(' ')
  const wer = computeWer(ref, r.text)
  const row = {
    clip: c.name, sec: Math.round(c.seconds), utterances: c.windows.length, slices: r.slices, wallSec: +(r.wallMs / 1000).toFixed(1),
    WER: +(wer.wer * 100).toFixed(2), lost: lost.length, lostDetail: lost.map((x) => `${x.k}:${(x.share * 100).toFixed(0)}%`),
    peakRssMB: Math.round(r.rss / 2 ** 20), peakFootprintMB: Math.round(r.fp / 2 ** 20), fails: r.fails,
    startOff: { n: startOff.length, p10: +q(startOff, 0.1).toFixed(2), median: +q(startOff, 0.5).toFixed(2), p90: +q(startOff, 0.9).toFixed(2), earlyOver300ms: startOff.filter((x) => x < -0.3).length },
    endOff: { n: endOff.length, p10: +q(endOff, 0.1).toFixed(2), median: +q(endOff, 0.5).toFixed(2), p90: +q(endOff, 0.9).toFixed(2) },
  }
  report.push(row)
  console.log(JSON.stringify(row))
  writeFileSync(join(DIR, `${c.name}.txt`), r.text + '\n')
  writeFileSync(join(DIR, `${c.name}.words.json`), JSON.stringify({ windows: c.windows, words: r.words }))
}
if (statSync(LOCAL, { throwIfNoEntry: false })) {
  const r = transcribe(LOCAL)
  const norm = ` ${tokenizeForWer(r.text).join(' ')} `
  const missing = PHRASES.filter((p) => !norm.includes(` ${tokenizeForWer(p).join(' ')} `))
  const row = { clip: 'local_65s', slices: r.slices, wallSec: +(r.wallMs / 1000).toFixed(1), words: tokenizeForWer(r.text).length, missing, peakRssMB: Math.round(r.rss / 2 ** 20), peakFootprintMB: Math.round(r.fp / 2 ** 20), fails: r.fails }
  report.push(row)
  console.log(JSON.stringify(row))
  writeFileSync(join(DIR, 'local_65s.txt'), r.text + '\n')
  writeFileSync(join(DIR, 'local_65s.words.json'), JSON.stringify(r.words))
}
writeFileSync(join(DIR, 'report.json'), JSON.stringify(report, null, 1))
