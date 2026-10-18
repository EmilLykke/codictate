/**
 * crispasr's `-ojf` JSON, read into the Raw Transcript and the Timed Transcript (ADR-0010).
 * Pure: bytes in, values out.
 *
 * crispasr has two JSON writers, and the stock whisper one does not write strict JSON:
 * - It escapes only `"` and `\`, so control characters inside strings pass through raw.
 * - Its token texts are raw byte-level BPE pieces that can end halfway through a UTF-8
 *   character, mixed with Whisper's special tokens (`[_BEG_]`). Its tokens are never read
 *   (ADR-0011), so only the segment texts have to be whole UTF-8.
 *
 * So the file is read as bytes: every byte becomes one code unit (latin1), raw control
 * characters inside strings are escaped, `JSON.parse` runs on that, and each string the
 * transcript needs is turned back into its bytes and decoded as UTF-8. The dispatcher's
 * `\u00XX` escapes are only ever for control characters, which are the same byte either way.
 */

import {
  joinTranscriptPieces,
  timedTranscriptFromPieces,
  type TimedPiece,
  type TimedTranscript,
} from '../../../../shared/timed-transcript'
import type { CrispasrDecoding } from '../whisper-harness-command'

/** Seconds from the start of the audio. */
export interface CrispasrTimedText {
  text: string
  start: number
  end: number
}

export interface CrispasrSegment extends CrispasrTimedText {
  /**
   * The segment's timed tokens in order, tokens without `offsets` dropped. Empty when the
   * writer gave none. Whole characters only from the `--backend` dispatcher's writer, which
   * carries a split character into the next token (upstream #475); that is the only writer
   * whose tokens `crispasrTranscript` reads.
   */
  tokens: CrispasrTimedText[]
}

export type CrispasrJsonParse =
  | {
      ok: true
      /** In the order crispasr wrote them. Empty for a run that heard nothing. */
      segments: CrispasrSegment[]
      /** The language crispasr reports (detected when it detected one), or `null`. */
      language: string | null
    }
  | {
      ok: false
      /**
       * - `not_json`: not JSON even after control characters are escaped.
       * - `not_utf8`: a segment's text is not UTF-8. Same failure as the old stdout check.
       * - `no_transcription`: JSON without a `transcription` array of segments with text.
       */
      reason: 'not_json' | 'not_utf8' | 'no_transcription'
      detail: string
    }

/** One code unit per byte. Not `TextDecoder('latin1')`, which is windows-1252 and remaps 0x80-0x9f. */
function bytesAsCodeUnits(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return out
}

/**
 * Make the old writer's output parseable: escape raw control characters inside strings, and
 * turn a bare `nan`/`inf` number (a `printf("%f")` of a NaN probability) into `null`.
 */
function strictJsonText(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const code = ch.charCodeAt(0)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      else if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    const bare = 'nNiI-'.includes(ch)
      ? /^-?(?:nan|inf(?:inity)?)/i.exec(text.slice(i, i + 9))
      : null
    if (bare !== null && !/[A-Za-z0-9]/.test(text[i - 1] ?? '')) {
      out += 'null'
      i += bare[0].length - 1
      continue
    }
    out += ch
  }
  return out
}

/** The bytes a parsed string stands for. Code units above 0xff (never written) are UTF-8 encoded. */
function stringBytes(value: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (code <= 0xff) bytes.push(code)
    else bytes.push(...new TextEncoder().encode(ch))
  }
  return Uint8Array.from(bytes)
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal }).decode(bytes)
  } catch {
    return null
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Seconds from an `offsets` object (milliseconds), or `null` when it is missing or not numbers. */
function offsetsSeconds(value: unknown): { start: number; end: number } | null {
  if (!isObject(value)) return null
  const { from, to } = value
  if (typeof from !== 'number' || typeof to !== 'number') return null
  return { start: from / 1000, end: to / 1000 }
}

function segmentTokens(raw: unknown): CrispasrTimedText[] {
  if (!Array.isArray(raw)) return []
  const out: CrispasrTimedText[] = []
  for (const token of raw) {
    if (!isObject(token) || typeof token.text !== 'string') continue
    const times = offsetsSeconds(token.offsets)
    if (times === null) continue
    out.push({
      text: decodeUtf8(stringBytes(token.text), false) ?? '',
      ...times,
    })
  }
  return out
}

function reportedLanguage(root: JsonObject): string | null {
  const candidates: unknown[] = []
  if (isObject(root.crispasr)) {
    candidates.push(root.crispasr.language_detected, root.crispasr.language)
  }
  if (isObject(root.result)) candidates.push(root.result.language)
  if (isObject(root.params)) candidates.push(root.params.language)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const decoded = decodeUtf8(stringBytes(candidate), true)
    if (decoded !== null) return decoded
  }
  return null
}

