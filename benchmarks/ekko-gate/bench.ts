// usage: bun bench.ts <quant> [device]
// The app path for ekko, outside the app: Codictate's planVadSlices (defaults: 30 s cap), each
// slice written as 16 kHz mono WAV, one `parakeet-cli transcribe --json` per slice with
// PARAKEET_ATT_CONTEXT=128, text joined in order. Same 930 clips in the same order as the Edda
// run (first 3 = warmup), WER through the harness's own computeWer against column 3.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planVadSlices, readWavSamples } from '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate/src/bun/utils/whisper/engines/vad-slices.ts'
import { computeCer, computeWer } from '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate/benchmarks/stt/wer.ts'

const R = '/Users/emillykkegrann/Documents/Projects/codictate-project/codictate/benchmarks'
const P = process.env.EKKO_GATE_DIR!
const CLI = `${P}/bin/parakeet-v0.6.1-bin-macos-metal-arm64/parakeet-cli`
const quant = process.argv[2]
const device = process.argv[3] ?? 'metal'
const model = `${P}/model/ekko-v1-tiny-${quant}.gguf`
const outPath = `${P}/out/${quant}-${device}.jsonl`
const sliceDir = `${P}/slices-${quant}-${device}`
mkdirSync(sliceDir, { recursive: true })

const ref = new Map<string, string>()
for (const line of readFileSync(`${R}/datasets/fleurs/da_dk/test.tsv`, 'utf-8').split('\n')) {
  const c = line.split('\t')
  if (c.length >= 4) ref.set(c[1], c[3])
}
const order = JSON.parse(readFileSync(`${R}/results/2026-10-08_06-42-10_edda-v0-2-danish/_v2/da_dk__crispasr__edda-v0.2-q5_0.run.json`, 'utf-8')).samples as { clipId: string; isWarmup?: boolean }[]
const done = new Set(existsSync(outPath) ? readFileSync(outPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).clipId) : [])

function wav(pcm: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVE')
  s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  s(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i += 1) {
    const x = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true)
  }
  return new Uint8Array(buf)
}

const env = { ...process.env, PARAKEET_ATT_CONTEXT: '128', ...(device === 'cpu' ? { PARAKEET_DEVICE: 'cpu' } : {}) }
for (const { clipId, isWarmup } of order) {
  if (done.has(clipId)) continue
  const file = clipId.split('/').pop()!
  const t0 = performance.now()
  const { samples, sampleRate } = readWavSamples(new Uint8Array(readFileSync(`${R}/datasets/${clipId}`)))
  const slices = planVadSlices(samples, sampleRate)
  const texts: string[] = []
  const words: { w: string; start: number; end: number }[] = []
  let rss = 0
  let footprint = 0
  let failed = false
  for (const [i, sl] of slices.entries()) {
    const p = join(sliceDir, `s${i}.wav`)
    writeFileSync(p, wav(samples.subarray(sl.startSample, sl.endSample), sampleRate))
    const r = Bun.spawnSync(['/usr/bin/time', '-l', CLI, 'transcribe', '--model', model, '--input', p, '--json'], { env })
    const err = r.stderr.toString()
    rss = Math.max(rss, Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0))
    footprint = Math.max(footprint, Number(/(\d+)\s+peak memory footprint/.exec(err)?.[1] ?? 0))
    if (r.exitCode !== 0) { failed = true; continue }
    const j = JSON.parse(r.stdout.toString())
    texts.push(j.text)
    const off = sl.startSample / sampleRate
    for (const w of j.words ?? []) words.push({ w: w.w, start: w.start + off, end: w.end + off })
  }
  const responseMs = performance.now() - t0
  const hyp = texts.join(' ').replace(/\s+/g, ' ').trim()
  const reference = ref.get(file)!
  const w = computeWer(reference, hyp)
  const c = computeCer(reference, hyp)
  const audioDurationSec = samples.length / sampleRate
  appendFileSync(outPath, JSON.stringify({
    clipId, isWarmup: !!isWarmup, audioDurationSec, responseMs, slices: slices.length, failed,
    wordErrors: w.substitutions + w.insertions + w.deletions, referenceWords: w.refWords, charErrors: c.substitutions + c.insertions + c.deletions, referenceChars: c.refChars,
    rssBytes: rss, footprintBytes: footprint, hyp, reference, firstSliceStart: slices[0] ? slices[0].startSample / sampleRate : null, words,
  }) + '\n')
}
rmSync(sliceDir, { recursive: true, force: true })
console.log('done', quant, device)
