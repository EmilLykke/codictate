/**
 * Where Codictate cuts the audio on the `nt-vad` decode path, handed to crispasr with
 * `--vad-import` (issue #83). Pure: samples in, slices out.
 *
 * With `-nt`, whisper.cpp decodes in 30 s windows and, after an early end-of-text, skips the
 * rest of the window, so the speech after it is lost (ADR-0010). A slice of 20 s or less that
 * starts and ends in a pause leaves no window to skip. crispasr decodes imported `"chunks"`
 * exactly as written, with no merge and no re-pack, so these slices are what each decode sees.
 *
 * The plan is WhisperX's cut-and-merge with faster-whisper's split rule:
 * 1. Loudness in 10 ms frames finds the pauses: a frame is silent when it is within a few dB
 *    of the recording's own noise floor.
 * 2. Speech is the given `speechRegions` (a Silero pass), or else the runs of loud frames with
 *    pauses shorter than `minPauseMs` bridged.
 * 3. Neighbouring speech is merged greedily into slices up to the cap. The pauses between
 *    merged speech stay in the slice.
 * 4. Speech longer than the cap is cut in its back half at the longest pause, else at the
 *    centre of the quietest 100 ms (crispasr's own `crispasr_rechunk_slices` rule).
 * 5. Slices with too little speech are dropped, and each slice keeps `padMs` of real audio on
 *    both sides, never overlapping a neighbour and never past the cap.
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
}

/**
 * 98 ms is whisper.cpp's own shortest pause for splitting long VAD regions, and 250 ms is
 * Silero's `min_speech_duration_ms`.
 */
export const DEFAULT_VAD_SLICE_OPTIONS: VadSliceOptions = {
  maxSliceSeconds: 20,
  minPauseMs: 98,
  padMs: 200,
  minSpeechMs: 250,
}

const FRAME_SECONDS = 0.01
const QUIET_WINDOW_SECONDS = 0.1
/** The noise floor is this percentile of the frame levels. */
const NOISE_FLOOR_PERCENTILE = 0.1
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
  sampleRate: number
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
  const threshold = Math.min(
    floor + SILENCE_MARGIN_DB,
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

/**
 * Where to cut speech that runs past the cap from `sliceStart`: between half the cap and the
 * cap, at the centre of the longest pause, else at the centre of the quietest 100 ms.
 */
function cutPoint(
  loudness: Loudness,
  sliceStart: number,
  cap: number,
  minPauseSamples: number,
  sampleRate: number
): number {
  const { frameLength, energy, silent } = loudness
  // Frames wholly inside the range.
  const first = Math.ceil((sliceStart + cap / 2) / frameLength)
  const last = Math.floor((sliceStart + cap) / frameLength)

  let longest: Span | null = null
  let f = first
  while (f < last) {
    if (silent[f] === 0) {
      f += 1
      continue
    }
    let end = f
    while (end < last && silent[end] === 1) end += 1
    if (
      (end - f) * frameLength >= minPauseSamples &&
      (longest === null || end - f > longest.end - longest.start)
    ) {
      longest = { start: f, end }
    }
    f = end
  }
  if (longest !== null) {
    return Math.floor(((longest.start + longest.end) * frameLength) / 2)
  }

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
  /** The slice starts where a forced cut ended the one before it. */
  startsAtCut: boolean
}

/** Speech merged greedily into slices of at most `cap` samples, cutting what runs longer. */
function mergeAndCut(
  speech: Span[],
  cap: number,
  cutAt: (sliceStart: number) => number
): PlannedSlice[] {
  const slices: PlannedSlice[] = []
  let next = 0
  let headStart = speech[0]?.start ?? 0
  let headAtCut = false
  while (next < speech.length) {
    const start = headStart
    const startsAtCut = headAtCut
    if (speech[next].end - start > cap) {
      const cut = cutAt(start)
      slices.push({ start, end: cut, startsAtCut })
      headStart = cut
      headAtCut = true
      continue
    }
    let end = speech[next].end
    next += 1
    while (next < speech.length && speech[next].end - start <= cap) {
      end = speech[next].end
      next += 1
    }
    slices.push({ start, end, startsAtCut })
    if (next < speech.length) {
      headStart = speech[next].start
      headAtCut = false
    }
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
  const { maxSliceSeconds, minPauseMs, padMs, minSpeechMs } = {
    ...DEFAULT_VAD_SLICE_OPTIONS,
    ...options,
  }
  if (!(sampleRate > 0) || !(maxSliceSeconds > 0)) {
    throw new Error(
      `cannot plan slices at ${sampleRate} Hz with a ${maxSliceSeconds} s cap`
    )
  }
  const loudness = frameLoudness(samples, sampleRate)
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
  const planned = mergeAndCut(speech, speechCap, (sliceStart) =>
    cutPoint(loudness, sliceStart, speechCap, minPauseSamples, sampleRate)
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

  // Neighbours split the gap between them, so at a forced cut they meet exactly at the cut.
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
