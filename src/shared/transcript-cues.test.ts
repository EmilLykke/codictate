import { describe, expect, test } from 'bun:test'
import {
  buildCues,
  CAPTION_CUE_RULES,
  type TranscriptCue,
} from './transcript-cues'
import {
  timedTranscriptFromPieces,
  type TimedPiece,
  type TimedTranscript,
} from './timed-transcript'

function timed(text: string, pieces: TimedPiece[]): TimedTranscript {
  const t = timedTranscriptFromPieces(text, pieces)
  if (t === null) throw new Error(`pieces do not spell out: ${text}`)
  return t
}

/** One part, one word per whitespace-separated word, back to back at `seconds` each. */
function evenlyTimed(text: string, seconds = 0.3): TimedTranscript {
  const words = text.split(' ').map((word, i) => ({
    text: word,
    start: i * seconds,
    end: (i + 1) * seconds,
  }))
  return timed(text, [
    { text, start: 0, end: words[words.length - 1].end, words },
  ])
}

/** The cue texts are spans of `text`, in order, with only whitespace between and around them. */
function expectSpellsOut(text: string, cues: TranscriptCue[]): void {
  let cursor = 0
  for (const cue of cues) {
    const at = text.indexOf(cue.text, cursor)
    expect(at).toBeGreaterThanOrEqual(cursor)
    expect(text.slice(cursor, at).trim()).toBe('')
    cursor = at + cue.text.length
  }
  expect(text.slice(cursor).trim()).toBe('')
  for (const cue of cues) {
    expect(cue.lines.join(' ').replace(/\s+/g, '')).toBe(
      cue.text.replace(/\s+/g, '')
    )
  }
}

function expectWellFormed(cues: TranscriptCue[]): void {
  cues.forEach((cue, i) => {
    expect(cue.end - cue.start).toBeGreaterThanOrEqual(0.1 - 1e-9)
    if (i > 0) expect(cue.start).toBeGreaterThanOrEqual(cues[i - 1].end)
    expect(cue.lines.length).toBeGreaterThanOrEqual(1)
    expect(cue.lines.length).toBeLessThanOrEqual(2)
    for (const line of cue.lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(42)
    }
  })
}

const LONG =
  'we looked at the quarterly numbers and the growth in the northern region ' +
  'was stronger than anyone expected so the board asked for a second look at ' +
  'the forecast for the rest of the year and the hiring plan that goes with it'

describe('caption rules', () => {
  test('are 42 characters, 2 lines, 7 seconds and a 0.6 s pause', () => {
    expect(CAPTION_CUE_RULES).toEqual({
      maxCharsPerLine: 42,
      maxLines: 2,
      maxSeconds: 7,
      pauseSeconds: 0.6,
    })
  })
})

