import { describe, expect, test } from 'bun:test'
import { timedTranscriptFromPieces } from './timed-transcript'
import {
  isTranscriptExportFormat,
  renderTranscript,
  TRANSCRIPT_EXPORT_FORMATS,
  transcriptExportFileName,
  transcriptExportOptions,
  type TranscriptExportOption,
  type TranscriptExportSource,
} from './transcript-export'

const TEXT = 'Hello there. How are you?'

const TIMED = timedTranscriptFromPieces(TEXT, [
  { text: ' Hello there.', start: 0.5, end: 1.25 },
  { text: ' How are you?', start: 3, end: 4.1234 },
])

function source(
  overrides: Partial<TranscriptExportSource> = {}
): TranscriptExportSource {
  return {
    fileName: 'memo.m4a',
    speechModelId: 'large-v3-turbo-q5_0',
    language: 'en',
    translated: false,
    audioSeconds: 5.2,
    processingSeconds: 1.4,
    text: TEXT,
    timedTranscript: TIMED,
    ...overrides,
  }
}

function content(
  format: Parameters<typeof renderTranscript>[0],
  s: TranscriptExportSource
): string {
  const rendered = renderTranscript(format, s)
  if (!rendered.ok) throw new Error(rendered.message)
  return rendered.content
}

const NO_EM_DASH = /—/

describe('formats', () => {
  test('txt, srt, vtt and json, in that order', () => {
    expect(TRANSCRIPT_EXPORT_FORMATS).toEqual(['txt', 'srt', 'vtt', 'json'])
    expect(isTranscriptExportFormat('srt')).toBe(true)
    expect(isTranscriptExportFormat('SRT')).toBe(false)
    expect(isTranscriptExportFormat('docx')).toBe(false)
    expect(isTranscriptExportFormat(null)).toBe(false)
  })
})

describe('renderTranscript', () => {
  test('text is the Raw Transcript and a newline', () => {
    expect(content('txt', source())).toBe(`${TEXT}\n`)
    expect(content('txt', source({ timedTranscript: null }))).toBe(`${TEXT}\n`)
  })

  test('SRT', () => {
    expect(content('srt', source())).toBe(
      '1\n' +
        '00:00:00,500 --> 00:00:01,250\n' +
        'Hello there.\n' +
        '\n' +
        '2\n' +
        '00:00:03,000 --> 00:00:04,123\n' +
        'How are you?\n' +
        '\n'
    )
  })

  test('VTT', () => {
    expect(content('vtt', source())).toBe(
      'WEBVTT\n' +
        '\n' +
        '00:00:00.500 --> 00:00:01.250\n' +
        'Hello there.\n' +
        '\n' +
        '00:00:03.000 --> 00:00:04.123\n' +
        'How are you?\n' +
        '\n'
    )
  })

  test('caption times past an hour, and wrapped lines', () => {
    const text =
      'one two three four five six seven eight nine ten eleven twelve'
    const timed = timedTranscriptFromPieces(text, [
      { text, start: 3725.0004, end: 3727.9996 },
    ])
    expect(content('srt', source({ text, timedTranscript: timed }))).toBe(
      '1\n' +
        '01:02:05,000 --> 01:02:08,000\n' +
        'one two three four five six seven\n' +
        'eight nine ten eleven twelve\n' +
        '\n'
    )
  })

  test('VTT escapes &, < and >, which keeps --> out of the text', () => {
    const text = 'Tom & Jerry <3 a --> b'
    const timed = timedTranscriptFromPieces(text, [{ text, start: 0, end: 2 }])
    const vtt = content('vtt', source({ text, timedTranscript: timed }))
    expect(vtt).toContain('Tom &amp; Jerry &lt;3 a --&gt; b\n')
    expect(vtt.split('\n').filter((line) => line.includes('-->'))).toEqual([
      '00:00:00.000 --> 00:00:02.000',
    ])
    const srt = content('srt', source({ text, timedTranscript: timed }))
    expect(srt.split('\n').filter((line) => line.includes('-->'))).toEqual([
      '00:00:00,000 --> 00:00:02,000',
    ])
  })

  test('JSON carries the facts, the text and the cues as segments', () => {
    const json = content('json', source())
    expect(json.endsWith('}\n')).toBe(true)
    expect(json).toBe(
      `${JSON.stringify(
        {
          fileName: 'memo.m4a',
          speechModelId: 'large-v3-turbo-q5_0',
          language: 'en',
          translated: false,
          audioSeconds: 5.2,
          processingSeconds: 1.4,
          text: TEXT,
          segments: [
            { start: 0.5, end: 1.25, text: 'Hello there.' },
            { start: 3, end: 4.123, text: 'How are you?' },
          ],
        },
        null,
        2
      )}\n`
    )
  })

  test('JSON segments keep the exact text, line breaks and all', () => {
    const text = 'first\nsecond'
    const timed = timedTranscriptFromPieces(text, [{ text, start: 0, end: 1 }])
    const doc = JSON.parse(
      content('json', source({ text, timedTranscript: timed }))
    )
    expect(doc.segments).toEqual([{ start: 0, end: 1, text: 'first\nsecond' }])
  })

  test('JSON without a Timed Transcript has no segments, and nulls for what is unknown', () => {
    const doc = JSON.parse(
      content(
        'json',
        source({
          timedTranscript: null,
          speechModelId: null,
          language: null,
          processingSeconds: null,
        })
      )
    )
    expect(doc).toEqual({
      fileName: 'memo.m4a',
      speechModelId: null,
      language: null,
      translated: false,
      audioSeconds: 5.2,
      processingSeconds: null,
      text: TEXT,
    })
    expect(doc).not.toHaveProperty('segments')
  })

  test('captions without a Timed Transcript are refused with a sentence', () => {
    for (const format of ['srt', 'vtt'] as const) {
      expect(
        renderTranscript(format, source({ timedTranscript: null }))
      ).toEqual({
        ok: false,
        reason: 'no_timed_transcript',
        message:
          "This transcript has no timings, so it can't be made into captions.",
      })
      expect(
        renderTranscript(
          format,
          source({ timedTranscript: null, speechModelId: 'edda-v0.2-q8_0' })
        )
      ).toEqual({
        ok: false,
        reason: 'no_timed_transcript',
        message: "Edda V0.2 Q8 can't make captions yet.",
      })
    }
  })

  test('a Timed Transcript that does not say the text is not used', () => {
    const other = timedTranscriptFromPieces('Something else.', [
      { text: 'Something else.', start: 0, end: 1 },
    ])
    expect(renderTranscript('srt', source({ timedTranscript: other })).ok).toBe(
      false
    )
    expect(
      JSON.parse(content('json', source({ timedTranscript: other })))
    ).not.toHaveProperty('segments')
    const broken = { text: TEXT, parts: [{ text: 'Nope', start: 0, end: 1 }] }
    expect(
      renderTranscript('vtt', source({ timedTranscript: broken })).ok
    ).toBe(false)
  })
})

