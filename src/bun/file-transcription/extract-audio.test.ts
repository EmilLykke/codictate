import { describe, expect, test } from 'bun:test'
import { extractAudioOutcome } from './extract-audio'

describe('extractAudioOutcome', () => {
  test('0 is a written WAV', () => {
    expect(extractAudioOutcome(0, '')).toEqual({ status: 'ok' })
  })

  test('3 is an unreadable file and 4 a file without audio, in the helper’s words', () => {
    expect(
      extractAudioOutcome(
        3,
        'not a readable audio or video file: Cannot Open\n'
      )
    ).toEqual({
      status: 'failed',
      code: 'input_unreadable',
      message: 'not a readable audio or video file: Cannot Open',
    })
    expect(extractAudioOutcome(4, 'the file has no audio track\n')).toEqual({
      status: 'failed',
      code: 'no_audio',
      message: 'the file has no audio track',
    })
  })

  test('a silent helper still gets a sentence', () => {
    expect(extractAudioOutcome(3, '')).toMatchObject({
      code: 'input_unreadable',
      message: 'not a readable audio or video file',
    })
    expect(extractAudioOutcome(4, '')).toMatchObject({
      code: 'no_audio',
      message: 'the file has no audio track',
    })
  })

  test('anything else is this installation’s fault, naming the helper', () => {
    for (const code of [1, 2, 5, 134]) {
      const outcome = extractAudioOutcome(
        code,
        'cannot write /tmp/x.wav',
        'CodictateWindowsHelper'
      )
      expect(outcome).toMatchObject({ status: 'failed', code: 'internal' })
      if (outcome.status === 'failed') {
        expect(outcome.message).toContain('CodictateWindowsHelper')
        expect(outcome.message).toContain(`exit ${code}`)
      }
    }
  })
})
