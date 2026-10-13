import { describe, expect, it } from 'bun:test'
import type { ParakeetTimedItem } from './parakeet-output'
import { parakeetTimedTranscript } from './parakeet-timings'

/** Spoken words 0.5 s apart, each 0.4 s long: word n runs n*0.5 .. n*0.5+0.4. */
function spokenWords(text: string): ParakeetTimedItem[] {
  return text.split(' ').map((word, n) => ({
    text: word,
    start: n * 0.5,
    end: n * 0.5 + 0.4,
  }))
}

function spokenTiming(text: string) {
  return { unit: 'spoken-word' as const, items: spokenWords(text) }
}

function wordTimes(raw: string, spoken: string) {
  const timed = parakeetTimedTranscript(raw, spokenTiming(spoken))
  return timed?.parts.flatMap((part) => part.words ?? []) ?? null
}

describe('parakeetTimedTranscript: spoken words before ITN', () => {
  it('times words that ITN left alone one to one', () => {
    expect(wordTimes('He hoped there', 'He hoped there')).toEqual([
      { text: 'He', start: 0, end: 0.4 },
      { text: 'hoped', start: 0.5, end: 0.9 },
      { text: 'there', start: 1, end: 1.4 },
    ])
  })

  it('gives a number ITN wrote the span of the words it was spoken as', () => {
    expect(wordTimes('21 apples', 'twenty one apples')).toEqual([
      { text: '21', start: 0, end: 0.9 },
      { text: 'apples', start: 1, end: 1.4 },
    ])
  })

  it('gives money ITN wrote the span of every word it came from', () => {
    expect(wordTimes('$5.50', 'five dollars and fifty cents')).toEqual([
      { text: '$5.50', start: 0, end: 2.4 },
    ])
  })

  it('ends the word before a spoken "period" where the period was said', () => {
    expect(wordTimes('the end.', 'the end period')).toEqual([
      { text: 'the', start: 0, end: 0.4 },
      { text: 'end.', start: 0.5, end: 1.4 },
    ])
  })

  it('ignores case and punctuation when matching', () => {
    expect(wordTimes('Hello, World!', 'hello world')).toEqual([
      { text: 'Hello,', start: 0, end: 0.4 },
      { text: 'World!', start: 0.5, end: 0.9 },
    ])
  })

  it('splits a block of several written words over its span by length', () => {
    // Nothing in "5:30 p.m." matches "five thirty p m" word for word.
    expect(wordTimes('at 5:30 p.m. today', 'at five thirty p m today')).toEqual(
      [
        { text: 'at', start: 0, end: 0.4 },
        { text: '5:30', start: 0.5, end: 1.45 },
        { text: 'p.m.', start: 1.45, end: 2.4 },
        { text: 'today', start: 2.5, end: 2.9 },
      ]
    )
  })

  it('resyncs on the nearest word the two agree on again', () => {
    expect(wordTimes('at 5:30 p.m. today', 'at five thirty pm today')).toEqual([
      { text: 'at', start: 0, end: 0.4 },
      { text: '5:30', start: 0.5, end: 1.4 },
      { text: 'p.m.', start: 1.5, end: 1.9 },
      { text: 'today', start: 2, end: 2.4 },
    ])
  })

  it('times a written word nothing was spoken for from the word before', () => {
    expect(
      wordTimes('one – two three four five', 'one two three four five')
    ).toEqual([
      { text: 'one', start: 0, end: 0.4 },
      { text: '–', start: 0.4, end: 0.4 },
      { text: 'two', start: 0.5, end: 0.9 },
      { text: 'three', start: 1, end: 1.4 },
      { text: 'four', start: 1.5, end: 1.9 },
      { text: 'five', start: 2, end: 2.4 },
    ])
  })

  it('keeps the text exactly the Raw Transcript and makes one part per sentence', () => {
    const raw = 'I have 21 apples. They cost $5.50!  Fine'
    const timed = parakeetTimedTranscript(
      raw,
      spokenTiming(
        'I have twenty one apples. They cost five dollars and fifty cents! Fine'
      )
    )

    expect(timed?.text).toBe(raw)
    expect(timed?.parts.map((part) => part.text)).toEqual([
      'I have 21 apples.',
      'They cost $5.50!',
      'Fine',
    ])
    expect(timed?.parts.map((part) => [part.start, part.end])).toEqual([
      [0, 2.4],
      [2.5, 5.9],
      [6, 6.4],
    ])
  })

  it('gives up when more than a fifth of the words do not match', () => {
    expect(wordTimes('a dog lay on a rug', 'the cat sat on the mat')).toBeNull()
  })

  it('tolerates a stray word within the fifth', () => {
    expect(
      wordTimes('one two three four five six', 'one two three um four five six')
    ).not.toBeNull()
  })

  it('gives up when the two never agree again within reach', () => {
    const many = Array.from({ length: 30 }, (_, n) => `w${n}`).join(' ')
    const other = Array.from({ length: 30 }, (_, n) => `x${n}`).join(' ')
    expect(wordTimes(`start ${many}`, `start ${other}`)).toBeNull()
  })

  it('has nothing for an empty transcript or no spoken words', () => {
    expect(parakeetTimedTranscript('', spokenTiming('hello'))).toBeNull()
    expect(
      parakeetTimedTranscript('hello', { unit: 'spoken-word', items: [] })
    ).toBeNull()
    expect(parakeetTimedTranscript('hello', null)).toBeNull()
  })
})

describe('parakeetTimedTranscript: sentences', () => {
  it('passes sentences of the Raw Transcript through as parts', () => {
    const timed = parakeetTimedTranscript('Hello there. How are you?', {
      unit: 'sentence',
      items: [
        { text: 'Hello there.', start: 0, end: 1.2 },
        { text: 'How are you?', start: 1.4, end: 2 },
      ],
    })

    expect(timed).toEqual({
      text: 'Hello there. How are you?',
      parts: [
        { text: 'Hello there.', start: 0, end: 1.2 },
        { text: 'How are you?', start: 1.4, end: 2 },
      ],
    })
  })

  it('has nothing when the sentences do not spell the transcript', () => {
    expect(
      parakeetTimedTranscript('Hello there.', {
        unit: 'sentence',
        items: [{ text: 'Hello here.', start: 0, end: 1 }],
      })
    ).toBeNull()
  })
})
