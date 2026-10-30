import { describe, expect, test } from 'bun:test'
import {
  planVadSlices,
  readWavSamples,
  vadImportJson,
  type AudioSlice,
} from './vad-slices'

const SR = 16_000
const CAP = 30 * SR
/**
 * The cap the pause-choice cases below were drawn for, before the default went from 20 s to
 * 30 s. The rules do not depend on the cap, so those cases pin it rather than grow.
 */
const TWENTY = { maxSliceSeconds: 20 }
const TWENTY_CAP = 20 * SR

/** Deterministic uniform noise in [-1, 1). */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
}

type Part =
  /** Stands in for speech: noise around -15 dBFS. */
  | ['speech', number]
  /** Still speech, 6 dB under it. */
  | ['soft', number]
  /** A quiet room: noise around -55 dBFS. */
  | ['room', number]
  /** A very quiet room: noise around -71 dBFS. */
  | ['hush', number]
  | ['zeros', number]
  /** A 440 Hz tone around -13 dBFS. */
  | ['tone', number]

/** Audio from parts given in seconds. */
function audio(...parts: Part[]): Float32Array {
  const random = noise(7)
  const out: number[] = []
  for (const [kind, seconds] of parts) {
    const count = Math.round(seconds * SR)
    for (let i = 0; i < count; i += 1) {
      if (kind === 'speech') out.push(0.3 * random())
      else if (kind === 'soft') out.push(0.15 * random())
      else if (kind === 'room') out.push(0.003 * random())
      else if (kind === 'hush') out.push(0.0005 * random())
      else if (kind === 'tone')
        out.push(0.3 * Math.sin((2 * Math.PI * 440 * out.length) / SR))
      else out.push(0)
    }
  }
  return Float32Array.from(out)
}

const at = (seconds: number) => Math.round(seconds * SR)

/** Sorted, non-empty, never overlapping, inside the audio and within the cap. */
function expectWellFormed(
  slices: AudioSlice[],
  sampleCount: number,
  cap = CAP
): void {
  for (const [i, slice] of slices.entries()) {
    expect(slice.startSample).toBeGreaterThanOrEqual(0)
    expect(slice.endSample).toBeLessThanOrEqual(sampleCount)
    expect(slice.endSample).toBeGreaterThan(slice.startSample)
    expect(slice.endSample - slice.startSample).toBeLessThanOrEqual(cap)
    if (i > 0) {
      expect(slice.startSample).toBeGreaterThanOrEqual(slices[i - 1].endSample)
    }
  }
}

/** Whether every sample of `[start, end)` is inside one of the slices. */
function covered(slices: AudioSlice[], start: number, end: number): boolean {
  let at = start
  for (const slice of slices) {
    if (slice.startSample <= at && slice.endSample > at) at = slice.endSample
    if (at >= end) return true
  }
  return false
}

describe('planVadSlices: nothing to decode', () => {
  test('digital silence and faint dither give no slices', () => {
    expect(planVadSlices(new Float32Array(10 * SR), SR)).toEqual([])
    const random = noise(1)
    const dither = Float32Array.from({ length: 10 * SR }, () => 1e-4 * random())
    expect(planVadSlices(dither, SR)).toEqual([])
    expect(planVadSlices(new Float32Array(0), SR)).toEqual([])
  })

  test('a quiet room on its own is not speech', () => {
    expect(planVadSlices(audio(['room', 10]), SR)).toEqual([])
  })

  test('a click shorter than minSpeechMs is dropped', () => {
    const samples = audio(['room', 3], ['speech', 0.03], ['room', 3])
    expect(planVadSlices(samples, SR)).toEqual([])
  })

  test('a speech mask is no reason to decode digital silence', () => {
    expect(
      planVadSlices(new Float32Array(5 * SR), SR, undefined, [
        { startSample: 0, endSample: 5 * SR },
      ])
    ).toEqual([])
  })
})

