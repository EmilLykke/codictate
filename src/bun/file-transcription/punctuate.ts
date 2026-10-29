/**
 * Punctuation Restoration for a File Transcription: the text and its Timed Transcript
 * together, so captions show the punctuated words at the times they were spoken.
 *
 * The Punctuation Restorer keeps the word count, so the punctuated words map onto the Raw
 * Transcript's whitespace words by index. Each span of the Timed Transcript (a part, or a
 * word inside one) takes the punctuated form of every word whose first character it holds.
 * A span that held only the rest of a word (hviske can end a part, or a timed word, inside a
 * whitespace word) is left empty: it is dropped and its time goes to its neighbour.
 *
 * The rebuilt Timed Transcript must pass the same check History and Transcript Export apply
 * (`isTimedTranscript`, text equal to the result's). When it does not, the whole File
 * Transcription goes back unpunctuated, text and timings together, so the two never disagree.
 */

import {
  isTimedTranscript,
  type TimedPart,
  type TimedSpan,
  type TimedTranscript,
} from '../../shared/timed-transcript'
import type { PunctuationRestorer } from '../utils/punctuation/punctuation-restorer'
import { pythonSplit } from '../utils/punctuation/python-text'
import { PYTHON_WHITESPACE } from '../utils/punctuation/python-text-tables'

export interface TranscribedFile {
  text: string
  timedTranscript: TimedTranscript | null
}

type Log = (message: string, data?: Record<string, unknown>) => void

export async function punctuateFileTranscription(
  file: TranscribedFile,
  restorer: Pick<PunctuationRestorer, 'restore'>,
  log: Log
): Promise<TranscribedFile> {
  // Nothing to punctuate, and the Restorer would hand back '' for whitespace.
  if (file.text.trim() === '') return file
  const restored = await restorer.restore(file.text)
  if (!restored.restored) return file
  if (file.timedTranscript === null) {
    return { text: restored.text, timedTranscript: null }
  }
  const timedTranscript = rebuildTimedTranscript(
    file.text,
    file.timedTranscript,
    restored.text
  )
  if (timedTranscript === null) {
    log('punctuated Timed Transcript failed validation, kept it unpunctuated')
    return file
  }
  return { text: restored.text, timedTranscript }
}

/** Where each whitespace word starts, split the way the Punctuation Restorer splits. */
function wordStarts(text: string): number[] {
  const starts: number[] = []
  for (let i = 0; i < text.length; i++) {
    const space = PYTHON_WHITESPACE.includes(text[i])
    const afterSpace = i === 0 || PYTHON_WHITESPACE.includes(text[i - 1])
    if (!space && afterSpace) starts.push(i)
  }
  return starts
}

function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/u.test(text[i])) i += 1
  return i
}

/**
 * Where each span sits in `text`, from `from` on: the walk `isTimedTranscript` makes. `null`
 * when the spans do not spell `text` out, which a valid Timed Transcript never does.
 */
function offsetsOf(
  text: string,
  spans: readonly TimedSpan[],
  from = 0
): number[] | null {
  const offsets: number[] = []
  let cursor = from
  for (const span of spans) {
    const at = skipSpace(text, cursor)
    if (!text.startsWith(span.text, at)) return null
    offsets.push(at)
    cursor = at + span.text.length
  }
  return offsets
}

interface Time {
  start: number
  end: number
}

/**
 * Each span with its punctuated text (`rebuild`), empty spans dropped and their time given
 * (`retime`) to the span before them, or to the one after when there is none before.
 */
function respan<T extends TimedSpan>(
  spans: readonly T[],
  offsets: readonly number[],
  punctuate: (from: number, to: number) => string,
  rebuild: (span: T, index: number, text: string) => T,
  retime: (span: T, time: Time) => T
): T[] {
  const out: T[] = []
  let orphan: Time | null = null
  spans.forEach((span, index) => {
    const text = punctuate(offsets[index], offsets[index] + span.text.length)
    if (text === '') {
      const previous = out[out.length - 1] as T | undefined
      if (previous === undefined) {
        orphan = { start: orphan?.start ?? span.start, end: span.end }
      } else {
        out[out.length - 1] = retime(previous, {
          start: previous.start,
          end: Math.max(previous.end, span.end),
        })
      }
      return
    }
    const next = rebuild(span, index, text)
    out.push(
      orphan === null
        ? next
        : retime(next, {
            start: Math.min(orphan.start, next.start),
            end: next.end,
          })
    )
    orphan = null
  })
  return out
}

const retimeWord = (word: TimedSpan, time: Time): TimedSpan => ({
  ...word,
  ...time,
})

/** A part's first and last words move with it, so captions built from words agree. */
function retimePart(part: TimedPart, time: Time): TimedPart {
  const words = part.words?.map((word, index, all) => ({
    ...word,
    start: index === 0 ? Math.min(word.start, time.start) : word.start,
    end: index === all.length - 1 ? Math.max(word.end, time.end) : word.end,
  }))
  return words === undefined
    ? { ...part, ...time }
    : { ...part, ...time, words }
}

/** The Timed Transcript on the punctuated text, or `null` when it cannot be rebuilt exactly. */
function rebuildTimedTranscript(
  raw: string,
  timed: TimedTranscript,
  punctuated: string
): TimedTranscript | null {
  if (timed.text !== raw) return null
  const starts = wordStarts(raw)
  const words = pythonSplit(punctuated)
  if (words.length !== starts.length) return null
  const wordAt = new Map(starts.map((start, index) => [start, index]))
  const punctuate = (from: number, to: number) => {
    const held: string[] = []
    for (let i = from; i < to; i++) {
      const index = wordAt.get(i)
      if (index !== undefined) held.push(words[index])
    }
    return held.join(' ')
  }

  const partOffsets = offsetsOf(raw, timed.parts)
  if (partOffsets === null) return null
  const wordOffsets: (number[] | null)[] = timed.parts.map((part, index) =>
    part.words === undefined
      ? null
      : offsetsOf(raw, part.words, partOffsets[index])
  )
  if (timed.parts.some((part, index) => part.words && !wordOffsets[index])) {
    return null
  }

  const parts = respan<TimedPart>(
    timed.parts,
    partOffsets,
    punctuate,
    ({ start, end, words: timedWords }, index, text) =>
      timedWords === undefined
        ? { text, start, end }
        : {
            text,
            start,
            end,
            words: respan(
              timedWords,
              wordOffsets[index]!,
              punctuate,
              (word, _index, wordText) => ({ ...word, text: wordText }),
              retimeWord
            ),
          },
    retimePart
  )

  const rebuilt: TimedTranscript = { text: punctuated, parts }
  return parts.length > 0 && isTimedTranscript(rebuilt) ? rebuilt : null
}