/** Read the bytes of one crispasr `-ojf` file (either writer). */
export function parseCrispasrJson(bytes: Uint8Array): CrispasrJsonParse {
  let root: unknown
  try {
    root = JSON.parse(strictJsonText(bytesAsCodeUnits(bytes)))
  } catch (err) {
    return {
      ok: false,
      reason: 'not_json',
      detail: `${bytes.length} bytes of crispasr JSON did not parse: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!isObject(root) || !Array.isArray(root.transcription)) {
    return {
      ok: false,
      reason: 'no_transcription',
      detail: 'crispasr JSON has no transcription array',
    }
  }

  const segments: CrispasrSegment[] = []
  for (const [index, raw] of root.transcription.entries()) {
    if (!isObject(raw) || typeof raw.text !== 'string') {
      return {
        ok: false,
        reason: 'no_transcription',
        detail: `crispasr JSON segment ${index} has no text`,
      }
    }
    const textBytes = stringBytes(raw.text)
    const text = decodeUtf8(textBytes, true)
    if (text === null) {
      return {
        ok: false,
        reason: 'not_utf8',
        detail: `${textBytes.length} bytes of crispasr segment ${index} text were not UTF-8`,
      }
    }
    const times = offsetsSeconds(raw.offsets) ?? { start: NaN, end: NaN }
    segments.push({ text, ...times, tokens: segmentTokens(raw.tokens) })
  }

  return { ok: true, segments, language: reportedLanguage(root) }
}

/** Tokens merged into words: a token that starts with whitespace starts a new word. */
function wordsOf(tokens: readonly CrispasrTimedText[]): CrispasrTimedText[] {
  const words: CrispasrTimedText[] = []
  for (const token of tokens) {
    const last = words[words.length - 1]
    if (last === undefined || /^\s/u.test(token.text)) {
      words.push({ ...token })
    } else {
      last.text += token.text
      last.end = Math.max(last.end, token.end)
    }
  }
  return words
}

/**
 * Whether the segment times say anything: finite, not all zero, and never running backwards
 * by more than a second.
 */
function segmentTimesUsable(segments: readonly CrispasrTimedText[]): boolean {
  if (segments.length === 0) return false
  if (
    !segments.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
  )
    return false
  if (segments.every((s) => s.start === 0 && s.end === 0)) return false
  return segments.every(
    (s, i) =>
      s.end >= s.start - 1 && (i === 0 || s.start >= segments[i - 1].start - 1)
  )
}

/**
 * A sentence end written straight into the next sentence's capital ("reaktioner.Vi"). Edda
 * starts a sentence it writes mid-slice the way it starts a decode, without the leading space
 * (ADR-0010). A lowercase letter before the stop keeps "U.S.A." whole.
 */
const GLUED_SENTENCE_END = /(\p{Ll}[.!?])(?=\p{Lu})/gu

/**
 * The Raw Transcript and, when the run's times mean anything, the Timed Transcript.
 *
 * The Raw Transcript is the segment texts joined in order (`joinTranscriptPieces`). On
 * `nt-vad` each segment is one slice decoded on its own, so two always meet at a word
 * boundary, and a sentence end glued to the next capital inside a segment gets its space.
 * The Timed Transcript is `null` on the `nt-vad` path: with `-nt` the segment times are not
 * usable (Edda's come back negative), so nothing is built from them. Only hviske (`cohere`)
 * gets word times. On `timestamps` the VAD leaves token times in its own compressed timeline
 * (whisper.cpp #4046), so parts carry segment times and no words (ADR-0011).
 */
export function crispasrTranscript(
  parsed: { segments: readonly CrispasrSegment[] },
  decoding: CrispasrDecoding
): { rawTranscript: string; timedTranscript: TimedTranscript | null } {
  if (decoding === 'nt-vad') {
    return {
      rawTranscript: joinTranscriptPieces(
        parsed.segments.map((segment) =>
          segment.text.replace(GLUED_SENTENCE_END, '$1 ')
        ),
        { separateDecodes: true }
      ),
      timedTranscript: null,
    }
  }
  const rawTranscript = joinTranscriptPieces(
    parsed.segments.map((segment) => segment.text)
  )
  if (rawTranscript === '' || !segmentTimesUsable(parsed.segments)) {
    return { rawTranscript, timedTranscript: null }
  }
  const pieces: TimedPiece[] = parsed.segments.map((segment) => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    words: decoding === 'cohere' ? wordsOf(segment.tokens) : undefined,
  }))
  return {
    rawTranscript,
    timedTranscript: timedTranscriptFromPieces(rawTranscript, pieces),
  }
}