describe('planVadSlices: merging at pauses', () => {
  test('one short utterance is one slice, padded by 200 ms', () => {
    const samples = audio(['room', 0.5], ['speech', 1.5], ['room', 0.8])
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: at(0.3), endSample: at(2.2) },
    ])
  })

  test('audio shorter than the cap is one slice, pauses and all', () => {
    // The 1.5 s pause is exactly maxMergeGapMs, so it still merges.
    const samples = audio(
      ['room', 0.4],
      ['speech', 2],
      ['room', 1.5],
      ['speech', 3],
      ['room', 0.2],
      ['speech', 1],
      ['room', 0.5]
    )
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: at(0.2), endSample: at(8.3) },
    ])
  })

  test('the slice reaches the edges of the audio, and no further', () => {
    const samples = audio(['room', 0.1], ['speech', 2], ['room', 0.05])
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: 0, endSample: samples.length },
    ])
  })

  test('50 s of tone bursts with 300 ms gaps: a few slices of up to 30 s, cut inside gaps', () => {
    const parts: Part[] = []
    const bursts: [number, number][] = []
    for (let t = 0; t < 50; t += 3) {
      bursts.push([t, t + 2.7])
      parts.push(['tone', 2.7], ['room', 0.3])
    }
    const samples = audio(...parts)
    const slices = planVadSlices(samples, SR)
    expectWellFormed(slices, samples.length)
    // 17 bursts, merged 9 and 8: never one slice per pause.
    expect(slices).toHaveLength(2)
    const inGap = (sample: number) =>
      bursts.every(([s, e]) => sample <= at(s) || sample >= at(e))
    for (const slice of slices) {
      expect(inGap(slice.startSample)).toBe(true)
      expect(inGap(slice.endSample)).toBe(true)
    }
    // Neighbours split a gap too short for both pads at its middle.
    expect(slices[0].endSample).toBe(slices[1].startSample)
    expect(slices[0].endSample).toBe(at(26.85))
    for (const [s, e] of bursts)
      expect(covered(slices, at(s), at(e))).toBe(true)
  })

  test('a gap wide enough for both pads keeps a full pad on each side', () => {
    const samples = audio(
      ['room', 1],
      ['speech', 2],
      ['room', 1],
      ['speech', 2],
      ['room', 1]
    )
    // A 3 s cap fits one utterance and its pads, never both.
    expect(planVadSlices(samples, SR, { maxSliceSeconds: 3 })).toEqual([
      { startSample: at(0.8), endSample: at(3.2) },
      { startSample: at(3.8), endSample: at(6.2) },
    ])
  })

  test('the cap wins over the padding', () => {
    const samples = audio(['room', 2], ['speech', 1], ['room', 2])
    const slices = planVadSlices(samples, SR, {
      maxSliceSeconds: 2,
      padMs: 800,
    })
    expect(slices).toEqual([{ startSample: at(1.2), endSample: at(3.2) }])
  })

  test('random speech and pauses: well formed, and no speech left out', () => {
    for (const seed of [1, 2, 3]) {
      const random = noise(seed)
      const parts: Part[] = [['room', 0.5]]
      const speech: [number, number][] = []
      let t = 0.5
      while (t < 120) {
        const talk = 0.3 + 6 * Math.abs(random())
        const pause = 0.1 + 1.5 * Math.abs(random())
        speech.push([t, t + talk])
        parts.push(['speech', talk], ['room', pause])
        t += talk + pause
      }
      const samples = audio(...parts)
      const slices = planVadSlices(samples, SR)
      expectWellFormed(slices, samples.length)
      for (const [s, e] of speech) {
        expect(covered(slices, at(s) + 1, at(e) - 1)).toBe(true)
      }
    }
  })
})

