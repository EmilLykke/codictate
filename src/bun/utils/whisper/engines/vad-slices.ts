/**
 * Where Codictate cuts the audio on the `nt-vad` decode path, handed to crispasr with
 * `--vad-import` (issue #83). Pure: samples in, slices out.
 *
 * With `-nt`, whisper.cpp decodes in 30 s windows and, after an early end-of-text, skips the
 * rest of the window, so the speech after it is lost (ADR-0010). A slice of 30 s or less that
 * starts and ends in a pause leaves no window to skip. crispasr decodes imported `"chunks"`
 * exactly as written, with no merge and no re-pack, so these slices are what each decode sees.
 *
 * The plan is WhisperX's cut-and-merge with faster-whisper's split rule:
 * 1. Loudness in 10 ms frames finds the pauses: a frame is silent when it is within a few dB
 *    of the recording's own noise floor (with `pauseBelowSpeechDb`, ekko's only, also when it
 *    is that far under the recording's speech level).
 * 2. Speech is the given `speechRegions` (a Silero pass), or else the runs of loud frames with
 *    pauses shorter than `minPauseMs` bridged.
 * 3. Neighbouring speech is merged into slices. A pause up to `maxMergeGapMs` can stay in a
 *    slice; a longer one always ends it, because on `-nt` a long silence invites an early
 *    end-of-text and loses the speech after it. faster-whisper drops silence for the same
 *    reason, and Edda was trained with 0.5-2 s of it at most. Speech that fits under the cap
 *    is one slice.
 * 4. Speech that does not fit is cut in the back half of the cap, at the longest pause there
 *    (a gap between speech runs or a pause inside one; the later of two equal ones), else at
 *    the centre of the quietest 100 ms (crispasr's own `crispasr_rechunk_slices` rule). The
 *    longest pause, not the last one that fits: a short pause is more often a breath inside a
 *    sentence, and a cut there cost large-v2 a clause (issue #83).
 * 5. Slices with too little speech are dropped, and each slice keeps `padMs` of real audio on
 *    both sides, never overlapping a neighbour and never past the cap. The rest of a long
 *    pause is in no slice at all.
 */

/** Sample offsets at the audio's own rate. `endSample` is exclusive. */
export interface AudioSlice {
  startSample: number
  endSample: number
}

/** Where a VAD pass heard speech, in samples. `endSample` is exclusive. */
export interface SpeechRegion {
  startSample: number
  endSample: number
}

export interface VadSliceOptions {
  /** No slice is longer than this, padding included. */
  maxSliceSeconds: number
  /** The shortest silence that counts as a pause. */
  minPauseMs: number
  /** Real audio kept on each side of a slice, where there is room for it. */
  padMs: number
  /** A slice with less speech than this is dropped (a click, a cough). */
  minSpeechMs: number
  /** A pause longer than this always ends a slice; up to this it can stay inside one. */
  maxMergeGapMs: number
  /**
   * Off (`null`) by default, and only the ekko adapter sets it (#108). When set, a frame this
   * many dB or more under the recording's speech level (the 90th percentile of its frame
   * levels) is silent too, however far it is above the noise floor. One noise floor for the
   * whole recording sits at its quietest room, so a stretch of louder room noise between two
   * sentences reads as speech and never ends a slice; ekko-v1-tiny then drops the first words
   * after it. A noise floor taken locally does not fix that: a quieter room nearby pulls it
   * down just as far.
   */
  pauseBelowSpeechDb: number | null
}

/**
 * 30 s is one Whisper window, and Edda's card (`chunk_length_s=30`): at 20 s Edda stopped early
 * in a 12 s slice of a real dictation and lost a sentence (ADR-0010). 98 ms is whisper.cpp's
 * own shortest pause for splitting long VAD regions, and 250 ms is Silero's
 * `min_speech_duration_ms`. 1.5 s sits inside the 0.5-2 s of trailing silence Edda was
 * trained with.
 */
export const DEFAULT_VAD_SLICE_OPTIONS: VadSliceOptions = {
  maxSliceSeconds: 30,
  minPauseMs: 98,
  padMs: 200,
  minSpeechMs: 250,
  maxMergeGapMs: 1500,
  pauseBelowSpeechDb: null,
}