describe('transcriptExportOptions', () => {
  const byFormat = (options: TranscriptExportOption[]) =>
    Object.fromEntries(options.map((o) => [o.format, o]))

  test('everything is available with a Timed Transcript', () => {
    expect(
      transcriptExportOptions({
        speechModelId: 'large-v3-turbo-q5_0',
        hasTimedTranscript: true,
      })
    ).toEqual([
      {
        format: 'txt',
        label: 'Text (.txt)',
        available: true,
        unavailableReason: null,
      },
      {
        format: 'srt',
        label: 'Captions (.srt)',
        available: true,
        unavailableReason: null,
      },
      {
        format: 'vtt',
        label: 'Captions (.vtt)',
        available: true,
        unavailableReason: null,
      },
      {
        format: 'json',
        label: 'JSON (.json)',
        available: true,
        unavailableReason: null,
      },
    ])
  })

  test('a Speech Model that cannot make timings is named', () => {
    const options = byFormat(
      transcriptExportOptions({
        speechModelId: 'edda-v0.2-q8_0',
        hasTimedTranscript: false,
      })
    )
    for (const format of ['srt', 'vtt']) {
      expect(options[format]).toMatchObject({
        available: false,
        unavailableReason: "Edda V0.2 Q8 can't make captions yet.",
      })
    }
    expect(options.txt.available).toBe(true)
    expect(options.json.available).toBe(true)
  })

  test('otherwise the transcript was saved without timings', () => {
    const reason =
      "This transcript was saved without timings, so it can't be made into captions."
    for (const speechModelId of [
      null,
      'large-v3-turbo-q5_0',
      'parakeet-tdt-0.6b-v3',
      'no-such-model',
    ]) {
      const options = byFormat(
        transcriptExportOptions({ speechModelId, hasTimedTranscript: false })
      )
      expect(options.srt.unavailableReason).toBe(reason)
      expect(options.vtt.unavailableReason).toBe(reason)
      expect(options.json).toMatchObject({
        available: true,
        unavailableReason: null,
      })
    }
  })

  test('no copy has an em dash', () => {
    for (const hasTimedTranscript of [true, false]) {
      for (const speechModelId of [null, 'edda-v0.2-q5_0']) {
        for (const option of transcriptExportOptions({
          speechModelId,
          hasTimedTranscript,
        })) {
          expect(option.label).not.toMatch(NO_EM_DASH)
          expect(option.unavailableReason ?? '').not.toMatch(NO_EM_DASH)
        }
        const refused = renderTranscript(
          'srt',
          source({ speechModelId, timedTranscript: null })
        )
        expect(refused.ok ? '' : refused.message).not.toMatch(NO_EM_DASH)
      }
    }
  })
})

describe('transcriptExportFileName', () => {
  test('the source name with the format', () => {
    expect(transcriptExportFileName('memo.m4a', 'srt')).toBe('memo.srt')
    expect(transcriptExportFileName('memo.m4a', 'json')).toBe('memo.json')
    expect(transcriptExportFileName('board call.m4a', 'txt')).toBe(
      'board call.txt'
    )
  })

  test('only the last extension goes; a leading dot is part of the name', () => {
    expect(transcriptExportFileName('a.b.mov', 'vtt')).toBe('a.b.vtt')
    expect(transcriptExportFileName('recording', 'txt')).toBe('recording.txt')
    expect(transcriptExportFileName('.hidden', 'srt')).toBe('.hidden.srt')
  })
})