describe('planVadSlices: long pauses', () => {
  test('utterance, 10 s of silence, utterance: two slices, the silence in neither', () => {
    const samples = audio(
      ['room', 1],
      ['speech', 2],
      ['room', 10],
      ['speech', 2],
      ['room', 1]
    )
    const slices = planVadSlices(samples, SR)
    expect(slices).toEqual([
      { startSample: at(0.8), endSample: at(3.2) },
      { startSample: at(12.8), endSample: at(15.2) },
    ])
  })

  test('a 1 s pause merges, a 2 s pause ends the slice', () => {
    const withPause = (seconds: number) =>
      audio(
        ['room', 1],
        ['speech', 2],
        ['room', seconds],
        ['speech', 2],
        ['room', 1]
      )
    expect(planVadSlices(withPause(1), SR)).toEqual([
      { startSample: at(0.8), endSample: at(6.2) },
    ])
    expect(planVadSlices(withPause(2), SR)).toEqual([
      { startSample: at(0.8), endSample: at(3.2) },
      { startSample: at(4.8), endSample: at(7.2) },
    ])
    expect(planVadSlices(withPause(2), SR, { maxMergeGapMs: 3000 })).toEqual([
      { startSample: at(0.8), endSample: at(7.2) },
    ])
  })

  test('the gap rule holds for a speech mask too', () => {
    const samples = audio(['tone', 16])
    expect(
      planVadSlices(samples, SR, undefined, [
        { startSample: at(1), endSample: at(3) },
        { startSample: at(13), endSample: at(15) },
      ])
    ).toEqual([
      { startSample: at(0.8), endSample: at(3.2) },
      { startSample: at(12.8), endSample: at(15.2) },
    ])
  })

  test('a click on the far side of a long pause is dropped on its own', () => {
    const samples = audio(
      ['room', 1],
      ['speech', 2],
      ['room', 5],
      ['speech', 0.1],
      ['room', 1]
    )
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: at(0.8), endSample: at(3.2) },
    ])
  })
})

describe('planVadSlices: a slice ends at the longest pause in reach', () => {
  test('a 0.40 s pause at 17 s beats a 0.20 s one at 18.6 s', () => {
    // large-v2's en_continuous_90s slice: the last pause that fit was a breath inside a
    // sentence, and the cut there lost "see said uncas pointing north and south".
    const samples = audio(
      ['room', 0.5],
      ['speech', 17],
      ['room', 0.4],
      ['speech', 1.2],
      ['room', 0.2],
      ['speech', 10],
      ['room', 1]
    )
    const slices = planVadSlices(samples, SR, TWENTY)
    expectWellFormed(slices, samples.length, TWENTY_CAP)
    expect(slices).toEqual([
      { startSample: at(0.3), endSample: at(17.7) },
      { startSample: at(17.7), endSample: at(29.5) },
    ])
  })

  test('of two equal pauses, the later one', () => {
    const samples = audio(
      ['room', 0.5],
      ['speech', 11],
      ['room', 0.3],
      ['speech', 4],
      ['room', 0.3],
      ['speech', 10],
      ['room', 1]
    )
    const slices = planVadSlices(samples, SR, TWENTY)
    expectWellFormed(slices, samples.length, TWENTY_CAP)
    expect(slices).toEqual([
      { startSample: at(0.3), endSample: at(15.95) },
      { startSample: at(15.95), endSample: at(26.3) },
    ])
  })

  test('a pause before half the cap ends a slice only when it is longer than maxMergeGapMs', () => {
    const withPause = (seconds: number) =>
      audio(
        ['room', 0.5],
        ['speech', 5],
        ['room', seconds],
        ['speech', 7],
        ['room', 0.2],
        ['speech', 12],
        ['room', 1]
      )
    // 1 s at 5 s is longer than the 0.2 s at 13 s, but too early: the slice would be short.
    const short = withPause(1)
    expectWellFormed(planVadSlices(short, SR, TWENTY), short.length, TWENTY_CAP)
    expect(planVadSlices(short, SR, TWENTY)).toEqual([
      { startSample: at(0.3), endSample: at(13.6) },
      { startSample: at(13.6), endSample: at(25.9) },
    ])
    // 2 s always ends the slice, and what follows fits under the cap.
    expect(planVadSlices(withPause(2), SR, TWENTY)).toEqual([
      { startSample: at(0.3), endSample: at(5.7) },
      { startSample: at(7.3), endSample: at(26.9) },
    ])
  })

  test('a silence inside a masked region beats a shorter gap between regions', () => {
    // Silero heard 0-12 s and 12.2-30 s; loudness finds 0.5 s of silence at 16.2 s.
    const samples = audio(
      ['speech', 12],
      ['room', 0.2],
      ['speech', 4],
      ['room', 0.5],
      ['speech', 13.3]
    )
    const slices = planVadSlices(samples, SR, undefined, [
      { startSample: 0, endSample: at(12) },
      { startSample: at(12.2), endSample: samples.length },
    ])
    expect(slices).toEqual([
      { startSample: 0, endSample: at(16.45) },
      { startSample: at(16.45), endSample: samples.length },
    ])
  })

  test('random speech and short pauses: each cut is at the longest pause in reach', () => {
    // Whole frames, so the planner sees exactly these pauses.
    const frames = (seconds: number) => Math.round(seconds * 100) / 100
    for (const seed of [4, 5, 6]) {
      const random = noise(seed)
      const parts: Part[] = [['room', 0.5]]
      const runs: { start: number; end: number; gap: number }[] = []
      let t = 0.5
      while (t < 150) {
        const talk = frames(0.3 + 4 * Math.abs(random()))
        // 0.15-1 s: every one a pause, none long enough to end a slice on its own.
        const pause = frames(0.15 + 0.85 * Math.abs(random()))
        runs.push({ start: at(t), end: at(t + talk), gap: at(pause) })
        parts.push(['speech', talk], ['room', pause])
        t += talk + pause
      }
      const samples = audio(...parts)
      const slices = planVadSlices(samples, SR)
      expectWellFormed(slices, samples.length)
      for (const run of runs) {
        expect(covered(slices, run.start + 1, run.end - 1)).toBe(true)
      }
      const speechCap = CAP - 2 * at(0.2)
      for (const [i, slice] of slices.slice(0, -1).entries()) {
        const first = runs.find((run) => run.end > slice.startSample)!
        const before = runs.filter((run) => run.start < slice.endSample)
        const last = before[before.length - 1]
        const inReach = runs.filter(
          (run, k) =>
            k + 1 < runs.length &&
            run.end - first.start >= speechCap / 2 &&
            run.end - first.start <= speechCap
        )
        const longest = Math.max(...inReach.map((run) => run.gap))
        expect([i, last.gap]).toEqual([i, longest])
        // The later of equal pauses.
        const equal = inReach.filter((run) => run.gap === longest)
        expect(equal[equal.length - 1]).toBe(last)
      }
    }
  })
})

