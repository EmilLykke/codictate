/**
 * A Timed Transcript cut into cues: the pieces a Caption File shows on screen one at a time.
 * Every cue is an exact span of the Raw Transcript, in order, with only whitespace (or
 * nothing) between them, so the captions say exactly what the Raw Transcript says. Pure.
 *
 * Times come from the Speech Engine's word timings where it has them. A part without words
 * (or with words that do not line up) is split on whitespace and its time shared out by
 * character, which is what keeps a 16 s Whisper part from becoming one 16 s cue.
 */

import type { TimedTranscript } from './timed-transcript'

export interface TranscriptCue {
  /** Seconds from the start of the audio. */
  start: number
  /** Seconds from the start of the audio; after `start`, never after the next cue's `start`. */
  end: number
  /** This span of the Raw Transcript, exactly. */
  text: string
  /** `text` wrapped for the screen, each run of whitespace shown as one space. */
  lines: string[]
}

export interface CueRules {
  maxCharsPerLine: number
  maxLines: number
  /** A cue never runs longer than this, unless a single word does. */
  maxSeconds: number
  /** A silence longer than this between two words starts a new cue. */
  pauseSeconds: number
}

/** The broadcast caption conventions every Caption File uses. */
export const CAPTION_CUE_RULES: Readonly<CueRules> = Object.freeze({
  maxCharsPerLine: 42,
  maxLines: 2,
  maxSeconds: 7,
  pauseSeconds: 0.6,
})

/** The shortest a cue is shown for, so a player never gets a zero-length one. */
const MIN_CUE_SECONDS = 0.1

/** A word (or a piece of one) of `t.text`, never containing whitespace. */
interface Unit {
  /** Offsets into `t.text`. */
  from: number
  to: number
  start: number
  end: number
}

/**
 * Characters of a script written without spaces between words, where a line may break
 * between any two characters. Script_Extensions, so `。` and `、` count with the Han and
 * kana around them.
 */
const NO_SPACE_SCRIPT =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}！，：；？]/u
/** Never at the start of a line: closing brackets and quotes, and most punctuation. */
const NO_LINE_START = /[\p{Pe}\p{Pf}\p{Po}]/u
/** Never at the end of a line: opening brackets and quotes. */
const NO_LINE_END = /[\p{Ps}\p{Pi}]/u
/** Code points that take no column of their own and never start a piece. */
const ZERO_WIDTH = /\p{M}|\u200D|\uFE0E|\uFE0F/u
const SENTENCE_END = /[.!?…。！？][\p{Pe}\p{Pf}"']*$/u

function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/u.test(text[i])) i += 1
  return i
}

function firstChar(s: string): string {
  return String.fromCodePoint(s.codePointAt(0) ?? 0)
}

function lastChar(s: string): string {
  return Array.from(s.slice(-2)).pop() ?? ''
}

/** Columns a piece of text without whitespace takes on screen. */
function columns(s: string): number {
  let n = 0
  for (const ch of s) if (!ZERO_WIDTH.test(ch)) n += 1
  return n
}

/** Where `spans` sit in `text` from `offset`, in order, or `null` when they do not line up. */
function locate(
  text: string,
  spans: readonly { text: string }[],
  offset = 0,
  end = text.length
): number[] | null {
  const at: number[] = []
  let cursor = offset
  for (const span of spans) {
    const from = skipSpace(text, cursor)
    if (span.text === '' || !text.startsWith(span.text, from)) return null
    at.push(from)
    cursor = from + span.text.length
  }
  return cursor <= end && text.slice(cursor, end).trim() === '' ? at : null
}

/**
 * `text.slice(from, to)` cut into the pieces a line may break between: at whitespace, and
 * between the characters of a script written without spaces. Its time is shared out by
 * character.
 */
function splitIntoPieces(
  text: string,
  from: number,
  to: number,
  start: number,
  end: number
): Unit[] {
  const length = Math.max(1, to - from)
  const at = (offset: number) =>
    start + ((end - start) * (offset - from)) / length
  const piece = (pieceFrom: number, pieceTo: number): Unit => ({
    from: pieceFrom,
    to: pieceTo,
    start: at(pieceFrom),
    end: at(pieceTo),
  })
  const units: Unit[] = []
  const word = /\S+/gu
  word.lastIndex = from
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    const wordFrom = m.index
    if (wordFrom >= to) break
    const wordTo = Math.min(to, wordFrom + m[0].length)
    let pieceFrom = wordFrom
    let offset = wordFrom
    let before = ''
    for (const ch of text.slice(wordFrom, wordTo)) {
      if (before !== '' && mayBreakBetween(before, ch)) {
        units.push(piece(pieceFrom, offset))
        pieceFrom = offset
      }
      before = ch
      offset += ch.length
    }
    units.push(piece(pieceFrom, wordTo))
  }
  return units
}

