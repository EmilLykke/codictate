import { describe, expect, test } from 'bun:test'
import {
  isTimedTranscript,
  joinTranscriptPieces,
  timedTranscriptFromPieces,
} from './timed-transcript'

describe('joinTranscriptPieces', () => {
  test('Whisper pieces carry their own leading space and are joined as written', () => {
    expect(joinTranscriptPieces([' Hello there.', ' How are', ' you?'])).toBe(
      'Hello there. How are you?'
    )
  })

  test('a Whisper piece that continues a word stays glued to it', () => {
    expect(joinTranscriptPieces([' The quar', 'terly', ' numbers.'])).toBe(
      'The quarterly numbers.'
    )
  })

  test('Edda-style and Parakeet pieces get one space between them', () => {
    expect(joinTranscriptPieces(['Hej med dig.', 'Hvordan går det?'])).toBe(
      'Hej med dig. Hvordan går det?'
    )
  })

  test('a piece that already ends in whitespace gets no second space', () => {
    expect(joinTranscriptPieces(['One. ', 'Two.'])).toBe('One. Two.')
  })

  test('scripts written without spaces are glued, CJK punctuation included', () => {
    expect(joinTranscriptPieces(['今日は良い天気', 'ですね。'])).toBe(
      '今日は良い天気ですね。'
    )
    expect(joinTranscriptPieces(['今日は良い天気ですね。', '明日も'])).toBe(
      '今日は良い天気ですね。明日も'
    )
    expect(joinTranscriptPieces(['你好！', '谢谢'])).toBe('你好！谢谢')
    expect(joinTranscriptPieces(['สวัสดี', 'ครับ'])).toBe('สวัสดีครับ')
  })

  test('a no-space script next to a Latin one still gets a space', () => {
    expect(joinTranscriptPieces(['iPhone', 'を買った'])).toBe('iPhone を買った')
  })

  test('empty and whitespace-only pieces are dropped, and the ends trimmed', () => {
    expect(joinTranscriptPieces(['', '  ', 'One.', '', 'Two.  '])).toBe(
      'One. Two.'
    )
    expect(joinTranscriptPieces([])).toBe('')
    expect(joinTranscriptPieces([' ', ''])).toBe('')
  })

  test('nothing inside a piece is touched', () => {
    expect(joinTranscriptPieces(['a  b', 'c\nd'])).toBe('a  b c\nd')
  })

  test('separate decodes always meet at a word boundary, whatever the others start with', () => {
    const pieces = [' Hej med dig', 'Farvel', ' og tak.', 'Vi ses ', 'igen']
    expect(joinTranscriptPieces(pieces, { separateDecodes: true })).toBe(
      'Hej med dig Farvel og tak. Vi ses igen'
    )
    expect(joinTranscriptPieces(pieces)).toBe(
      'Hej med digFarvel og tak.Vi ses igen'
    )
    expect(
      joinTranscriptPieces(['今日は良い天気', 'ですね。'], {
        separateDecodes: true,
      })
    ).toBe('今日は良い天気ですね。')
  })
})