const FRAME_SECONDS = 0.01
const QUIET_WINDOW_SECONDS = 0.1
/** The noise floor is this percentile of the frame levels. */
const NOISE_FLOOR_PERCENTILE = 0.1
/** With `pauseBelowSpeechDb`, the speech level is this percentile of the frame levels. */
const SPEECH_LEVEL_PERCENTILE = 0.9
/**
 * How far above the noise floor a frame may be and still be silent. The 10th percentile sits
 * a few dB under typical noise frames, and voiced speech is 20 dB or more above it. Kept low
 * on purpose: noise taken for speech only makes a slice longer, but speech taken for silence
 * can fall between two slices and never be decoded.
 */
const SILENCE_MARGIN_DB = 6
/**
 * A frame within this of the loudest frame, and louder than `LOUD_FRAME_DB`, is always speech.
 * Only matters when the recording has no quiet frames except digital silence (speech joined
 * with zeros), where the floor would otherwise be the speech itself. The absolute level keeps
 * a quiet room on its own, which is just as level, silent.
 */
const SPEECH_HEADROOM_DB = 10
const LOUD_FRAME_DB = -30
/**
 * Frames at or below this are digital silence (zeros, dither) and are left out of the noise
 * floor, so a recording padded with zeros still finds its real room noise.
 */
const DIGITAL_SILENCE_DB = -80
/** A recording whose loudest frame is below this has nothing to decode. */
const SILENT_CLIP_DB = -60

interface Loudness {
  frameLength: number
  /** Mean square of each frame. */
  energy: Float64Array
  /** 1 where the frame is silent. */
  silent: Uint8Array
}

/** Frame levels and which frames are silent, or `null` when the whole recording is silent. */
function frameLoudness(
  samples: Float32Array,
  sampleRate: number,
  pauseBelowSpeechDb: number | null
): Loudness | null {
  const frameLength = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const frameCount = Math.ceil(samples.length / frameLength)
  const energy = new Float64Array(frameCount)
  const levels = new Float64Array(frameCount)
  let loudest = -Infinity
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * frameLength
    const end = Math.min(samples.length, start + frameLength)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
    energy[f] = sum / (end - start)
    // 1e-20 keeps a frame of zeros finite (-200 dB).
    levels[f] = 10 * Math.log10(Math.max(energy[f], 1e-20))
    loudest = Math.max(loudest, levels[f])
  }
  if (!(loudest >= SILENT_CLIP_DB)) return null

  const audible = levels.filter((level) => level > DIGITAL_SILENCE_DB).sort()
  const floor =
    audible[Math.floor((audible.length - 1) * NOISE_FLOOR_PERCENTILE)]
  const aboveFloor =
    pauseBelowSpeechDb === null
      ? floor + SILENCE_MARGIN_DB
      : Math.max(
          floor + SILENCE_MARGIN_DB,
          audible[Math.floor((audible.length - 1) * SPEECH_LEVEL_PERCENTILE)] -
            pauseBelowSpeechDb
        )
  const threshold = Math.min(
    aboveFloor,
    Math.max(loudest - SPEECH_HEADROOM_DB, LOUD_FRAME_DB)
  )
  const silent = new Uint8Array(frameCount)
  for (let f = 0; f < frameCount; f += 1) {
    silent[f] = levels[f] < threshold ? 1 : 0
  }
  return { frameLength, energy, silent }
}

interface Span {
  start: number
  end: number
}

/** Runs of loud frames as samples, with pauses shorter than `minPauseSamples` bridged. */
function loudSpeech(
  loudness: Loudness,
  minPauseSamples: number,
  sampleCount: number
): Span[] {
  const { frameLength, silent } = loudness
  const spans: Span[] = []
  let f = 0
  while (f < silent.length) {
    if (silent[f] === 1) {
      f += 1
      continue
    }
    let end = f
    while (end < silent.length && silent[end] === 0) end += 1
    const span = {
      start: f * frameLength,
      end: Math.min(sampleCount, end * frameLength),
    }
    const last = spans[spans.length - 1]
    if (last !== undefined && span.start - last.end < minPauseSamples) {
      last.end = span.end
    } else {
      spans.push(span)
    }
    f = end
  }
  return spans
}

