import { describe, expect, test } from 'bun:test'
import { locateWavData } from './growing-wav'

function chunk(id: string, body: Uint8Array, declaredSize = body.length) {
  const out = new Uint8Array(8 + body.length + (body.length % 2))
  out.set(new TextEncoder().encode(id), 0)
  new DataView(out.buffer).setUint32(4, declaredSize, true)
  out.set(body, 8)
  return out
}

function fmtBody(channels = 1, sampleRate = 16_000, bits = 16, format = 1) {
  const body = new Uint8Array(16)
  const view = new DataView(body.buffer)
  view.setUint16(0, format, true)
  view.setUint16(2, channels, true)
  view.setUint32(4, sampleRate, true)
  view.setUint32(8, sampleRate * channels * (bits / 8), true)
  view.setUint16(12, channels * (bits / 8), true)
  view.setUint16(14, bits, true)
  return body
}

function wav(...chunks: Uint8Array[]) {
  const riff = new TextEncoder().encode('RIFF\0\0\0\0WAVE')
  const total = chunks.reduce((n, c) => n + c.length, riff.length)
  const out = new Uint8Array(total)
  out.set(riff, 0)
  let offset = riff.length
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('locateWavData', () => {
  test('a plain 44-byte header, as hound writes it while recording', () => {
    // hound leaves the data size at 0 until finalize.
    const bytes = wav(
      chunk('fmt ', fmtBody()),
      chunk('data', new Uint8Array(0), 0)
    )
    expect(locateWavData(bytes)).toEqual({
      status: 'ok',
      dataOffset: 44,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
    })
  })

  test('skips a FLLR padding chunk, as AVAudioRecorder writes it', () => {
    const bytes = wav(
      chunk('fmt ', fmtBody()),
      chunk('FLLR', new Uint8Array(4000)),
      chunk('data', new Uint8Array(10), 0xffffffff)
    )
    const found = locateWavData(bytes)
    expect(found).toMatchObject({
      status: 'ok',
      dataOffset: 12 + 24 + 4008 + 8,
    })
  })

  test('a header that is still being written is incomplete', () => {
    const bytes = wav(
      chunk('fmt ', fmtBody()),
      chunk('data', new Uint8Array(0))
    )
    expect(locateWavData(bytes.subarray(0, 8)).status).toBe('incomplete')
    expect(locateWavData(bytes.subarray(0, 30)).status).toBe('incomplete')
    expect(locateWavData(bytes.subarray(0, 40)).status).toBe('incomplete')
  })

  test('not a WAV, or not PCM, is unreadable', () => {
    expect(
      locateWavData(new TextEncoder().encode('ID3 not a wave file')).status
    ).toBe('unreadable')
    const float = wav(
      chunk('fmt ', fmtBody(1, 16_000, 32, 3)),
      chunk('data', new Uint8Array(0))
    )
    expect(locateWavData(float).status).toBe('unreadable')
  })

  test('reports the format so the caller can refuse anything but 16-bit mono', () => {
    const stereo = wav(
      chunk('fmt ', fmtBody(2, 48_000)),
      chunk('data', new Uint8Array(0))
    )
    expect(locateWavData(stereo)).toMatchObject({
      status: 'ok',
      channels: 2,
      sampleRate: 48_000,
    })
  })
})
