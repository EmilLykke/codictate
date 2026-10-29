/**
 * The long-audio check's ekko gates as pure functions (issue #108): caption timing and the
 * memory verdict. The check itself (`long-audio.manual.ts`) spawns real processes; these only
 * judge what came back, so they are tested hermetically.
 */

import { tokenizeForWer } from '../../../../../benchmarks/stt/wer'

/** An utterance in a long clip: its reference text and where its speech starts, in seconds. */
export interface UtteranceSpeech {
  text: string
  speechStart: number
}

/** One timed word of a Timed Transcript, in seconds. */
export interface TimedWord {
  text: string
  start: number
}

/**
 * Per utterance, its first word's start minus its speech start, in seconds (negative: the
 * caption shows before anyone speaks). The timed words are aligned against the reference
 * words of all utterances (minimum edits); an utterance counts only when its first reference
 * word is matched, and then by that word's start, as #78 measured it. A misheard or lost
 * first word gives no offset rather than the time of some later word.
 */
export function firstWordStartOffsets(
  utterances: readonly UtteranceSpeech[],
  words: readonly TimedWord[]
): number[] {
  const ref: { word: string; utterance: number; first: boolean }[] = []
  utterances.forEach((u, index) => {
    tokenizeForWer(u.text).forEach((word, at) =>
      ref.push({ word, utterance: index, first: at === 0 })
    )
  })
  const hyp = words.map((w) => tokenizeForWer(w.text).join(''))
  const n = ref.length
  const m = hyp.length
  const width = m + 1
  const d = new Uint32Array((n + 1) * width)
  for (let i = 0; i <= n; i += 1) d[i * width] = i
  for (let j = 0; j <= m; j += 1) d[j] = j
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sub =
        d[(i - 1) * width + j - 1] + (ref[i - 1].word === hyp[j - 1] ? 0 : 1)
      d[i * width + j] = Math.min(
        d[(i - 1) * width + j] + 1,
        d[i * width + j - 1] + 1,
        sub
      )
    }
  }
  const firstStart = new Map<number, number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const same = ref[i - 1].word === hyp[j - 1]
    if (d[i * width + j] === d[(i - 1) * width + j - 1] + (same ? 0 : 1)) {
      if (same && ref[i - 1].first)
        firstStart.set(ref[i - 1].utterance, words[j - 1].start)
      i -= 1
      j -= 1
    } else if (d[i * width + j] === d[(i - 1) * width + j] + 1) i -= 1
    else j -= 1
  }
  return utterances.flatMap((u, index) => {
    const start = firstStart.get(index)
    return start === undefined ? [] : [start - u.speechStart]
  })
}

/** First-word start offsets of one clip, in seconds. `worst` is the earliest. */
export interface CaptionTiming {
  count: number
  p10: number
  median: number
  worst: number
}

/**
 * The p10, median and earliest of a clip's first-word start offsets, or `null` when no
 * utterance had its first word matched. A quantile is the sorted value at `floor(p × n)`, as
 * #78 computed it.
 */
export function captionTiming(
  offsets: readonly number[]
): CaptionTiming | null {
  if (offsets.length === 0) return null
  const sorted = [...offsets].sort((a, b) => a - b)
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    count: sorted.length,
    p10: at(0.1),
    median: at(0.5),
    worst: sorted[0],
  }
}

/**
 * The earliest p10 a gated clip may have, in seconds. #78 measured `da_5min` at −3.6 s without
 * ekko's 0.8 s word-start clamp and −0.7 s with it.
 */
export const CAPTION_TIMING_MIN_P10_SECONDS = -1

/** Why a gated clip's caption timing fails, or `null` when it passes. */
export function captionTimingFailure(
  timing: CaptionTiming | null
): string | null {
  if (timing === null)
    return 'no utterance had its first word matched, so caption timing was not measured'
  if (timing.p10 < CAPTION_TIMING_MIN_P10_SECONDS)
    return `p10 first-word start ${timing.p10.toFixed(2)} s, earlier than ${CAPTION_TIMING_MIN_P10_SECONDS.toFixed(1)} s`
  return null
}

/** A `parakeet-cli` process at this peak RSS or more fails the memory check: 1 GB (#78). */
export const PEAK_RSS_LIMIT_BYTES = 1024 * 1024 * 1024

export type PeakRssVerdict =
  | { status: 'pass' | 'fail'; megabytes: number }
  | { status: 'skip'; reason: string }

/**
 * The memory check on one process's peak RSS, in bytes (`maxRSS` of Bun's `resourceUsage`,
 * bytes on macOS). A missing or zero value skips rather than passes: a platform that does not
 * report it has not shown the process fits.
 */
export function peakRssVerdict(
  maxRssBytes: number | undefined
): PeakRssVerdict {
  if (
    maxRssBytes === undefined ||
    !Number.isFinite(maxRssBytes) ||
    maxRssBytes <= 0
  )
    return {
      status: 'skip',
      reason: 'no peak RSS from the process resource usage',
    }
  return {
    status: maxRssBytes >= PEAK_RSS_LIMIT_BYTES ? 'fail' : 'pass',
    megabytes: Math.round(maxRssBytes / (1024 * 1024)),
  }
}