/** The given regions clamped to the audio, sorted, and overlapping ones joined. */
function maskedSpeech(regions: SpeechRegion[], sampleCount: number): Span[] {
  const clamp = (sample: number) =>
    Math.min(sampleCount, Math.max(0, Math.round(sample)))
  const sorted = regions
    .map((region) => ({
      start: clamp(region.startSample),
      end: clamp(region.endSample),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start)
  const spans: Span[] = []
  for (const span of sorted) {
    const last = spans[spans.length - 1]
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
    } else {
      spans.push(span)
    }
  }
  return spans
}

/** Where a slice can end. */
interface Cut {
  /** The end of the slice before the cut. */
  end: number
  /** The start of the slice after it. */
  resume: number
  /** Samples of pause the cut sits in; 0 for a forced cut. */
  length: number
  /** The cut is inside a run of speech (forced, or at a silence in it): the slices meet there. */
  inSpeech: boolean
}

/** The later of two equally long pauses wins. */
function longer(a: Cut | null, b: Cut): Cut {
  return a === null ||
    b.length > a.length ||
    (b.length === a.length && b.end > a.end)
    ? b
    : a
}

/** The longest run of silent frames wholly inside `[from, to)`, at least `minPause` long. */
function longestSilence(
  loudness: Loudness,
  from: number,
  to: number,
  minPauseSamples: number
): Cut | null {
  const { frameLength, silent } = loudness
  const first = Math.ceil(from / frameLength)
  const last = Math.floor(to / frameLength)
  let longest: Cut | null = null
  let f = first
  while (f < last) {
    if (silent[f] === 0) {
      f += 1
      continue
    }
    let end = f
    while (end < last && silent[end] === 1) end += 1
    const length = (end - f) * frameLength
    if (length >= minPauseSamples) {
      const centre = Math.floor(((f + end) * frameLength) / 2)
      longest = longer(longest, {
        end: centre,
        resume: centre,
        length,
        inSpeech: true,
      })
    }
    f = end
  }
  return longest
}

/**
 * Where to cut speech that runs past the cap from `sliceStart`, given the speech from index
 * `next` on: between half the cap and the cap, at the longest pause, a gap between two speech
 * runs or a silence inside one (the later of two equal ones), else at the centre of the
 * quietest 100 ms. A gap counts where the slice before it would end, at the speech's end.
 */
function cutPoint(
  loudness: Loudness,
  speech: Span[],
  next: number,
  sliceStart: number,
  cap: number,
  minPauseSamples: number,
  sampleRate: number
): Cut {
  const from = sliceStart + cap / 2
  const to = sliceStart + cap

  let longest: Cut | null = null
  for (let i = next; i < speech.length && speech[i].start < to; i += 1) {
    const inside = longestSilence(
      loudness,
      Math.max(from, speech[i].start),
      Math.min(to, speech[i].end),
      minPauseSamples
    )
    if (inside !== null) longest = longer(longest, inside)
    const following = speech[i + 1]
    if (
      following !== undefined &&
      speech[i].end >= from &&
      speech[i].end <= to &&
      following.start - speech[i].end >= minPauseSamples
    ) {
      longest = longer(longest, {
        end: speech[i].end,
        resume: following.start,
        length: following.start - speech[i].end,
        inSpeech: false,
      })
    }
  }
  if (longest !== null) return longest

  const forced = quietestPoint(loudness, sliceStart, from, to, sampleRate)
  return { end: forced, resume: forced, length: 0, inSpeech: true }
}

/** The centre of the quietest 100 ms wholly inside `[from, to)`. */
function quietestPoint(
  loudness: Loudness,
  sliceStart: number,
  from: number,
  to: number,
  sampleRate: number
): number {
  const { frameLength, energy } = loudness
  // Frames wholly inside the range.
  const first = Math.ceil(from / frameLength)
  const last = Math.floor(to / frameLength)
  const window = Math.max(
    1,
    Math.round((QUIET_WINDOW_SECONDS * sampleRate) / frameLength)
  )
  if (last - first < window) return Math.max(sliceStart + 1, last * frameLength)
  let sum = 0
  for (let i = first; i < first + window; i += 1) sum += energy[i]
  let quietest = sum
  let quietestStart = first
  for (let i = first + 1; i + window <= last; i += 1) {
    sum += energy[i + window - 1] - energy[i - 1]
    if (sum < quietest) {
      quietest = sum
      quietestStart = i
    }
  }
  return Math.floor(((quietestStart * 2 + window) * frameLength) / 2)
}

interface PlannedSlice extends Span {
  /** The slice starts where a cut inside speech ended the one before it. */
  startsAtCut: boolean
}

/**
 * Speech merged into slices of at most `cap` samples. A pause longer than `maxGap` samples
 * always ends a slice; speech that runs past the cap is cut where `cutAt` says.
 */
function mergeAndCut(
  speech: Span[],
  cap: number,
  maxGap: number,
  cutAt: (next: number, sliceStart: number) => Cut
): PlannedSlice[] {
  const slices: PlannedSlice[] = []
  let next = 0
  let start = speech[0]?.start ?? 0
  let startsAtCut = false
  while (next < speech.length) {
    // The speech this slice could hold: up to the first pause longer than `maxGap`.
    let last = next
    while (
      last + 1 < speech.length &&
      speech[last + 1].start - speech[last].end <= maxGap
    ) {
      last += 1
    }
    if (speech[last].end - start <= cap) {
      slices.push({ start, end: speech[last].end, startsAtCut })
      next = last + 1
      if (next < speech.length) {
        start = speech[next].start
        startsAtCut = false
      }
      continue
    }
    const cut = cutAt(next, start)
    slices.push({ start, end: cut.end, startsAtCut })
    start = cut.resume
    startsAtCut = cut.inSpeech
    while (next < speech.length && speech[next].end <= start) next += 1
  }
  return slices
}

/** How many samples of `speech` (sorted, disjoint) fall inside `span`. */
function speechWithin(speech: Span[], span: Span): number {
  let total = 0
  for (const region of speech) {
    if (region.start >= span.end) break
    total += Math.max(
      0,
      Math.min(region.end, span.end) - Math.max(region.start, span.start)
    )
  }
  return total
}

/**
 * Plans the slices. `speechRegions`, when given (e.g. from a Silero pass), is the speech
 * mask; otherwise speech is derived from loudness. Either way the pauses a long stretch of
 * speech is cut at come from loudness. Returns `[]` when there is no speech to decode.
 */
export function planVadSlices(
  samples: Float32Array,
  sampleRate: number,
  options?: Partial<VadSliceOptions>,
  speechRegions?: SpeechRegion[]
): AudioSlice[] {
  const {
    maxSliceSeconds,
    minPauseMs,
    padMs,
    minSpeechMs,
    maxMergeGapMs,
    pauseBelowSpeechDb,
  } = {
    ...DEFAULT_VAD_SLICE_OPTIONS,
    ...options,
  }
  if (!(sampleRate > 0) || !(maxSliceSeconds > 0)) {
    throw new Error(
      `cannot plan slices at ${sampleRate} Hz with a ${maxSliceSeconds} s cap`
    )
  }
  const loudness = frameLoudness(samples, sampleRate, pauseBelowSpeechDb)
  if (loudness === null) return []

  const toSamples = (ms: number) =>
    Math.max(0, Math.round((ms / 1000) * sampleRate))
  const minPauseSamples = toSamples(minPauseMs)
  const pad = toSamples(padMs)
  const cap = Math.floor(maxSliceSeconds * sampleRate)
  // Plan the speech short enough that both pads still fit under the cap.
  const speechCap = Math.floor(Math.max(cap / 2, cap - 2 * pad))

  const speech =
    speechRegions === undefined
      ? loudSpeech(loudness, minPauseSamples, samples.length)
      : maskedSpeech(speechRegions, samples.length)
  const planned = mergeAndCut(
    speech,
    speechCap,
    toSamples(maxMergeGapMs),
    (next, sliceStart) =>
      cutPoint(
        loudness,
        speech,
        next,
        sliceStart,
        speechCap,
        minPauseSamples,
        sampleRate
      )
  )

  // A piece of a cut-up stretch of speech is never dropped, however short: it is that
  // speech's end.
  const minSpeech = toSamples(minSpeechMs)
  const kept = planned.filter(
    (slice, i) =>
      slice.startsAtCut ||
      planned[i + 1]?.startsAtCut === true ||
      speechWithin(speech, slice) >= minSpeech
  )

  // Each side of a gap takes up to `pad` of it, and the rest is in no slice. A gap too short
  // for both pads is split at its middle, so at a forced cut neighbours meet exactly at it.
  const midpoints = kept
    .slice(1)
    .map((slice, i) => Math.floor((kept[i].end + slice.start) / 2))
  return kept.map((slice, i) => {
    let startSample = Math.max(slice.start - pad, i > 0 ? midpoints[i - 1] : 0)
    let endSample = Math.min(
      slice.end + pad,
      i < midpoints.length ? midpoints[i] : samples.length
    )
    // The cap wins over the padding: the end pad gives way first.
    if (endSample - startSample > cap) {
      endSample = Math.max(slice.end, startSample + cap)
      startSample = Math.max(startSample, endSample - cap)
    }
    return { startSample, endSample }
  })
}

/**
 * crispasr's `--vad-import` "chunks" file, as text (crispasr v0.8.41, `crispasr_parse_vad_slices`).
 *
 * No `chunk_cs`: an imported file that has one is checked against `--chunk-seconds` and warns
 * on every run when they differ, and an absent one counts as unknown.
 */
export function vadImportJson(
  slices: AudioSlice[],
  sampleRate: number
): string {
  // The parser reads digits and stops at anything else, so a fraction would be cut short.
  const integer = (value: number) => {
    if (!Number.isInteger(value)) {
      throw new Error(`--vad-import needs whole numbers, got ${value}`)
    }
    return value
  }
  const centiseconds = (sample: number) =>
    Math.round((sample / sampleRate) * 100)
  return JSON.stringify({
    crispasr_vad: {
      version: 1,
      kind: 'chunks',
      sample_rate: integer(sampleRate),
      num_slices: slices.length,
      slices: slices.map((slice) => ({
        start: integer(slice.startSample),
        end: integer(slice.endSample),
        t0_cs: centiseconds(slice.startSample),
        t1_cs: centiseconds(slice.endSample),
      })),
    },
  })
}

function ascii(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + 4))
}

