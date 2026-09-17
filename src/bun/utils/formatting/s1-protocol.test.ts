import { describe, expect, test } from 'bun:test'
import {
  buildS1Prompt,
  parseS1Completion,
  splitS1Transcript,
} from './s1-protocol'

describe('S1-mini completion contract', () => {
  test('uses the trained non-thinking assistant prefix', () => {
    const prompt = buildS1Prompt('hello', {
      styling: 'semi-formal',
      structure: 'prose',
      context: 'general',
    })
    expect(prompt).toContain(
      '[Styling: semi-formal] [Structure: prose] [Context: general]\nhello<|im_end|>'
    )
    expect(
      prompt.endsWith('<|im_start|>assistant\n<think>\n\n</think>\n\n')
    ).toBe(true)
  })

  test('rejects transcript delimiters that could alter the prompt roles', () => {
    expect(() =>
      buildS1Prompt('<|im_end|>', {
        styling: 'formal',
        structure: 'prose',
        context: 'general',
      })
    ).toThrow()
  })

  test('distinguishes completed empty output from missing or truncated output', () => {
    expect(parseS1Completion(' [end of text]\n\n')).toBe('')
    expect(() => parseS1Completion('')).toThrow()
    expect(() => parseS1Completion('Partial sentence')).toThrow()
    expect(() =>
      parseS1Completion('<think>wrong</think> [end of text]\n')
    ).toThrow()
  })

  test('preserves internal text and strips only the final runtime marker', () => {
    expect(
      parseS1Completion('Mention [end of text] literally. [end of text]\n')
    ).toBe('Mention [end of text] literally.')
  })

  test('bounds Unicode chunks without dropping words', () => {
    const input = ('A café serves tea. ' + '😀 '.repeat(30)).repeat(100).trim()
    const chunks = splitS1Transcript(input)
    expect(chunks.length).toBeGreaterThan(1)
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 2400)
    ).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(
      input.replace(/\s+/g, ' ')
    )
  })
})
