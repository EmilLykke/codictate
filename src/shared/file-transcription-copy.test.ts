import { describe, expect, test } from 'bun:test'
import {
  describeFileTranscriptionFailure,
  formatAudioClock,
  queueItemCallerLabel,
  queueItemStatusLine,
  resultSummaryLine,
  transcriptExportFailureMessage,
  transcriptExportSavedLine,
  wordsPerCaptionNote,
} from './file-transcription-copy'
import { modelLabel } from './dictation-plan'
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
    'cannot_translate',
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

describe('cannot_translate', () => {
  test('a neutral title, so the needs-a-language case reads right', () => {
    const copy = describeFileTranscriptionFailure(
      'cannot_translate',
      'Translate to English needs a Transcription Language. Choose one instead of Auto-detect.'
    )
    expect(copy.title).toBe("Can't translate this file")
    expect(copy.detail).toContain('needs a Transcription Language')
  })
})

describe('resultSummaryLine', () => {
  test('audio length and Processing Time', () => {
    expect(resultSummaryLine(250, 14)).toBe(
      '4:10 of audio · transcribed in 0:14'
    )
    expect(resultSummaryLine(3725, 612.4)).toBe(
      '1:02:05 of audio · transcribed in 10:12'
    )
  })

  test('rounded to the second, never 0:00', () => {
    expect(resultSummaryLine(5, 0.2)).toBe(
      '0:05 of audio · transcribed in 0:01'
    )
    expect(resultSummaryLine(5, 0)).toBe('0:05 of audio · transcribed in 0:01')
    expect(resultSummaryLine(60, 13.6)).toBe(
      '1:00 of audio · transcribed in 0:14'
    )
  })

  test('an entry saved before Processing Time was recorded', () => {
    expect(resultSummaryLine(250, null)).toBe('4:10 of audio')
  })
})

describe('Transcript Export lines', () => {
  test('saved, by file name only', () => {
    expect(transcriptExportSavedLine('/Users/me/Talks/memo 2.srt')).toBe(
      'Saved as memo 2.srt.'
    )
    expect(transcriptExportSavedLine('C:\\Users\\me\\memo.vtt')).toBe(
      'Saved as memo.vtt.'
    )
  })

  test('an unwritable folder asks for another one', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      expect(transcriptExportFailureMessage(code)).toBe(
        "Codictate can't save in that folder. Choose another folder."
      )
    }
    expect(transcriptExportFailureMessage('EIO')).toBe(
      "Couldn't save the file."
    )
    expect(transcriptExportFailureMessage(null)).toBe("Couldn't save the file.")
  })
})

describe('wordsPerCaptionNote', () => {
  test('names a Speech Model that estimates word times, once a number is picked', () => {
    const note = wordsPerCaptionNote(1, 'large-v3-turbo-q5_0', 'macos')
    expect(note).toBe(
      `${modelLabel('large-v3-turbo-q5_0')} only estimates when each word is spoken, so short captions can drift from the speech.`
    )
    expect(note).not.toMatch(/—/)
    expect(wordsPerCaptionNote(3, 'parakeet-tdt-0.6b-v3', 'windows')).toContain(
      modelLabel('parakeet-tdt-0.6b-v3')
    )
  })

  test('nothing for Automatic, for word-timed models, for a model that makes no captions, or an unknown one', () => {
    expect(wordsPerCaptionNote(null, 'large-v3-turbo-q5_0', 'macos')).toBeNull()
    expect(wordsPerCaptionNote(1, 'parakeet-tdt-0.6b-v3', 'macos')).toBeNull()
    expect(wordsPerCaptionNote(1, 'hviske-v5-tiny-q5_0', 'windows')).toBeNull()
    expect(wordsPerCaptionNote(1, 'ekko-v1-tiny-q5_0', 'macos')).toBeNull()
    expect(wordsPerCaptionNote(1, 'edda-v0.2-q5_0', 'macos')).toBeNull()
    expect(wordsPerCaptionNote(1, null, 'macos')).toBeNull()
  })
})
