/**
 * The Timed Transcript (GLOSSARY.md): a Raw Transcript and when each part of it was spoken.
 * Its text is always exactly the Raw Transcript. Parts and words are spans of that text, in
 * order, with only whitespace (or nothing) between them, so nothing built from it can say
 * anything the Raw Transcript does not. Pure.
 */

export interface TimedSpan {
  /** This span of the Raw Transcript, exactly, trimmed. Never empty. */
  text: string
  /** Seconds from the start of the audio. */
  start: number
  /** Seconds from the start of the audio, never before `start`. */
  end: number
}

export interface TimedPart extends TimedSpan {
  /** Spans of `text` in spoken order, when the Speech Engine timed words. */
  words?: TimedSpan[]
}

export interface TimedTranscript {
  /** Always exactly the Raw Transcript. */
  text: string
  /** Non-empty, in spoken order. */
  parts: TimedPart[]
}

/** What an engine hands over before it is checked against the Raw Transcript. */
export interface TimedPiece {
  text: string
  start: number
  end: number
  words?: { text: string; start: number; end: number }[]
}

/**
 * Characters of a script written without spaces between words. Script_Extensions rather than
 * Script, so the CJK full stop and comma (`。`, `、`, Script=Common) count with the Han and
 * kana around them; the fullwidth `！？，：；` are listed because they extend no script.
 */
const NO_SPACE_SCRIPT =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}！，：；？]/u

/**
 * The Raw Transcript a run's pieces (crispasr segment texts, Parakeet sentences) make, in order.
 * - If any piece after the first starts with whitespace, the engine marks word boundaries with
 *   a leading space (Whisper): pieces are concatenated as written, so a piece that continues a
 *   word stays glued to it.
 * - Otherwise (Edda-style, Parakeet sentences): one space between pieces, except between two
 *   characters of a script written without spaces.
 * Empty pieces are dropped; the result is trimmed at both ends; nothing inside is touched.
 */
export function joinTranscriptPieces(pieces: readonly string[]): string {
  const kept = pieces.filter((piece) => piece.trim() !== '')
  if (kept.length === 0) return ''
  const leadingSpaces = kept.slice(1).some((piece) => /^\s/u.test(piece))
  let out = kept[0]
  for (const piece of kept.slice(1)) {
    if (leadingSpaces || /\s$/u.test(out) || /^\s/u.test(piece)) {
      out += piece
      continue
    }
    const before = Array.from(out).pop() ?? ''
    const after = Array.from(piece)[0] ?? ''
    out +=
      NO_SPACE_SCRIPT.test(before) && NO_SPACE_SCRIPT.test(after)
        ? piece
        : ` ${piece}`
  }
  return out.trim()
}

function finiteTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/u.test(text[i])) i += 1
  return i
}

/** Spans of `text` in order, or `null` when the pieces do not spell it out exactly. */
function spansOf(
  text: string,
  pieces: readonly { text: string; start: number; end: number }[]
): TimedSpan[] | null {
  const out: TimedSpan[] = []
  let cursor = 0
  for (const piece of pieces) {
    const trimmed = piece.text.trim()
    if (trimmed === '') continue
    if (!finiteTime(piece.start) || !finiteTime(piece.end)) return null
    const at = skipSpace(text, cursor)
    if (!text.startsWith(trimmed, at)) return null
    out.push({
      text: trimmed,
      start: piece.start,
      end: Math.max(piece.start, piece.end),
    })
    cursor = at + trimmed.length
  }
  return text.slice(cursor).trim() === '' ? out : null
}

/**
 * A Timed Transcript whose text is exactly `text`, or `null` when the pieces do not spell it
 * out in order. Never an approximate one. Words that do not line up inside their part are
 * dropped (the part keeps its own timing).
 */
export function timedTranscriptFromPieces(
  text: string,
  pieces: readonly TimedPiece[]
): TimedTranscript | null {
  if (text.trim() === '' || text !== text.trim()) return null
  const partSpans = spansOf(text, pieces)
  if (partSpans === null || partSpans.length === 0) return null
  const kept = pieces.filter((piece) => piece.text.trim() !== '')
  const parts = partSpans.map((span, index): TimedPart => {
    const words = kept[index].words
    const wordSpans =
      words && words.length > 0 ? spansOf(span.text, words) : null
    return wordSpans && wordSpans.length > 0
      ? { ...span, words: wordSpans }
      : span
  })
  return { text, parts }
}

function isSpanShaped(
  value: unknown
): value is { text: string; start: number; end: number } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { text?: unknown; start?: unknown; end?: unknown }
  return (
    typeof v.text === 'string' &&
    typeof v.start === 'number' &&
    typeof v.end === 'number'
  )
}

function isPieceShaped(value: unknown): value is TimedPiece {
  if (!isSpanShaped(value)) return false
  const words = (value as { words?: unknown }).words
  return (
    words === undefined || (Array.isArray(words) && words.every(isSpanShaped))
  )
}

function sameSpan(a: TimedSpan, b: TimedSpan): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end
}

/**
 * For reading a stored one back (History sidecar): the shape, and the span rule, both hold.
 * Stricter than `timedTranscriptFromPieces`: a stored value it would have to correct (an
 * untrimmed or empty part, `end` before `start`, a word that does not line up) is refused,
 * not repaired, so whatever passes is already exactly what that function would build.
 */
export function isTimedTranscript(value: unknown): value is TimedTranscript {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { text?: unknown; parts?: unknown }
  if (typeof v.text !== 'string' || !Array.isArray(v.parts)) return false
  if (!v.parts.every(isPieceShaped)) return false
  const stored = v.parts as TimedPiece[]
  const rebuilt = timedTranscriptFromPieces(v.text, stored)
  if (rebuilt === null || rebuilt.parts.length !== stored.length) return false
  return rebuilt.parts.every((part, index) => {
    const original = stored[index]
    if (!sameSpan(part, original)) return false
    const words = original.words
    if (words === undefined) return part.words === undefined
    return (
      part.words !== undefined &&
      part.words.length === words.length &&
      part.words.every((word, w) => sameSpan(word, words[w]))
    )
  })
}