/** Every word of the transcript in spoken order, or `null` when the parts do not line up. */
function wordsOf(t: TimedTranscript): Unit[] | null {
  const partAt = locate(t.text, t.parts)
  if (partAt === null) return null
  const units: Unit[] = []
  t.parts.forEach((part, index) => {
    const from = partAt[index]
    const to = from + part.text.length
    const start = part.start
    const end = Math.max(part.start, part.end)
    const words = part.words ?? []
    const wordAt = words.length > 0 ? locate(t.text, words, from, to) : null
    if (wordAt === null) {
      units.push(...splitIntoPieces(t.text, from, to, start, end))
      return
    }
    words.forEach((word, w) => {
      const wordFrom = wordAt[w]
      const wordTo = wordFrom + word.text.length
      units.push(
        ...splitIntoPieces(
          t.text,
          wordFrom,
          wordTo,
          word.start,
          Math.max(word.start, word.end)
        )
      )
    })
  })
  return units
}

/** Whether a line may break between two pieces written with nothing between them. */
function mayBreakBetween(before: string, after: string): boolean {
  if (!NO_SPACE_SCRIPT.test(before) && !NO_SPACE_SCRIPT.test(after)) {
    return false
  }
  return !NO_LINE_START.test(after) && !NO_LINE_END.test(before)
}

/**
 * Pieces written with nothing between them (a Whisper token that continues a word, a comma)
 * become one word, unless a line may break there (between two Han characters).
 */
function joinGlued(text: string, units: readonly Unit[]): Unit[] {
  const out: Unit[] = []
  for (const unit of units) {
    const prev = out[out.length - 1]
    if (
      prev !== undefined &&
      prev.to === unit.from &&
      !mayBreakBetween(
        lastChar(text.slice(prev.from, prev.to)),
        firstChar(text.slice(unit.from, unit.to))
      )
    ) {
      prev.to = unit.to
      prev.end = Math.max(prev.end, unit.end)
      continue
    }
    out.push({ ...unit })
  }
  return out
}

/** A word wider than a line, cut into pieces that fit, its time shared out by character. */
function splitWide(text: string, unit: Unit, maxColumns: number): Unit[] {
  const word = text.slice(unit.from, unit.to)
  if (columns(word) <= maxColumns) return [unit]
  const cuts: number[] = []
  let used = 0
  let offset = unit.from
  for (const ch of word) {
    if (!ZERO_WIDTH.test(ch)) {
      if (used === maxColumns) {
        cuts.push(offset)
        used = 0
      }
      used += 1
    }
    offset += ch.length
  }
  const length = unit.to - unit.from
  const at = (o: number) =>
    unit.start + ((unit.end - unit.start) * (o - unit.from)) / length
  const bounds = [unit.from, ...cuts, unit.to]
  return bounds.slice(1).map((to, i) => {
    const from = bounds[i]
    return { from, to, start: at(from), end: at(to) }
  })
}

interface Layout {
  units: Unit[]
  /** Columns of each unit. */
  width: number[]
  /** 1 when whitespace separates unit `i` from unit `i + 1`, else 0. */
  space: number[]
  /** Column where unit `i` starts if every unit so far were on one line. */
  column: number[]
}

function layoutOf(text: string, units: Unit[]): Layout {
  const width = units.map((u) => columns(text.slice(u.from, u.to)))
  const space = units.map((u, i) =>
    i + 1 < units.length && units[i + 1].from > u.to ? 1 : 0
  )
  const column: number[] = []
  let at = 0
  units.forEach((_, i) => {
    column.push(at)
    at += width[i] + space[i]
  })
  return { units, width, space, column }
}

/** Columns of units `a..b` on one line. */
function lineWidth(layout: Layout, a: number, b: number): number {
  return layout.column[b] + layout.width[b] - layout.column[a]
}

/** The fewest lines units `a..b` fill at `maxColumns` (filling each line as far as it goes). */
function linesNeeded(
  layout: Layout,
  a: number,
  b: number,
  maxColumns: number
): number {
  let lines = 1
  let width = layout.width[a]
  for (let i = a + 1; i <= b; i++) {
    const added = layout.space[i - 1] + layout.width[i]
    if (width + added <= maxColumns) {
      width += added
    } else {
      lines += 1
      width = layout.width[i]
    }
  }
  return lines
}

