import { describe, expect, test } from 'bun:test'
import { LineTooLongError, NdjsonLineSplitter } from './line-splitter'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('NdjsonLineSplitter', () => {
  test('holds a partial line until its newline arrives', () => {
    const splitter = new NdjsonLineSplitter()
    expect(splitter.push(bytes('{"a":'))).toEqual([])
    expect(splitter.push(bytes('1}\n{"b"'))).toEqual(['{"a":1}'])
    expect(splitter.push(bytes(':2}\n'))).toEqual(['{"b":2}'])
  })

  test('several lines in one chunk, CRLF and blank lines', () => {
    const splitter = new NdjsonLineSplitter()
    expect(splitter.push('{"a":1}\r\n\n  \n{"b":2}\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  test('a multi-byte character split across chunks', () => {
    const splitter = new NdjsonLineSplitter()
    const all = bytes('{"t":"æø…"}\n')
    const lines: string[] = []
    for (let i = 0; i < all.length; i++) {
      lines.push(...splitter.push(all.subarray(i, i + 1)))
    }
    expect(lines).toEqual(['{"t":"æø…"}'])
  })

  test('refuses an endless line', () => {
    const splitter = new NdjsonLineSplitter(8)
    expect(() => splitter.push('123456789')).toThrow(LineTooLongError)
  })
})