describe('planVadSlices: speech longer than the cap', () => {
  test('93 s without a pause: cut at the quietest 100 ms, every slice up to 30 s, nothing left out', () => {
    // 50 ms dips every 0.8 s are too short to be pauses; a soft 100 ms every 14 s is the
    // quietest place in each back half.
    const random = noise(3)
    const samples = new Float32Array(93 * SR)
    for (let i = 0; i < samples.length; i += 1) {
      const t = i / SR
      const dip = (t - 0.4) % 0.8 >= 0 && (t - 0.4) % 0.8 < 0.05
      const soft = t >= 13.95 && Math.abs(t - 14 * Math.round(t / 14)) < 0.05
      samples[i] = dip ? 0 : (soft ? 0.15 : 0.3) * random()
    }
    const slices = planVadSlices(samples, SR)
    expectWellFormed(slices, samples.length)
    expect(slices.map((s) => s.startSample)).toEqual([0, 28, 56, 84].map(at))
    // Contiguous: forced cuts meet exactly, from the first sample to the last.
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i].startSample).toBe(slices[i - 1].endSample)
    }
    expect(slices[slices.length - 1].endSample).toBe(samples.length)
  })

  test('a masked stretch is cut at the longest pause of its back half', () => {
    // Pauses of 500 ms at 5 s (front half), 300 ms at 12 s and 120 ms at 16 s.
    const samples = audio(
      ['speech', 5],
      ['room', 0.5],
      ['speech', 6.5],
      ['room', 0.3],
      ['speech', 3.7],
      ['room', 0.12],
      ['speech', 13.88]
    )
    // Silero heard one 30 s region; the pauses inside it come from loudness.
    const slices = planVadSlices(samples, SR, TWENTY, [
      { startSample: 0, endSample: samples.length },
    ])
    expect(slices).toEqual([
      { startSample: 0, endSample: at(12.15) },
      { startSample: at(12.15), endSample: samples.length },
    ])
  })

  test('the piece after a forced cut is kept even when it is shorter than minSpeechMs', () => {
    // 19.7 s of speech against a 19.6 s plan, quietest at 19.5 s: 0.2 s is left after the cut.
    const samples = audio(
      ['speech', 19.45],
      ['soft', 0.1],
      ['speech', 0.15],
      ['room', 3]
    )
    expect(planVadSlices(samples, SR, TWENTY)).toEqual([
      { startSample: 0, endSample: at(19.5) },
      { startSample: at(19.5), endSample: at(19.9) },
    ])
  })
})

