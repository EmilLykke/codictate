import { describe, expect, test } from 'bun:test'
import {
  describeFileTranscriptionFailure,
  formatAudioClock,
  queueItemCallerLabel,
  queueItemStatusLine,
  transcribeSettingsSummary,
} from './file-transcription-copy'
import type { FileTranscriptionFailureCode } from './types'

describe('formatAudioClock', () => {
  test('minutes and hours', () => {
    expect(formatAudioClock(0)).toBe('0:00')
    expect(formatAudioClock(42.9)).toBe('0:42')
    expect(formatAudioClock(3121.5)).toBe('52:01')
    expect(formatAudioClock(4000)).toBe('1:06:40')
    expect(formatAudioClock(-3)).toBe('0:00')
  })
})

describe('queue lines', () => {
  test('who asked', () => {
    expect(
      queueItemCallerLabel({ origin: 'window', callerName: null })
    ).toBeNull()
    expect(
      queueItemCallerLabel({ origin: 'command-line', callerName: 'Terminal' })
    ).toBe('From Terminal')
    expect(
      queueItemCallerLabel({ origin: 'command-line', callerName: ' ' })
    ).toBe('From the command line')
  })

  test('waiting, reading, transcribing', () => {
    const base = { startedAt: null, audioSeconds: null }
    expect(
      queueItemStatusLine({ ...base, state: 'queued', position: 1 }, 0)
    ).toBe('Next up')
    expect(
      queueItemStatusLine({ ...base, state: 'queued', position: 3 }, 0)
    ).toBe('Waiting, 2 ahead')
    expect(
      queueItemStatusLine(
        {
          state: 'decoding',
          position: null,
          startedAt: 1_000,
          audioSeconds: null,
        },
        5_000
      )
    ).toBe('Reading the file · 0:04')
    expect(
      queueItemStatusLine(
        {
          state: 'transcribing',
          position: null,
          startedAt: 0,
          audioSeconds: 3121.5,
        },
        42_000
      )
    ).toBe('Transcribing · 0:42 · 52:01 of audio')
  })
})

describe('describeFileTranscriptionFailure', () => {
  const codes: FileTranscriptionFailureCode[] = [
    'input_unreadable',
    'no_audio',
    'model_not_installed',
    'unknown_model',
    'unknown_language',
    'language_not_allowed',
    'engine_failed',
    'cancelled',
    'internal',
  ]

  test('every code has a plain title and no em dash', () => {
    for (const code of codes) {
      const copy = describeFileTranscriptionFailure(code, 'detail')
      expect(copy.title.length).toBeGreaterThan(0)
      expect(`${copy.title} ${copy.detail ?? ''}`).not.toContain('—')
    }
  })

  test('a missing model points at the Models page', () => {
    expect(
      describeFileTranscriptionFailure('model_not_installed', 'x').action
    ).toBe('open-models')
  })

  test('the queue line is shown only where it helps', () => {
    expect(
      describeFileTranscriptionFailure('engine_failed', 'crispasr exited 3')
        .detail
    ).toBe('crispasr exited 3')
    expect(
      describeFileTranscriptionFailure('input_unreadable', 'No such file: /a')
        .detail
    ).not.toContain('/a')
  })
})

describe('transcribeSettingsSummary', () => {
  test('the selected model and language', () => {
    expect(transcribeSettingsSummary('large-v3-turbo-q5_0', 'da')).toEqual({
      model: 'Large V3 Turbo',
      language: 'Danish',
    })
  })

  test('Parakeet always detects, hviske is always Danish', () => {
    expect(
      transcribeSettingsSummary('parakeet-tdt-0.6b-v3', 'da').language
    ).toBe('Auto-detect')
    expect(
      transcribeSettingsSummary('hviske-v5-tiny-q8_0', 'auto').language
    ).toBe('Danish')
  })
})
