import { describe, expect, test } from 'bun:test'
import {
  createEndOfSpeechDetector,
  createLevelMeter,
  levelDbOfInt16,
} from './end-of-speech'

const QUIET = -65
const SPEECH = -25

/** Push `ms` of one level; returns the frame index (from 1) at which it ended, or null. */
function feed(
  detector: ReturnType<typeof createEndOfSpeechDetector>,
  levelDb: number,
  ms: number,
  frameMs = 20
): number | null {
  for (let i = 1; i <= ms / frameMs; i++) {
    if (detector.push(levelDb)) return i
  }
  return null
}

describe('createEndOfSpeechDetector', () => {
  test('silence alone never ends it: speech has to be heard first', () => {
    const detector = createEndOfSpeechDetector()
    expect(feed(detector, QUIET, 10_000)).toBeNull()
    expect(detector.speechHeard).toBe(false)
  })

  test('ends 1.5 s after speech stops, not before', () => {
    const detector = createEndOfSpeechDetector()
    feed(detector, QUIET, 500)
    feed(detector, SPEECH, 1000)
    expect(detector.speechHeard).toBe(true)
    // 1480 ms of quiet is not enough; the frame that reaches 1500 ms ends it.
    expect(feed(detector, QUIET, 1480)).toBeNull()
    expect(detector.push(QUIET)).toBe(true)
    expect(detector.ended).toBe(true)
  })

  test('a short pause between words does not end it', () => {
    const detector = createEndOfSpeechDetector()
    feed(detector, QUIET, 300)
    feed(detector, SPEECH, 600)
    expect(feed(detector, QUIET, 1000)).toBeNull()
    feed(detector, SPEECH, 600)
    expect(feed(detector, QUIET, 1400)).toBeNull()
    expect(feed(detector, QUIET, 200)).not.toBeNull()
  })

  test('a click shorter than the minimum speech does not count as speech', () => {
    const detector = createEndOfSpeechDetector()
    feed(detector, QUIET, 300)
    feed(detector, SPEECH, 100)
    expect(feed(detector, QUIET, 5000)).toBeNull()
    expect(detector.speechHeard).toBe(false)
  })

  test('the start chime is ignored', () => {
    const detector = createEndOfSpeechDetector({ ignoreLeadingMs: 300 })
    // A loud chime for the first 300 ms, then the user has not said anything yet.
    feed(detector, SPEECH, 300)
    expect(feed(detector, QUIET, 5000)).toBeNull()
    expect(detector.speechHeard).toBe(false)
  })

  test('tracks a noisy room: speech is measured against the floor', () => {
    const detector = createEndOfSpeechDetector()
    // A fan at -40 dBFS is not speech, and the floor settles on it.
    feed(detector, -40, 1000)
    expect(detector.speechHeard).toBe(false)
    feed(detector, -20, 800)
    expect(detector.speechHeard).toBe(true)
    expect(feed(detector, -40, 1500)).not.toBeNull()
  })

  test('nothing below the absolute minimum is speech, however quiet the room', () => {
    const detector = createEndOfSpeechDetector()
    feed(detector, -110, 500)
    feed(detector, -60, 2000)
    expect(detector.speechHeard).toBe(false)
  })
})

describe('levelDbOfInt16', () => {
  test('full scale is about 0 dBFS and silence is -120', () => {
    expect(levelDbOfInt16(new Int16Array(160).fill(32767))).toBeCloseTo(0, 2)
    expect(levelDbOfInt16(new Int16Array(160))).toBe(-120)
    expect(levelDbOfInt16(new Int16Array(0))).toBe(-120)
  })

  test('half scale is about -6 dBFS', () => {
    expect(levelDbOfInt16(new Int16Array(160).fill(16384))).toBeCloseTo(
      -6.02,
      1
    )
  })
})

describe('createLevelMeter', () => {
  test('frames chunks of any size and keeps a partial frame for later', () => {
    const levels: number[] = []
    const meter = createLevelMeter(4, (db) => levels.push(db))
    meter(new Int16Array([32767, 32767, 32767]))
    expect(levels).toEqual([])
    meter(new Int16Array([32767, 0, 0, 0, 0, 1]))
    expect(levels.length).toBe(2)
    expect(levels[0]).toBeCloseTo(0, 2)
    expect(levels[1]).toBe(-120)
  })
})
