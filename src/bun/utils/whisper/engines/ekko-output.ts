/**
 * What `parakeet-cli transcribe --json` printed for one ekko slice, read, and the Timed
 * Transcript piece it makes. Pure: bytes in, values out. The spawning is `ekko-engine.ts`.
 */

import type { TimedPiece } from '../../../../shared/timed-transcript'

/**
 * The longest a word may last in an ekko Timed Transcript, in seconds. A word's start is
 * clamped to `max(start, end - 0.8)`.
 *
 * Without it the first word after a pause starts up to 6 s early, because parakeet-cli gives
 * it the pause too, and a caption shows up seconds before anything is said. 0.8 s is about the
 * p95 length of a Danish word. Measured on the gate (#78): on `da_5min` the p10 first-word
 * offset went from -3.6 s to -0.7 s.
 */
export const EKKO_MAX_WORD_SECONDS = 0.8

/** One word as `parakeet-cli` timed it, in seconds from the start of its slice. */
export interface EkkoWord {
  text: string
  start: number
  end: number
}

export type ParakeetCliParse =
  { ok: true; text: string; words: EkkoWord[] } | { ok: false; detail: string }

/** `<unk>` is the tokenizer's unknown piece; it shows inside words (`tv<unk>skærme`), never in `text`. */
const UNKNOWN_PIECE = '<unk>'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Reads `text` and `words[] {w, start, end}` and ignores the rest (`frame_sec`, `tokens`,
 * `conf`). Each word loses its `<unk>` pieces, and a word left empty is dropped: a silent slice
 * prints `text: ""` with one empty word. Not UTF-8, not JSON, or no string `text` is unreadable;
 * a malformed word is dropped, since `text` alone is the transcript.
 */
export function parseParakeetCliJson(bytes: Uint8Array): ParakeetCliParse {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      ok: false,
      detail: `${bytes.length} bytes of stdout were not UTF-8`,
    }
  }
  let json: unknown
  try {
    json = JSON.parse(decoded)
  } catch {
    return {
      ok: false,
      detail: `stdout is not JSON: ${decoded.trim().slice(0, 200)}`,
    }
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, detail: 'stdout JSON is not an object' }
  }
  const { text, words } = json as { text?: unknown; words?: unknown }
  if (typeof text !== 'string') {
    return { ok: false, detail: 'stdout JSON has no string `text`' }
  }
  const cleaned: EkkoWord[] = []
  for (const word of Array.isArray(words) ? words : []) {
    if (typeof word !== 'object' || word === null) continue
    const { w, start, end } = word as {
      w?: unknown
      start?: unknown
      end?: unknown
    }
    if (
      typeof w !== 'string' ||
      !isFiniteNumber(start) ||
      !isFiniteNumber(end)
    ) {
      continue
    }
    const wordText = w.split(UNKNOWN_PIECE).join('').trim()
    if (wordText === '') continue
    cleaned.push({ text: wordText, start, end })
  }
  return { ok: true, text: text.trim(), words: cleaned }
}

/**
 * The Timed Transcript piece for one slice, or `null` for a slice with no text. Words are
 * shifted by the slice's start and clamped to `EKKO_MAX_WORD_SECONDS`; the piece runs from the
 * first clamped start to the last end. Text with no timed words spans the whole slice.
 */
export function ekkoTimedPiece(
  decoded: { text: string; words: readonly EkkoWord[] },
  slice: { startSeconds: number; endSeconds: number }
): TimedPiece | null {
  if (decoded.text === '') return null
  const words = decoded.words.map((word) => {
    const start = word.start + slice.startSeconds
    const end = word.end + slice.startSeconds
    return {
      text: word.text,
      start: Math.max(start, end - EKKO_MAX_WORD_SECONDS),
      end,
    }
  })
  if (words.length === 0) {
    return {
      text: decoded.text,
      start: slice.startSeconds,
      end: slice.endSeconds,
    }
  }
  return {
    text: decoded.text,
    start: words[0].start,
    end: words[words.length - 1].end,
    words,
  }
}
