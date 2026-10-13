/**
 * A Parakeet run's Timed Transcript, from the `timing` on the helper's batch `final` line.
 *
 * Windows times sentences of the Raw Transcript as written, so they only need checking. macOS
 * times the words as the model spoke them, before inverse text normalization (ITN) rewrote
 * some of them ("twenty one" → "21", "five dollars and fifty cents" → "$5.50"). Those spoken
 * words are lined back up with the written words of the Raw Transcript here, and each written
 * word gets the time from the start of the first spoken word it came from to the end of the
 * last. The result's text is always exactly the Raw Transcript, or there is no result. Pure.
 */

import {
  timedTranscriptFromPieces,
  type TimedPiece,
  type TimedTranscript,
} from '../../../../shared/timed-transcript'
import type { ParakeetTimedItem, ParakeetTiming } from './parakeet-output'

/** How far past a mismatch, on each side, the alignment looks for the two to agree again. */
const RESYNC_WINDOW = 24

/** Past this share of unmatched words, the timings are not for this transcript: give up. */
const MAX_UNMATCHED_SHARE = 0.2

/** A written word may close a sentence: `.`, `!`, `?` and kin, before closing quotes. */
const SENTENCE_END = /[.!?…。！？]['"”’»)\]]*$/u

/** What inverse text normalization writes that speech has no letters for. */
const ITN_WRITTEN = /[\p{N}\p{S}\p{P}]/u

interface WrittenWord {
  text: string
  /** Offsets into the Raw Transcript. */
  from: number
  to: number
}

interface Time {
  start: number
  end: number
}

/** The Timed Transcript for `rawTranscript`, or `null` when the timing does not fit it. */
export function parakeetTimedTranscript(
  rawTranscript: string,
  timing: ParakeetTiming | null
): TimedTranscript | null {
  if (timing === null || rawTranscript.trim() === '') return null
  if (timing.unit === 'sentence') {
    return timedTranscriptFromPieces(rawTranscript, timing.items)
  }
  return fromSpokenWords(rawTranscript, timing.items)
}

/** Compared ignoring case, punctuation and Unicode presentation forms. */
function matchKey(word: string): string {
  return word.normalize('NFKC').toLowerCase().replace(/\p{P}/gu, '')
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

function writtenWordsOf(text: string): WrittenWord[] {
  return Array.from(text.matchAll(/\S+/gu), (match) => ({
    text: match[0],
    from: match.index,
    to: match.index + match[0].length,
  }))
}

/**
 * The nearest point past a mismatch at `w[i]` / `s[j]` where a written and a spoken word agree
 * again: `k` written and `l` spoken words on, smallest `k + l` first. Words that are only
 * punctuation never anchor.
 */
function resync(
  written: readonly string[],
  spoken: readonly string[],
  i: number,
  j: number
): { k: number; l: number } | null {
  for (let total = 1; total <= 2 * RESYNC_WINDOW; total += 1) {
    for (
      let k = Math.max(0, total - RESYNC_WINDOW);
      k <= Math.min(total, RESYNC_WINDOW);
      k += 1
    ) {
      const l = total - k
      const w = written[i + k]
      if (w === undefined || spoken[j + l] === undefined) continue
      if (w !== '' && w === spoken[j + l]) return { k, l }
    }
  }
  return null
}

/** Times spread over `span` by each written word's share of the characters. */
function spreadOver(span: Time, words: readonly WrittenWord[]): Time[] {
  const lengths = words.map((word) => Array.from(word.text).length)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const duration = span.end - span.start
  let before = 0
  return lengths.map((length) => {
    const start = span.start + (duration * before) / total
    before += length
    const end = span.start + (duration * before) / total
    return { start: roundMs(start), end: roundMs(end) }
  })
}

function fromSpokenWords(
  rawTranscript: string,
  items: readonly ParakeetTimedItem[]
): TimedTranscript | null {
  const written = writtenWordsOf(rawTranscript)
  const spoken = items
    .map((item) => ({
      text: item.text.trim(),
      start: item.start,
      end: Math.max(item.start, item.end),
    }))
    .filter((item) => item.text !== '')
  if (written.length === 0 || spoken.length === 0) return null

  const wKey = written.map((word) => matchKey(word.text))
  const sKey = spoken.map((word) => matchKey(word.text))
  const times: (Time | null)[] = written.map(() => null)
  // A spoken word that starts the run with no written word yet: the next one starts there.
  let pendingStart: number | null = null
  let unmatched = 0

  const place = (index: number, time: Time): void => {
    times[index] =
      pendingStart === null ? time : { ...time, start: pendingStart }
    pendingStart = null
  }

  let i = 0
  let j = 0
  while (i < written.length || j < spoken.length) {
    if (
      i < written.length &&
      j < spoken.length &&
      wKey[i] !== '' &&
      wKey[i] === sKey[j]
    ) {
      place(i, { start: spoken[j].start, end: spoken[j].end })
      i += 1
      j += 1
      continue
    }

    let k: number
    let l: number
    const found = resync(wKey, sKey, i, j)
    if (found !== null) {
      ;({ k, l } = found)
    } else {
      // Nothing agrees again: what is left is one last block, if it is small enough to be
      // something ITN rewrote ("… costs $5.50") and not a different transcript altogether.
      k = written.length - i
      l = spoken.length - j
      if (k > RESYNC_WINDOW || l > RESYNC_WINDOW) return null
    }

    const blockWritten = written.slice(i, i + k)
    const blockWKeys = wKey.slice(i, i + k)
    const blockSpoken = spoken.slice(j, j + l)
    const blockSKeys = sKey.slice(j, j + l)
    const keyed = (keys: readonly string[]): number =>
      keys.filter((key) => key !== '').length

    if (k > 0 && l > 0) {
      // Written words ITN made from these spoken words: the block spans all of them.
      if (!blockWritten.some((word) => ITN_WRITTEN.test(word.text))) {
        unmatched += keyed(blockWKeys) + keyed(blockSKeys)
      }
      const span: Time = {
        start: blockSpoken[0].start,
        end: blockSpoken[l - 1].end,
      }
      const spread =
        k === l
          ? blockSpoken.map(({ start, end }) => ({ start, end }))
          : spreadOver(span, blockWritten)
      spread.forEach((time, x) => place(i + x, time))
    } else if (l > 0) {
      // Spoken words nothing was written for ("period" became the "." on the word before):
      // the word before ends where they end.
      unmatched += keyed(blockSKeys)
      const previous = i > 0 ? times[i - 1] : null
      if (previous) {
        times[i - 1] = { ...previous, end: blockSpoken[l - 1].end }
      } else {
        pendingStart ??= blockSpoken[0].start
      }
    } else {
      // Written words nothing was spoken for: timed from their neighbours below.
      unmatched += keyed(blockWKeys)
    }
    i += k
    j += l
  }

  const counted =
    wKey.filter((key) => key !== '').length +
    sKey.filter((key) => key !== '').length
  if (counted === 0 || unmatched / counted > MAX_UNMATCHED_SHARE) return null

  const filled = fillFromNeighbours(times)
  if (filled === null) return null
  return timedTranscriptFromPieces(
    rawTranscript,
    sentencesOf(rawTranscript, written, filled)
  )
}

/** Untimed words take the end of the word before, or else the start of the word after. */
function fillFromNeighbours(times: readonly (Time | null)[]): Time[] | null {
  const out: (Time | null)[] = [...times]
  for (let x = 0; x < out.length; x += 1) {
    if (out[x] !== null) continue
    const before = x > 0 ? out[x - 1] : null
    const after = out.slice(x + 1).find((time) => time !== null) ?? null
    const at = before?.end ?? after?.start
    if (at === undefined) return null
    out[x] = { start: at, end: at }
  }
  return out as Time[]
}

/** The written words grouped into one part per sentence, each part a span of the transcript. */
function sentencesOf(
  rawTranscript: string,
  written: readonly WrittenWord[],
  times: readonly Time[]
): TimedPiece[] {
  const pieces: TimedPiece[] = []
  let first = 0
  for (let x = 0; x < written.length; x += 1) {
    const last = x === written.length - 1
    if (!last && !SENTENCE_END.test(written[x].text)) continue
    const words = written.slice(first, x + 1).map((word, n) => ({
      text: word.text,
      start: times[first + n].start,
      end: Math.max(times[first + n].start, times[first + n].end),
    }))
    pieces.push({
      text: rawTranscript.slice(written[first].from, written[x].to),
      start: words[0].start,
      end: Math.max(...words.map((word) => word.end)),
      words,
    })
    first = x + 1
  }
  return pieces
}
