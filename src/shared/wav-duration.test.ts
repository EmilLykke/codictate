import { describe, expect, it } from 'bun:test'
import {
  estimateWavDurationMsFromBytes,
  estimateWavDurationSecFromBytes,
} from './wav-duration'

/**
 * The recorder trusts this to decide whether a capture was too short to
 * transcribe, so a malformed header has to answer `null` rather than a
 * plausible number.
 */

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

/** A chunk, word aligned: an odd body is followed by a pad byte. */
function chunk(id: string, body: Uint8Array): Uint8Array {
  const padding = body.length % 2
  const out = new Uint8Array(8 + body.length + padding)
  out.set(ascii(id), 0)
  new DataView(out.buffer).setUint32(4, body.length, true)
  out.set(body, 8)
  return out
}

function fmtBody(extraBytes = 0): Uint8Array {
  const body = new Uint8Array(16 + extraBytes)
  const view = new DataView(body.buffer)
  view.setUint16(0, 1, true) // PCM
  view.setUint16(2, CHANNELS, true)
  view.setUint32(4, SAMPLE_RATE, true)
  view.setUint32(8, SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), true)
  view.setUint16(12, CHANNELS * (BITS_PER_SAMPLE / 8), true)
  view.setUint16(14, BITS_PER_SAMPLE, true)
  return body
}

function riff(chunks: Uint8Array[], magic = 'WAVE'): Uint8Array {
  const payload = chunks.reduce((total, c) => total + c.length, 0)
  const out = new Uint8Array(12 + payload)
  out.set(ascii('RIFF'), 0)
  new DataView(out.buffer).setUint32(4, 4 + payload, true)
  out.set(ascii(magic), 8)
  let off = 12
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** `frames` frames of silence, which is all the walk reads of the audio. */
function dataChunk(frames: number): Uint8Array {
  return chunk(
    'data',
    new Uint8Array(frames * CHANNELS * (BITS_PER_SAMPLE / 8))
  )
}

describe('estimateWavDurationSecFromBytes', () => {
  it('reads the duration of a 16-bit mono WAV', () => {
    const wav = riff([chunk('fmt ', fmtBody()), dataChunk(SAMPLE_RATE / 2)])

    expect(estimateWavDurationSecFromBytes(wav)).toBe(0.5)
  })

  it('returns null for a stream shorter than a WAV header', () => {
    expect(estimateWavDurationSecFromBytes(new Uint8Array(20))).toBeNull()
  })

  it('returns null when the RIFF magic is missing', () => {
    const wav = riff([chunk('fmt ', fmtBody()), dataChunk(SAMPLE_RATE)])
    wav.set(ascii('RIFX'), 0)

    expect(estimateWavDurationSecFromBytes(wav)).toBeNull()
  })

  it('returns null when the WAVE magic is missing', () => {
    const wav = riff([chunk('fmt ', fmtBody()), dataChunk(SAMPLE_RATE)], 'AVI ')

    expect(estimateWavDurationSecFromBytes(wav)).toBeNull()
  })

  it('walks past the pad byte of an odd-sized fmt chunk', () => {
    const wav = riff([chunk('fmt ', fmtBody(1)), dataChunk(SAMPLE_RATE / 4)])

    expect(estimateWavDurationSecFromBytes(wav)).toBe(0.25)
  })

  it('returns null when there is no data chunk', () => {
    const wav = riff([
      chunk('fmt ', fmtBody()),
      chunk('LIST', new Uint8Array(16)),
    ])

    expect(estimateWavDurationSecFromBytes(wav)).toBeNull()
  })
})

describe('estimateWavDurationMsFromBytes', () => {
  it('floors the duration to whole milliseconds', () => {
    const wav = riff([chunk('fmt ', fmtBody()), dataChunk(SAMPLE_RATE / 2 + 7)])

    expect(estimateWavDurationMsFromBytes(wav)).toBe(500)
  })

  it('passes null through so a malformed header is not a zero-length one', () => {
    expect(estimateWavDurationMsFromBytes(new Uint8Array(20))).toBeNull()
  })
})
