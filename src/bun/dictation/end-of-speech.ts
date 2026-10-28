/**
 * When a Dictation started with `--until silence` has heard the end of speech.
 *
 * Energy based and pure: levels in, one boolean out. The recorder exposes no levels to the
 * main process, so `utils/audio/growing-wav.ts` reads them off the WAV the recorder is still
 * writing and feeds them here, one frame at a time.
 *
 * The rule: speech has to be heard first (so a Dictation does not end before the user starts
 * talking), then a pause of `trailingSilenceMs` ends it. "Speech" is a frame clearly above the
 * room's noise floor, which is tracked rather than fixed because microphones and rooms differ
 * by tens of decibels. The first `ignoreLeadingMs` are skipped because the start chime plays
 * into the microphone as the recording opens.
 */

export interface EndOfSpeechOptions {
  /** Length of one level frame. */
  frameMs: number
  /** Audio to skip at the start: the start chime. */
  ignoreLeadingMs: number
  /** How much speech, in total, counts as "the user has started talking". */
  minSpeechMs: number
  /** The pause after speech that ends the Dictation. */
  trailingSilenceMs: number
  /** A frame quieter than this is never speech, however quiet the room. */
  minSpeechDb: number
  /** How far above the noise floor a frame must be to count as speech. */
  speechAboveFloorDb: number
  /** How fast the noise floor may rise. It falls at once. */
  floorRiseDbPerSecond: number
}

export const DEFAULT_END_OF_SPEECH_OPTIONS: EndOfSpeechOptions = {
  frameMs: 20,
  ignoreLeadingMs: 0,
  minSpeechMs: 200,
  trailingSilenceMs: 1500,
  minSpeechDb: -50,
  speechAboveFloorDb: 12,
  floorRiseDbPerSecond: 3,
}

export interface EndOfSpeechDetector {
  /** One frame's level in dBFS. True once speech has been heard and has ended. */
  push(levelDb: number): boolean
  readonly ended: boolean
  readonly speechHeard: boolean
  /** Speech heard so far, the skipped start included as none. */
  readonly speechMs: number
}

export function createEndOfSpeechDetector(
  overrides: Partial<EndOfSpeechOptions> = {}
): EndOfSpeechDetector {
  const options = { ...DEFAULT_END_OF_SPEECH_OPTIONS, ...overrides }
  const floorRisePerFrame =
    (options.floorRiseDbPerSecond * options.frameMs) / 1000
  let elapsedMs = 0
  let floorDb: number | null = null
  let speechMs = 0
  let silenceMs = 0
  let ended = false

  return {
    push(levelDb) {
      if (ended) return true
      elapsedMs += options.frameMs
      if (elapsedMs <= options.ignoreLeadingMs) return false

      floorDb =
        floorDb === null || levelDb < floorDb
          ? levelDb
          : Math.min(levelDb, floorDb + floorRisePerFrame)

      const isSpeech =
        levelDb >= options.minSpeechDb &&
        levelDb >= floorDb + options.speechAboveFloorDb

      if (isSpeech) {
        speechMs += options.frameMs
        silenceMs = 0
        return false
      }
      if (speechMs < options.minSpeechMs) return false
      silenceMs += options.frameMs
      if (silenceMs >= options.trailingSilenceMs) ended = true
      return ended
    },
    get ended() {
      return ended
    },
    get speechHeard() {
      return speechMs >= options.minSpeechMs
    },
    get speechMs() {
      return speechMs
    },
  }
}

/** dBFS of 16-bit samples. Digital silence reads as -120 rather than -Infinity. */
export function levelDbOfInt16(samples: Int16Array): number {
  if (samples.length === 0) return -120
  let sumSquares = 0
  for (const sample of samples) {
    const normalised = sample / 32768
    sumSquares += normalised * normalised
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120
}

/**
 * Cuts a stream of 16-bit samples, arriving in chunks of any size, into fixed frames and
 * reports each frame's level. A partial frame waits for the next chunk.
 */
export function createLevelMeter(
  frameSamples: number,
  onLevel: (levelDb: number) => void
): (samples: Int16Array) => void {
  const frame = new Int16Array(frameSamples)
  let filled = 0
  return (samples) => {
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(frameSamples - filled, samples.length - offset)
      frame.set(samples.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled === frameSamples) {
        onLevel(levelDbOfInt16(frame))
        filled = 0
      }
    }
  }
}