describe('timedTranscriptFromPieces', () => {
  test('parts are the trimmed pieces, in order, with their times', () => {
    const text = 'Hello there. How are you?'
    expect(
      timedTranscriptFromPieces(text, [
        { text: ' Hello there.', start: 0, end: 1.2 },
        { text: ' How are you?', start: 1.5, end: 2.4 },
      ])
    ).toEqual({
      text,
      parts: [
        { text: 'Hello there.', start: 0, end: 1.2 },
        { text: 'How are you?', start: 1.5, end: 2.4 },
      ],
    })
  })

  test('pieces glued mid-word line up', () => {
    const t = timedTranscriptFromPieces('The quarterly numbers.', [
      { text: ' The quar', start: 0, end: 1 },
      { text: 'terly', start: 1, end: 1.4 },
      { text: ' numbers.', start: 1.4, end: 2 },
    ])
    expect(t?.parts.map((p) => p.text)).toEqual([
      'The quar',
      'terly',
      'numbers.',
    ])
  })

  test('pieces that do not spell out the text give null, never an approximation', () => {
    const text = 'Hello there.'
    expect(
      timedTranscriptFromPieces(text, [
        { text: 'Hello here.', start: 0, end: 1 },
      ])
    ).toBeNull()
    // Something said that the pieces leave out.
    expect(
      timedTranscriptFromPieces(text, [{ text: 'Hello', start: 0, end: 1 }])
    ).toBeNull()
    // Out of order.
    expect(
      timedTranscriptFromPieces(text, [
        { text: 'there.', start: 0, end: 1 },
        { text: 'Hello', start: 1, end: 2 },
      ])
    ).toBeNull()
    expect(timedTranscriptFromPieces(text, [])).toBeNull()
  })

  test('an untrimmed or empty text, or a time that is not a time, gives null', () => {
    const piece = { text: 'Hi.', start: 0, end: 1 }
    expect(timedTranscriptFromPieces(' Hi.', [piece])).toBeNull()
    expect(timedTranscriptFromPieces('', [piece])).toBeNull()
    expect(
      timedTranscriptFromPieces('Hi.', [{ ...piece, start: Number.NaN }])
    ).toBeNull()
    expect(timedTranscriptFromPieces('Hi.', [{ ...piece, end: -1 }])).toBeNull()
    expect(
      timedTranscriptFromPieces('Hi.', [{ ...piece, end: Infinity }])
    ).toBeNull()
  })

  test('an end before its start is raised to the start', () => {
    expect(
      timedTranscriptFromPieces('Hi.', [{ text: 'Hi.', start: 2, end: 1 }])
        ?.parts
    ).toEqual([{ text: 'Hi.', start: 2, end: 2 }])
  })

  test('empty pieces are skipped', () => {
    expect(
      timedTranscriptFromPieces('Hi.', [
        { text: ' ', start: 0, end: 0.1 },
        { text: 'Hi.', start: 0.1, end: 1 },
      ])?.parts
    ).toEqual([{ text: 'Hi.', start: 0.1, end: 1 }])
  })

  test('words that line up are kept on their part', () => {
    const t = timedTranscriptFromPieces('Hello there.', [
      {
        text: ' Hello there.',
        start: 0,
        end: 1,
        words: [
          { text: ' Hello', start: 0, end: 0.4 },
          { text: ' there', start: 0.5, end: 0.8 },
          { text: '.', start: 0.8, end: 1 },
        ],
      },
    ])
    expect(t?.parts[0].words).toEqual([
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'there', start: 0.5, end: 0.8 },
      { text: '.', start: 0.8, end: 1 },
    ])
  })

  test('words that do not line up are dropped and the part keeps its own timing', () => {
    const part = { text: 'Twenty five dollars.', start: 3, end: 5 }
    const t = timedTranscriptFromPieces('Twenty five dollars.', [
      {
        ...part,
        words: [
          { text: '25', start: 3, end: 4 },
          { text: 'dollars.', start: 4, end: 5 },
        ],
      },
    ])
    expect(t).toEqual({ text: part.text, parts: [part] })
    expect(t?.parts[0]).not.toHaveProperty('words')
  })
})

describe('isTimedTranscript', () => {
  const valid = {
    text: 'Hello there. Bye.',
    parts: [
      {
        text: 'Hello there.',
        start: 0,
        end: 1,
        words: [
          { text: 'Hello', start: 0, end: 0.4 },
          { text: 'there.', start: 0.5, end: 1 },
        ],
      },
      { text: 'Bye.', start: 1.5, end: 2 },
    ],
  }

  test('accepts what timedTranscriptFromPieces builds', () => {
    expect(isTimedTranscript(valid)).toBe(true)
    const built = timedTranscriptFromPieces(valid.text, valid.parts)
    expect(built).toEqual(valid)
    expect(isTimedTranscript(built)).toBe(true)
  })

  test('refuses what it would have to correct', () => {
    const [first, second] = valid.parts
    const variants: unknown[] = [
      { ...valid, text: 'Hello there.' },
      { ...valid, parts: [{ ...first, text: ' Hello there.' }, second] },
      { ...valid, parts: [first, { ...second, end: 1 }] },
      { ...valid, parts: [first, { text: ' ', start: 1, end: 1 }, second] },
      {
        ...valid,
        parts: [
          { ...first, words: [{ text: 'Hullo', start: 0, end: 1 }] },
          second,
        ],
      },
      { ...valid, parts: [{ ...first, words: [] }, second] },
      { ...valid, parts: [] },
    ]
    for (const v of variants) expect(isTimedTranscript(v)).toBe(false)
  })

  test('refuses the wrong shape without throwing', () => {
    const junk: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { text: 'x' },
      { text: 'x', parts: {} },
      { text: 'x', parts: [null] },
      { text: 'x', parts: [{ text: 'x', start: '0', end: 1 }] },
      { text: 'x', parts: [{ text: 'x', start: 0, end: 1, words: 'x' }] },
      { text: 'x', parts: [{ text: 'x', start: 0, end: 1, words: [null] }] },
      { text: 7, parts: [] },
    ]
    for (const v of junk) expect(isTimedTranscript(v)).toBe(false)
  })
})
