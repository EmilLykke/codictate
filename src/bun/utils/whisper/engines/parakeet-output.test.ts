import { describe, expect, it } from 'bun:test'
import { parseParakeetFinal, parseParakeetFinalText } from './parakeet-output'

/**
 * The helper's stream is not a clean protocol: the model runtime writes to the
 * same stdout, so the parse has to survive noise and still tell "no final line"
 * apart from "final line, nothing heard".
 */
describe('parseParakeetFinalText', () => {
  it('reads the text of the final line', () => {
    const stdout = [
      '{"kind":"partial","text":"hello"}',
      '{"kind":"final","text":"hello world"}',
      '',
    ].join('\n')

    expect(parseParakeetFinalText(stdout)).toBe('hello world')
  })

  it('skips non-final objects ahead of it', () => {
    const stdout = [
      '{"kind":"ready"}',
      '{"kind":"progress","fraction":0.5}',
      '{"kind":"partial","text":"hel"}',
      '{"kind":"final","text":"hello"}',
    ].join('\n')

    expect(parseParakeetFinalText(stdout)).toBe('hello')
  })

  it('skips non-JSON noise between valid lines', () => {
    const stdout = [
      'loading model from /Applications/Codictate.app',
      '{"kind":"partial","text":"hi"}',
      'ggml: using Metal',
      '{"kind":"final","text":"hi there"}',
    ].join('\n')

    expect(parseParakeetFinalText(stdout)).toBe('hi there')
  })

  it('returns null for an empty stream', () => {
    expect(parseParakeetFinalText('')).toBeNull()
    expect(parseParakeetFinalText('\n  \n')).toBeNull()
  })

  it('returns null when the stream carries no final line', () => {
    const stdout = ['{"kind":"partial","text":"hello"}', 'helper crashed'].join(
      '\n'
    )

    expect(parseParakeetFinalText(stdout)).toBeNull()
  })

  it('returns the empty string a silent Dictation produces, not null', () => {
    expect(parseParakeetFinalText('{"kind":"final","text":""}')).toBe('')
  })
})

describe('parseParakeetFinal', () => {
  it('reads an old-style final line with no timing', () => {
    expect(parseParakeetFinal('{"kind":"final","text":"hello world"}')).toEqual(
      { text: 'hello world', timing: null }
    )
  })

  it('reads spoken-word timing, keeping only text and times', () => {
    const stdout = [
      'ggml: using Metal',
      '{"timing":{"unit":"spoken-word","items":[{"text":"twenty","start":0.32,"end":0.61,"extra":1}]},"kind":"final","text":"20"}',
    ].join('\n')

    expect(parseParakeetFinal(stdout)).toEqual({
      text: '20',
      timing: {
        unit: 'spoken-word',
        items: [{ text: 'twenty', start: 0.32, end: 0.61 }],
      },
    })
  })

  it('reads sentence timing', () => {
    const stdout =
      '{"kind":"final","text":"Hello there.","timing":{"unit":"sentence","items":[{"text":"Hello there.","start":0.0,"end":1.2}]}}'

    expect(parseParakeetFinal(stdout)?.timing).toEqual({
      unit: 'sentence',
      items: [{ text: 'Hello there.', start: 0, end: 1.2 }],
    })
  })

  it('keeps the transcript and drops a timing it does not understand', () => {
    for (const timing of [
      '{"unit":"token","items":[]}',
      '{"unit":"sentence","items":[{"text":"a","start":"0","end":1}]}',
      '{"unit":"sentence"}',
      '[]',
      'null',
    ]) {
      expect(
        parseParakeetFinal(`{"kind":"final","text":"a","timing":${timing}}`)
      ).toEqual({ text: 'a', timing: null })
    }
  })

  it('returns null when the stream carries no final line', () => {
    expect(parseParakeetFinal('{"kind":"partial","text":"hello"}')).toBeNull()
    expect(parseParakeetFinal('')).toBeNull()
  })
})
