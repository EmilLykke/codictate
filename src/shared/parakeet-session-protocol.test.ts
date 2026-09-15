import { describe, expect, test } from 'bun:test'
import {
  encodeParakeetSessionRequest,
  parseParakeetSessionResponse,
} from './parakeet-session-protocol'

describe('Parakeet session protocol', () => {
  test('encodes the request shape both Native Helpers read', () => {
    expect(
      encodeParakeetSessionRequest({ id: 7, audioPath: '/clips/æble.wav' })
    ).toBe('{"id":7,"audioPath":"/clips/æble.wav"}')
  })

  test('rejects request ids outside the native unsigned integer contract', () => {
    expect(() =>
      encodeParakeetSessionRequest({ id: -1, audioPath: '/tmp/sample.wav' })
    ).toThrow(RangeError)
    expect(() =>
      encodeParakeetSessionRequest({ id: 1.5, audioPath: '/tmp/sample.wav' })
    ).toThrow(RangeError)
  })

  test('parses ready and correlated final responses', () => {
    expect(parseParakeetSessionResponse('{"kind":"ready"}')).toEqual({
      kind: 'ready',
    })
    expect(
      parseParakeetSessionResponse('{"kind":"final","id":7,"text":"hello"}')
    ).toEqual({ kind: 'final', id: 7, text: 'hello' })
  })

  test('rejects malformed and uncorrelatable output', () => {
    expect(parseParakeetSessionResponse('not json')).toBeNull()
    expect(
      parseParakeetSessionResponse('{"kind":"final","text":"hello"}')
    ).toBeNull()
    expect(
      parseParakeetSessionResponse('{"kind":"final","id":1.5,"text":"hello"}')
    ).toBeNull()
    expect(
      parseParakeetSessionResponse('{"kind":"final","id":-1,"text":"hello"}')
    ).toBeNull()
    expect(parseParakeetSessionResponse('{"kind":"other"}')).toBeNull()
  })
})
