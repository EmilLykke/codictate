import { describe, expect, it } from 'bun:test'
import { parseParakeetFinalText } from './parakeet-output'

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
