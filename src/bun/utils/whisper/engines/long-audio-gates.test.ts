import { describe, expect, test } from 'bun:test'
import {
  captionTiming,
  captionTimingFailure,
  firstWordStartOffsets,
  peakRssVerdict,
  type PeakRssVerdict,
} from './long-audio-gates'

describe('firstWordStartOffsets', () => {
  test('gives each utterance its first word start minus its speech start', () => {
    const offsets = firstWordStartOffsets(
      [
        { text: 'Hej med dig.', speechStart: 1.0 },
        { text: 'Vi ses i morgen.', speechStart: 4.5 },
      ],
      [
        { text: 'hej', start: 0.25 },
        { text: 'med', start: 1.4 },
        { text: 'dig', start: 1.7 },
        { text: 'vi', start: 4.75 },
        { text: 'ses', start: 5.0 },
        { text: 'i', start: 5.3 },
        { text: 'morgen', start: 5.5 },
      ]
    )
    expect(offsets).toEqual([-0.75, 0.25])
  })

  test('skips an utterance whose first word was misheard, not timing a later word', () => {
    const offsets = firstWordStartOffsets(
      [
        { text: 'Hej med dig.', speechStart: 1.0 },
        { text: 'Vi ses i morgen.', speechStart: 4.5 },
      ],
      [
        { text: 'hej', start: 1.25 },
        { text: 'med', start: 1.4 },
        { text: 'dig', start: 1.7 },
        { text: 'fi', start: 4.75 },
        { text: 'ses', start: 5.0 },
        { text: 'i', start: 5.3 },
        { text: 'morgen', start: 5.5 },
      ]
    )
    expect(offsets).toEqual([0.25])
  })
})

describe('captionTiming', () => {
  test('summarises offsets as p10, median and the earliest, in seconds', () => {
    expect(
      captionTiming([0.3, -1.5, 0.2, 0, 0.4, -3, 0.1, -0.2, 0.3, 0.2])
    ).toEqual({ count: 10, p10: -1.5, median: 0.2, worst: -3 })
  })

  test('has nothing to summarise without offsets', () => {
    expect(captionTiming([])).toBeNull()
  })
})

describe('captionTimingFailure', () => {
  test('fails a clip whose p10 is earlier than -1.0 s (#78 measured -3.6 s unclamped)', () => {
    expect(
      captionTimingFailure({ count: 23, p10: -3.6, median: 0.2, worst: -6 })
    ).toBe('p10 first-word start -3.60 s, earlier than -1.0 s')
  })

  test('passes a p10 of exactly -1.0 s and the clamped -0.7 s', () => {
    expect(
      captionTimingFailure({ count: 23, p10: -1, median: 0.2, worst: -2 })
    ).toBeNull()
    expect(
      captionTimingFailure({ count: 23, p10: -0.7, median: 0.2, worst: -1.1 })
    ).toBeNull()
  })

  test('fails a clip with no first word to time, rather than passing it', () => {
    expect(captionTimingFailure(null)).toBe(
      'no utterance had its first word matched, so caption timing was not measured'
    )
  })
})

describe('peakRssVerdict', () => {
  test('passes the 300 MB #78 measured per parakeet-cli process', () => {
    expect(peakRssVerdict(300 * 1024 * 1024)).toEqual({
      status: 'pass',
      megabytes: 300,
    })
  })

  test('fails at 1 GB or more', () => {
    expect(peakRssVerdict(1024 * 1024 * 1024)).toEqual({
      status: 'fail',
      megabytes: 1024,
    })
  })

  test('skips, never passes, when the peak is missing or zero', () => {
    const skip: PeakRssVerdict = {
      status: 'skip',
      reason: 'no peak RSS from the process resource usage',
    }
    expect(peakRssVerdict(undefined)).toEqual(skip)
    expect(peakRssVerdict(0)).toEqual(skip)
    expect(peakRssVerdict(Number.NaN)).toEqual(skip)
  })
})