/**
 * Reads a PCM WAV (16-bit int and 32-bit float, mono or multi-channel downmixed) into mono
 * Float32 samples. Throws a clear Error on anything else.
 *
 * A data size of 0 or 0xFFFFFFFF is a header a recorder never finished (hound leaves 0 until
 * it finalizes), so the samples are read to the end of the file. A size past the end is read
 * as far as the bytes go.
 */
export function readWavSamples(bytes: Uint8Array): {
  samples: Float32Array
  sampleRate: number
} {
  if (
    bytes.length < 12 ||
    ascii(bytes, 0) !== 'RIFF' ||
    ascii(bytes, 8) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let format: {
    encoding: number
    channels: number
    sampleRate: number
    bitsPerSample: number
  } | null = null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (body + 16 > bytes.length)
        throw new Error('WAV fmt chunk is cut short')
      let encoding = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (encoding === 0xfffe && size >= 40 && body + 26 <= bytes.length) {
        encoding = view.getUint16(body + 24, true)
      }
      format = {
        encoding,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (format === null)
        throw new Error('WAV data chunk comes before its fmt chunk')
      return {
        samples: downmixedSamples(view, body, size, format),
        sampleRate: format.sampleRate,
      }
    }
    offset = body + size + (size % 2)
  }
  throw new Error(
    format === null ? 'WAV has no fmt chunk' : 'WAV has no data chunk'
  )
}

function downmixedSamples(
  view: DataView,
  body: number,
  size: number,
  format: {
    encoding: number
    channels: number
    sampleRate: number
    bitsPerSample: number
  }
): Float32Array {
  const { encoding, channels, sampleRate, bitsPerSample } = format
  const pcm16 = encoding === 1 && bitsPerSample === 16
  const float32 = encoding === 3 && bitsPerSample === 32
  if (!pcm16 && !float32) {
    throw new Error(
      `unsupported WAV format ${encoding} at ${bitsPerSample} bits (only 16-bit PCM and 32-bit float)`
    )
  }
  if (channels < 1 || sampleRate < 1) {
    throw new Error(`WAV header says ${channels} channels at ${sampleRate} Hz`)
  }
  const unfinished = size === 0 || size === 0xffffffff
  const end = unfinished
    ? view.byteLength
    : Math.min(view.byteLength, body + size)
  const bytesPerSample = bitsPerSample / 8
  const frameBytes = bytesPerSample * channels
  const frameCount = Math.max(0, Math.floor((end - body) / frameBytes))
  const samples = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) {
      const at = body + i * frameBytes + c * bytesPerSample
      sum += pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true)
    }
    samples[i] = sum / channels
  }
  return samples
}