/**
 * Where the lines of units `a..b` start: the fewest lines that fit, broken so the longest
 * is as short as it can be (two lines break at the word nearest the middle).
 */
function balancedLineStarts(
  layout: Layout,
  a: number,
  b: number,
  maxColumns: number
): number[] {
  const count = linesNeeded(layout, a, b, maxColumns)
  if (count === 1) return [a]
  // best[l][j]: the narrowest widest line for units a..j on l + 1 lines, and where its last line starts.
  const best: { widest: number; lastStart: number }[][] = []
  for (let l = 0; l < count; l++) {
    best.push([])
    for (let j = a; j <= b; j++) {
      let pick = { widest: Infinity, lastStart: -1 }
      if (l === 0) {
        pick = { widest: lineWidth(layout, a, j), lastStart: a }
      } else {
        for (let s = a + l; s <= j; s++) {
          const before = best[l - 1][s - 1 - a].widest
          const widest = Math.max(before, lineWidth(layout, s, j))
          if (widest < pick.widest) pick = { widest, lastStart: s }
        }
      }
      best[l].push(pick)
    }
  }
  const starts: number[] = []
  let end = b
  for (let l = count - 1; l >= 0; l--) {
    const { lastStart } = best[l][end - a]
    starts.unshift(lastStart)
    end = lastStart - 1
  }
  return starts
}

function linesOf(
  text: string,
  layout: Layout,
  a: number,
  b: number,
  maxColumns: number
): string[] {
  const starts = balancedLineStarts(layout, a, b, maxColumns)
  return starts.map((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] - 1 : b
    return text
      .slice(layout.units[s].from, layout.units[e].to)
      .replace(/\s+/gu, ' ')
  })
}

/**
 * Monotonic, never overlapping, each at least `MIN_CUE_SECONDS` long: a cue starts no
 * earlier than the one before it ends, and ends no later than the next one starts unless
 * that would make it too short.
 */
function settleTimes(
  spans: readonly { start: number; end: number }[]
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let previousEnd = 0
  spans.forEach((span, i) => {
    const start = Math.max(span.start, previousEnd)
    let end = Math.max(span.end, start + MIN_CUE_SECONDS)
    const next = spans[i + 1]
    if (next !== undefined) {
      end = Math.min(end, Math.max(next.start, start + MIN_CUE_SECONDS))
    }
    out.push({ start, end })
    previousEnd = end
  })
  return out
}

/**
 * The cues of a Timed Transcript (one that `isTimedTranscript` accepts; anything else gives
 * no cues). Words are taken greedily, and a new cue starts when:
 * - the silence before the next word is longer than `pauseSeconds`;
 * - the cue so far ends a sentence (`.!?…` or `。！？`);
 * - the next word would make it run past `maxSeconds`;
 * - its text would no longer wrap into `maxLines` lines of `maxCharsPerLine`.
 */
export function buildCues(
  t: TimedTranscript,
  rules: CueRules = CAPTION_CUE_RULES
): TranscriptCue[] {
  const words = wordsOf(t)
  if (words === null || words.length === 0) return []
  const maxColumns = Math.max(1, Math.floor(rules.maxCharsPerLine))
  const maxLines = Math.max(1, Math.floor(rules.maxLines))
  const units = joinGlued(t.text, words).flatMap((unit) =>
    splitWide(t.text, unit, maxColumns)
  )
  const layout = layoutOf(t.text, units)

  const groups: { first: number; last: number; start: number; end: number }[] =
    []
  let group = { first: 0, last: 0, start: units[0].start, end: units[0].end }
  for (let i = 1; i < units.length; i++) {
    const prev = units[i - 1]
    const unit = units[i]
    const end = Math.max(group.end, unit.end)
    const startsNew =
      unit.start - prev.end > rules.pauseSeconds ||
      SENTENCE_END.test(t.text.slice(prev.from, prev.to)) ||
      end - group.start > rules.maxSeconds ||
      linesNeeded(layout, group.first, i, maxColumns) > maxLines
    if (startsNew) {
      groups.push(group)
      group = { first: i, last: i, start: unit.start, end: unit.end }
    } else {
      group.last = i
      group.end = end
    }
  }
  groups.push(group)

  const times = settleTimes(groups)
  return groups.map((g, i) => ({
    start: times[i].start,
    end: times[i].end,
    text: t.text.slice(units[g.first].from, units[g.last].to),
    lines: linesOf(t.text, layout, g.first, g.last, maxColumns),
  }))
}