describe('planVadSlices: default options are pinned', () => {
  // The crispasr `nt-vad` path (Edda and every other Speech Model without `whisperDecoding`)
  // plans with the defaults. These slices were taken from the planner before ekko got its
  // own option (#108); a change here changes what Edda decodes.
  test('a minute of mixed rooms, pauses and long speech plans exactly as before', () => {
    const samples = audio(
      ['hush', 0.6],
      ['speech', 4],
      ['room', 0.3],
      ['soft', 2],
      ['hush', 2.5],
      ['tone', 3],
      ['room', 6],
      ['speech', 5],
      ['zeros', 1.2],
      ['room', 0.5],
      ['speech', 12],
      ['room', 0.2],
      ['speech', 14],
      ['soft', 0.4],
      ['speech', 6],
      ['hush', 1]
    )
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: 6400, endSample: 113600 },
      { startSample: 147200, endSample: 201600 },
      { startSample: 291200, endSample: 377600 },
      { startSample: 398400, endSample: 823040 },
      { startSample: 823040, endSample: 926400 },
    ])
  })

  test('a pause of room noise above the floor stays inside one slice', () => {
    const samples = audio(
      ['hush', 1],
      ['tone', 3],
      ['room', 4],
      ['tone', 3],
      ['hush', 1]
    )
    expect(planVadSlices(samples, SR)).toEqual([
      { startSample: at(0.8), endSample: at(11.2) },
    ])
  })
})

describe('planVadSlices: pauseBelowSpeechDb', () => {
  const noisyPause = () =>
    audio(['hush', 1], ['tone', 3], ['room', 4], ['tone', 3], ['hush', 1])

  test('room noise far under the speech is a pause, so a long one ends the slice', () => {
    // The tone is about -13.5 dBFS and the room about -55: more than 35 dB under it.
    expect(planVadSlices(noisyPause(), SR, { pauseBelowSpeechDb: 35 })).toEqual(
      [
        { startSample: at(0.8), endSample: at(4.2) },
        { startSample: at(7.8), endSample: at(11.2) },
      ]
    )
  })
})

describe('planVadSlices: speechRegions', () => {
  test('the mask decides where speech is, clamped to the audio', () => {
    const samples = audio(['tone', 10])
    const slices = planVadSlices(samples, SR, { maxSliceSeconds: 5 }, [
      { startSample: at(8), endSample: at(12) },
      { startSample: at(2), endSample: at(5) },
    ])
    expect(slices).toEqual([
      { startSample: at(1.8), endSample: at(5.2) },
      { startSample: at(7.8), endSample: samples.length },
    ])
  })

  test('a mask region shorter than minSpeechMs is dropped like any other', () => {
    const samples = audio(['tone', 10])
    expect(
      planVadSlices(samples, SR, undefined, [
        { startSample: at(3), endSample: at(3.1) },
      ])
    ).toEqual([])
  })
})

describe('vadImportJson', () => {
  test('the chunks file crispasr reads, with no chunk_cs', () => {
    expect(
      vadImportJson(
        [
          { startSample: 0, endSample: 16_000 },
          { startSample: 16_000, endSample: 40_123 },
        ],
        SR
      )
    ).toBe(
      '{"crispasr_vad":{"version":1,"kind":"chunks","sample_rate":16000,"num_slices":2,"slices":[' +
        '{"start":0,"end":16000,"t0_cs":0,"t1_cs":100},' +
        '{"start":16000,"end":40123,"t0_cs":100,"t1_cs":251}]}}'
    )
  })

  test('no slices, and a fraction refused', () => {
    expect(vadImportJson([], SR)).toBe(
      '{"crispasr_vad":{"version":1,"kind":"chunks","sample_rate":16000,"num_slices":0,"slices":[]}}'
    )
    expect(() =>
      vadImportJson([{ startSample: 0.5, endSample: 100 }], SR)
    ).toThrow(/whole numbers/)
  })
})

