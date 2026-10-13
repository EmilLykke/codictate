import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTimedTranscript } from '../../../../shared/timed-transcript'
import {
  crispasrTranscript,
  parseCrispasrJson,
  type CrispasrJsonParse,
} from './crispasr-json'

/**
 * Real `-ojf` files from the bundled crispasr v0.8.41, only the absolute model path replaced:
 * - turbo-en.json: large-v3-turbo-q5_0, stock whisper writer, `"` escaped in the text.
 * - small-da-split-utf8.json: small-q5_1 on Danish, stock whisper writer, "Ø" split across
 *   two tokens (`" \xc3"`, `"\x98"`), so the file is not UTF-8 token by token.
 * - edda-da-nt-vad.json: Edda q5_0, `--backend whisper -nt --vad`, dispatcher writer, times
 *   negative and past the end of the 15 s clip.
 * - hviske-da-cohere.json: hviske q5_0, `--backend cohere -nt`, dispatcher writer.
 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', name)))
}

function ok(parsed: CrispasrJsonParse) {
  if (!parsed.ok) throw new Error(`${parsed.reason}: ${parsed.detail}`)
  return parsed
}

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...new TextEncoder().encode(part)] : part
    )
  )

describe('parseCrispasrJson on real crispasr output', () => {
  test('turbo, English: text and segment times in seconds, no words on the timestamps path', () => {
    const parsed = ok(parseCrispasrJson(fixture('turbo-en.json')))
    expect(parsed.language).toBe('en')
    expect(parsed.segments).toHaveLength(1)
    const [segment] = parsed.segments
    expect(segment.text).toBe(` "'Stuff it into you,' his belly counseled him.`)
    expect(segment.start).toBe(0)
    expect(segment.end).toBe(2.8)
    expect(segment.tokens.length).toBeGreaterThan(0)

    const { rawTranscript, timedTranscript } = crispasrTranscript(
      parsed,
      'timestamps'
    )
    expect(rawTranscript).toBe(`"'Stuff it into you,' his belly counseled him.`)
    expect(isTimedTranscript(timedTranscript)).toBe(true)
    // With the VAD the token times are in its own timeline (whisper.cpp #4046), so the part
    // keeps its segment time and gets no words, though the tokens are right there.
    expect(timedTranscript!.parts).toEqual([
      { text: rawTranscript, start: 0, end: 2.8 },
    ])
  })

  test('small, Danish: a file that is not UTF-8 token by token still reads, by its segment text', () => {
    const raw = fixture('small-da-split-utf8.json')
    expect(new TextDecoder().decode(raw)).toContain('�') // not UTF-8 as a whole
    const parsed = ok(parseCrispasrJson(raw))
    const [segment] = parsed.segments
    expect(segment.text.startsWith(' Øgrummen ligger 120 km')).toBe(true)

    const { rawTranscript, timedTranscript } = crispasrTranscript(
      parsed,
      'timestamps'
    )
    expect(rawTranscript).toBe(segment.text.trim())
    expect(timedTranscript!.parts[0].text).toBe(rawTranscript)
    expect(timedTranscript!.parts[0].words).toBeUndefined()
  })

  test('Edda on the VAD path: the transcript is read, its unusable times are not', () => {
    const parsed = ok(parseCrispasrJson(fixture('edda-da-nt-vad.json')))
    expect(parsed.language).toBe('da')
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0].start).toBeLessThan(0)
    const { rawTranscript, timedTranscript } = crispasrTranscript(
      parsed,
      'nt-vad'
    )
    expect(rawTranscript).toBe(
      'Som i alle sydafrikanske nationalparker, er der daglige besvarelses- og adgangsgebyrer til parken. Dette er en vigtig måde at skelne mellem nogle verber og objektiver.'
    )
    expect(timedTranscript).toBeNull()
    // Even if a caller forgot the decoding, negative times never make a Timed Transcript.
    expect(crispasrTranscript(parsed, 'timestamps').timedTranscript).toBeNull()
  })

  test('hviske on cohere: dispatcher tokens become words with times', () => {
    const parsed = ok(parseCrispasrJson(fixture('hviske-da-cohere.json')))
    const { rawTranscript, timedTranscript } = crispasrTranscript(
      parsed,
      'cohere'
    )
    expect(rawTranscript).toBe(
      'Som i alle sydafrikanske nationalparker er der daglige besvarelses og adgangsgebyrer til parken. Dette er en vigtig måde at skelne mellem nogle verbere og objektiver'
    )
    expect(isTimedTranscript(timedTranscript)).toBe(true)
    const part = timedTranscript!.parts[0]
    expect(part.start).toBe(1.44)
    expect(part.end).toBe(13.05)
    expect(part.words!.slice(0, 3)).toEqual([
      { text: 'Som', start: 1.44, end: 1.44 },
      { text: 'i', start: 1.44, end: 1.44 },
      { text: 'alle', start: 1.44, end: 1.84 },
    ])
    expect(part.words!.map((w) => w.text).join(' ')).toBe(rawTranscript)
  })
})

describe('parseCrispasrJson on what the old writer can produce', () => {
  test('raw control characters inside strings are escaped, not fatal', () => {
    const parsed = ok(
      parseCrispasrJson(
        bytes(
          '{"transcription":[{"offsets":{"from":0,"to":1000},"text":" a\tb',
          [0x01],
          'c","tokens":[]}]}'
        )
      )
    )
    expect(parsed.segments[0].text).toBe(' a\tb\u0001c')
  })

  test('a character split in segment text is not_utf8', () => {
    const broken = parseCrispasrJson(
      bytes('{"transcription":[{"text":" bl', [0xc3], '"}]}')
    )
    expect(broken).toMatchObject({ ok: false, reason: 'not_utf8' })
  })

  test('tokens without offsets are dropped', () => {
    const parsed = ok(
      parseCrispasrJson(
        bytes(
          JSON.stringify({
            transcription: [
              {
                offsets: { from: 1000, to: 2000 },
                text: 'Hi there',
                tokens: [
                  { text: ' Hi', offsets: { from: 1000, to: 1400 } },
                  { text: ' there' },
                ],
              },
            ],
          })
        )
      )
    )
    expect(parsed.segments[0].tokens).toEqual([
      { text: ' Hi', start: 1, end: 1.4 },
    ])
    // The words no longer spell the part out, so the part keeps its own time and no words.
    const { timedTranscript } = crispasrTranscript(parsed, 'cohere')
    expect(timedTranscript!.parts).toEqual([
      { text: 'Hi there', start: 1, end: 2 },
    ])
  })

  test('a bare nan number does not make the file unreadable', () => {
    const parsed = ok(
      parseCrispasrJson(
        bytes(
          '{"transcription":[{"offsets":{"from":0,"to":500},"text":" nan inf","tokens":[{"text":" nan","p":-nan,"offsets":{"from":0,"to":500}}]}]}'
        )
      )
    )
    expect(parsed.segments[0].text).toBe(' nan inf')
  })

  test('not JSON, and JSON without a transcription', () => {
    expect(
      parseCrispasrJson(bytes('[00:00.000 --> 00:01.000] hi'))
    ).toMatchObject({ ok: false, reason: 'not_json' })
    expect(parseCrispasrJson(bytes(''))).toMatchObject({
      ok: false,
      reason: 'not_json',
    })
    expect(parseCrispasrJson(bytes('{"result":{}}'))).toMatchObject({
      ok: false,
      reason: 'no_transcription',
    })
    expect(
      parseCrispasrJson(bytes('{"transcription":[{"offsets":{}}]}'))
    ).toMatchObject({ ok: false, reason: 'no_transcription' })
  })

  test('a run that heard nothing is an empty transcript, not a failure', () => {
    const empty = ok(parseCrispasrJson(bytes('{"transcription":[]}')))
    expect(crispasrTranscript(empty, 'timestamps')).toEqual({
      rawTranscript: '',
      timedTranscript: null,
    })
    // hviske on silence writes one empty segment at 0.
    const silent = ok(
      parseCrispasrJson(
        bytes('{"transcription":[{"offsets":{"from":0,"to":0},"text":""}]}')
      )
    )
    expect(crispasrTranscript(silent, 'cohere')).toEqual({
      rawTranscript: '',
      timedTranscript: null,
    })
  })
})

describe('crispasrTranscript joins and times', () => {
  const segment = (text: string, start: number, end: number) => ({
    text,
    start,
    end,
    tokens: [],
  })

  test('Whisper segments with leading spaces join as written, a continued word stays glued', () => {
    const { rawTranscript, timedTranscript } = crispasrTranscript(
      {
        segments: [
          segment(' Hello wor', 0, 1),
          segment('ld, again.', 1, 2),
          segment(' Bye.', 2.5, 3),
        ],
      },
      'timestamps'
    )
    expect(rawTranscript).toBe('Hello world, again. Bye.')
    expect(timedTranscript!.parts.map((p) => p.text)).toEqual([
      'Hello wor',
      'ld, again.',
      'Bye.',
    ])
  })

  test('segments without leading spaces (hviske, Edda) join with one space', () => {
    const { rawTranscript } = crispasrTranscript(
      { segments: [segment('Hej med dig', 0, 1), segment('Farvel', 2, 3)] },
      'cohere'
    )
    expect(rawTranscript).toBe('Hej med dig Farvel')
  })

  test('times that are all zero, or run backwards by more than a second, give no timings', () => {
    expect(
      crispasrTranscript(
        { segments: [segment(' a', 0, 0), segment(' b', 0, 0)] },
        'timestamps'
      ).timedTranscript
    ).toBeNull()
    expect(
      crispasrTranscript(
        { segments: [segment(' a', 10, 12), segment(' b', 8, 9)] },
        'timestamps'
      ).timedTranscript
    ).toBeNull()
    expect(
      crispasrTranscript(
        { segments: [segment(' a', 10, 12), segment(' b', 9.5, 13)] },
        'timestamps'
      ).timedTranscript
    ).not.toBeNull()
    expect(
      crispasrTranscript({ segments: [segment(' a', NaN, NaN)] }, 'timestamps')
        .timedTranscript
    ).toBeNull()
  })
})