describe('buildCues', () => {
  test('a short transcript is one cue on one line', () => {
    const t = timed('Hello there', [
      { text: 'Hello there', start: 0.5, end: 1.4 },
    ])
    expect(buildCues(t)).toEqual([
      { start: 0.5, end: 1.4, text: 'Hello there', lines: ['Hello there'] },
    ])
  })

  test('no line is longer than 42 characters and no cue has more than 2 lines', () => {
    const t = evenlyTimed(LONG, 0.1)
    const cues = buildCues(t)
    expect(cues.length).toBeGreaterThan(1)
    expectWellFormed(cues)
    expectSpellsOut(LONG, cues)
    // Filled as far as two lines go: the next word would not have fitted.
    const [first, second] = cues
    const withNext = `${first.text} ${second.text.split(' ')[0]}`
    expect(withNext.length).toBeGreaterThan(42 * 2 - 1)
  })

  test('two lines break at the space nearest the middle', () => {
    const text = 'one two three four five six seven eight nine ten eleven'
    const [cue] = buildCues(evenlyTimed(text, 0.1))
    expect(cue.text).toBe(text)
    expect(cue.lines).toEqual([
      'one two three four five six',
      'seven eight nine ten eleven',
    ])
  })

  test('a cue never runs past 7 seconds', () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const cues = buildCues(evenlyTimed(text, 0.5))
    expect(cues.length).toBeGreaterThan(2)
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(7)
    }
    expect(cues[0].text.split(' ')).toHaveLength(14)
    expectSpellsOut(text, cues)
  })

  test('a pause longer than 0.6 s starts a new cue, a shorter one does not', () => {
    const text = 'before the pause after it'
    const words = [
      { text: 'before', start: 0, end: 0.3 },
      { text: 'the', start: 0.3, end: 0.5 },
      { text: 'pause', start: 1.0, end: 1.3 }, // 0.5 s gap
      { text: 'after', start: 2.0, end: 2.3 }, // 0.7 s gap
      { text: 'it', start: 2.3, end: 2.5 },
    ]
    const cues = buildCues(timed(text, [{ text, start: 0, end: 2.5, words }]))
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([
      ['before the pause', 0, 1.3],
      ['after it', 2.0, 2.5],
    ])
  })

  test('a pause between parts counts too', () => {
    const text = 'first part second part'
    const cues = buildCues(
      timed(text, [
        { text: 'first part', start: 0, end: 1 },
        { text: 'second part', start: 1.8, end: 2.5 },
      ])
    )
    expect(cues.map((c) => c.text)).toEqual(['first part', 'second part'])
  })

  test('a sentence end starts a new cue', () => {
    const text = 'Yes. Really? Wow! He said "done." Then… more'
    const cues = buildCues(evenlyTimed(text, 0.2))
    expect(cues.map((c) => c.text)).toEqual([
      'Yes.',
      'Really?',
      'Wow!',
      'He said "done."',
      'Then…',
      'more',
    ])
  })

  test('a part without words is split on whitespace, its time shared out by character', () => {
    // 20 characters over 10 s: half a second per character.
    const text = 'One two. Three four.'
    const cues = buildCues(timed(text, [{ text, start: 0, end: 10 }]))
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([
      ['One two.', 0, 4],
      ['Three four.', 4.5, 10],
    ])
  })

  test('a 16 s part without words still makes cues of 7 s or less', () => {
    const text = LONG
    const cues = buildCues(timed(text, [{ text, start: 4, end: 20 }]))
    expect(cues.length).toBeGreaterThan(2)
    expectWellFormed(cues)
    expectSpellsOut(text, cues)
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(7)
    }
    expect(cues[0].start).toBe(4)
    expect(cues[cues.length - 1].end).toBe(20)
  })

  test('word timings win over interpolation', () => {
    const text = 'quick then slow'
    const cues = buildCues(
      timed(text, [
        {
          text,
          start: 0,
          end: 10,
          words: [
            { text: 'quick', start: 0, end: 0.2 },
            { text: 'then', start: 0.2, end: 0.4 },
            { text: 'slow', start: 9, end: 10 },
          ],
        },
      ])
    )
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([
      ['quick then', 0, 0.4],
      ['slow', 9, 10],
    ])
  })

  test('Whisper tokens that continue a word stay in one word', () => {
    const text = 'The quarterly numbers.'
    const cues = buildCues(
      timed(text, [
        {
          text,
          start: 0,
          end: 3,
          words: [
            { text: 'The', start: 0, end: 0.3 },
            { text: 'quar', start: 0.3, end: 0.5 },
            { text: 'terly', start: 1.5, end: 1.8 }, // a pause inside a word
            { text: 'numbers', start: 1.8, end: 2.6 },
            { text: '.', start: 2.6, end: 3 },
          ],
        },
      ])
    )
    expect(cues.map((c) => c.text)).toEqual(['The quarterly numbers.'])
  })

  test('a script written without spaces wraps between characters and breaks at 。', () => {
    const sentence = '今日は良い天気ですね。'
    const text = sentence.repeat(3)
    const cues = buildCues(timed(text, [{ text, start: 0, end: 6 }]))
    expect(cues.map((c) => c.text)).toEqual([sentence, sentence, sentence])
    expect(cues.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ])
  })

  test('a long run of CJK without punctuation fills two lines of 42 at most', () => {
    const text = '天気'.repeat(100)
    const cues = buildCues(timed(text, [{ text, start: 0, end: 5 }]))
    expectWellFormed(cues)
    expectSpellsOut(text, cues)
    expect(cues[0].lines.map((line) => line.length)).toEqual([42, 42])
    expect(cues.map((c) => c.text).join('')).toBe(text)
  })

  test('a word longer than a line is cut into pieces that fit, with interpolated times', () => {
    const url = `https://example.com/${'a'.repeat(80)}`
    const text = `see ${url} now`
    const cues = buildCues(
      timed(text, [
        {
          text,
          start: 0,
          end: 10,
          words: [
            { text: 'see', start: 0, end: 1 },
            { text: url, start: 1, end: 7 },
            { text: 'now', start: 7, end: 8 },
          ],
        },
      ])
    )
    expectWellFormed(cues)
    expectSpellsOut(text, cues)
    const lines = cues.flatMap((c) => c.lines)
    expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''))
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42)
  })

  test('times are cleaned up: monotonic, no overlap, at least 0.1 s', () => {
    const text = 'One. Two. Three. Four.'
    const cues = buildCues(
      timed(text, [
        { text: 'One.', start: 1, end: 3 },
        { text: 'Two.', start: 2, end: 2.5 }, // starts inside One.
        { text: 'Three.', start: 2.5, end: 2.5 }, // no length at all
        { text: 'Four.', start: 2.55, end: 4 },
      ])
    )
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([
      ['One.', 1, 2],
      ['Two.', 2, 2.5],
      ['Three.', 2.5, 2.6],
      ['Four.', 2.6, 4],
    ])
    expectWellFormed(cues)
  })

  test('lines show whitespace as single spaces; the text keeps it', () => {
    const text = 'first line\nsecond  line'
    const [cue] = buildCues(timed(text, [{ text, start: 0, end: 2 }]))
    expect(cue.text).toBe(text)
    expect(cue.lines).toEqual(['first line second line'])
  })

  test('the cue texts always spell out the transcript exactly', () => {
    const samples = [
      LONG,
      'Hej med dig. Hvordan går det? Det går fint, tak.',
      '今日は良い天気ですね。明日も晴れるでしょう。iPhone を買った。',
      `${'x'.repeat(130)} y`,
    ]
    for (const text of samples) {
      const cues = buildCues(timed(text, [{ text, start: 0, end: 30 }]))
      expectSpellsOut(text, cues)
      expectWellFormed(cues)
    }
  })

  test('other rules can be passed in', () => {
    const cues = buildCues(evenlyTimed('aaa bbb ccc ddd', 0.1), {
      maxCharsPerLine: 7,
      maxLines: 1,
      maxSeconds: 60,
      pauseSeconds: 5,
    })
    expect(cues.map((c) => c.lines)).toEqual([['aaa bbb'], ['ccc ddd']])
  })

  test('a transcript whose parts do not line up gives no cues', () => {
    expect(
      buildCues({
        text: 'Hello there.',
        parts: [{ text: 'Goodbye.', start: 0, end: 1 }],
      })
    ).toEqual([])
  })
})