function chunk(id: string, body: Uint8Array, declaredSize = body.length) {
  const out = new Uint8Array(8 + body.length + (body.length % 2))
  out.set(new TextEncoder().encode(id), 0)
  new DataView(out.buffer).setUint32(4, declaredSize, true)
  out.set(body, 8)
  return out
}

function fmtBody(
  format: number,
  channels: number,
  bits: number,
  sampleRate = SR
) {
  const extensible = format === 0xfffe
  const body = new Uint8Array(extensible ? 40 : 16)
  const view = new DataView(body.buffer)
  view.setUint16(0, format, true)
  view.setUint16(2, channels, true)
  view.setUint32(4, sampleRate, true)
  view.setUint32(8, sampleRate * channels * (bits / 8), true)
  view.setUint16(12, channels * (bits / 8), true)
  view.setUint16(14, bits, true)
  if (extensible) {
    view.setUint16(16, 22, true)
    view.setUint16(24, 3, true) // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
  }
  return body
}

function int16Body(...values: number[]) {
  const body = new Uint8Array(values.length * 2)
  values.forEach((v, i) => new DataView(body.buffer).setInt16(i * 2, v, true))
  return body
}

function float32Body(...values: number[]) {
  const body = new Uint8Array(values.length * 4)
  values.forEach((v, i) => new DataView(body.buffer).setFloat32(i * 4, v, true))
  return body
}

function wav(...chunks: Uint8Array[]) {
  const riff = new TextEncoder().encode('RIFF\0\0\0\0WAVE')
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, riff.length))
  out.set(riff, 0)
  let offset = riff.length
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('readWavSamples', () => {
  test('16-bit mono', () => {
    const { samples, sampleRate } = readWavSamples(
      wav(
        chunk('fmt ', fmtBody(1, 1, 16)),
        chunk('data', int16Body(0, 16384, -32768))
      )
    )
    expect(sampleRate).toBe(SR)
    expect([...samples]).toEqual([0, 0.5, -1])
  })

  test('16-bit stereo is averaged to mono, past a LIST chunk with an odd size', () => {
    const { samples } = readWavSamples(
      wav(
        chunk('fmt ', fmtBody(1, 2, 16)),
        chunk('LIST', new Uint8Array(3)),
        chunk('data', int16Body(16384, 0, -16384, -16384))
      )
    )
    expect([...samples]).toEqual([0.25, -0.5])
  })

  test('32-bit float, plain and WAVE_FORMAT_EXTENSIBLE, at its own sample rate', () => {
    const plain = readWavSamples(
      wav(
        chunk('fmt ', fmtBody(3, 1, 32, 48_000)),
        chunk('data', float32Body(0.25, -0.75))
      )
    )
    expect(plain.sampleRate).toBe(48_000)
    expect([...plain.samples]).toEqual([0.25, -0.75])
    const extensible = readWavSamples(
      wav(
        chunk('fmt ', fmtBody(0xfffe, 1, 32)),
        chunk('data', float32Body(0.5))
      )
    )
    expect([...extensible.samples]).toEqual([0.5])
  })

  test('an unfinished header (data size 0) is read to the end of the file', () => {
    const { samples } = readWavSamples(
      wav(
        chunk('fmt ', fmtBody(1, 1, 16)),
        chunk('data', int16Body(16384, 16384), 0)
      )
    )
    expect([...samples]).toEqual([0.5, 0.5])
  })

  test('anything else throws a clear error', () => {
    expect(() => readWavSamples(new Uint8Array(4))).toThrow(
      'not a RIFF/WAVE file'
    )
    expect(() =>
      readWavSamples(
        wav(chunk('fmt ', fmtBody(1, 1, 24)), chunk('data', new Uint8Array(6)))
      )
    ).toThrow('unsupported WAV format 1 at 24 bits')
    expect(() =>
      readWavSamples(
        wav(chunk('fmt ', fmtBody(1, 1, 8)), chunk('data', new Uint8Array(2)))
      )
    ).toThrow(/unsupported WAV format/)
    expect(() => readWavSamples(wav(chunk('data', int16Body(1))))).toThrow(
      'WAV data chunk comes before its fmt chunk'
    )
    expect(() => readWavSamples(wav(chunk('fmt ', fmtBody(1, 1, 16))))).toThrow(
      'WAV has no data chunk'
    )
  })
})
