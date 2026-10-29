/**
 * The port of ekko-pnc's Python reference: `Punctuator.__call__` from `ekko/pnc.py` in the
 * `ekko-stt[pnc]==0.1.2` wheel (not GitHub `main`, which has moved on). Its output must be
 * byte-identical to that reference on the same weights, so every step below follows the
 * Python line for line, including its edge behaviour; the names in brackets are the Python
 * functions each piece mirrors. Changing it means bumping the pin and regenerating the parity
 * fixture, not improving it here.
 *
 * Internal to the Punctuation Restorer: callers go through `punctuation-restorer.ts`.
 */

import { isAlpha, isUpperOrTitle, title } from './python-text'
import type { PunctuationModel } from './punctuation-restorer'

/** `Punctuator(max_length=128)`: the most tokens one model run sees. */
const MAX_LENGTH = 128
/** `Punctuator(overlap_words=12)`: words of context shared by neighbouring windows. */
const OVERLAP_WORDS = 12

/** One model run: the words it sees, and the slice of them whose predictions are kept. */
export interface PunctuationWindow {
  contextStart: number
  windowEnd: number
  emitStart: number
  emitEnd: number
}

/**
 * Where the windows fall [`_punctuate_words_locked`]. The Python decides each window from
 * token counts alone, never from a prediction, so the whole sequence can be laid out before
 * the first model run; that is what lets the restorer size its timeout by window count.
 */
export function planWindows(
  model: PunctuationModel,
  words: readonly string[]
): PunctuationWindow[] {
  const encoding = model.encode(words)
  const tokenCounts = new Array<number>(words.length).fill(0)
  let specialTokens = 0
  for (const wordId of encoding.wordIds) {
    if (wordId === null) {
      specialTokens += 1
    } else {
      tokenCounts[checkedWordIndex(wordId, words.length)] += 1
    }
  }
  const prefix = [0]
  for (const count of tokenCounts)
    prefix.push(prefix[prefix.length - 1] + count)

  const maxWindowEnd = (start: number): number => {
    const tokenBudget = prefix[start] + MAX_LENGTH - specialTokens
    return Math.min(
      words.length,
      start + MAX_LENGTH,
      Math.max(start + 1, bisectRight(prefix, tokenBudget) - 1)
    )
  }

  const windows: PunctuationWindow[] = []
  let nextWord = 0
  while (nextWord < words.length) {
    let contextStart = Math.max(0, nextWord - OVERLAP_WORDS)
    let windowEnd = maxWindowEnd(contextStart)
    if (windowEnd <= nextWord) {
      contextStart = nextWord
      windowEnd = maxWindowEnd(contextStart)
    }
    const finalWindow = windowEnd === words.length
    const emitEnd = finalWindow
      ? windowEnd
      : Math.max(nextWord + 1, windowEnd - OVERLAP_WORDS)
    windows.push({ contextStart, windowEnd, emitStart: nextWord, emitEnd })
    nextWord = emitEnd
  }
  return windows
}

/**
 * Punctuate whitespace words along a window plan [`punctuate_words`]: one model run per
 * window, in order, then the sentence-case pass. Throws on anything the Python would raise
 * on, and on a change in the number of words.
 */
export async function punctuateWords(
  model: PunctuationModel,
  words: readonly string[],
  windows: readonly PunctuationWindow[]
): Promise<string[]> {
  if (words.length === 0) return []
  const output: string[] = []
  for (const window of windows) {
    const rendered = await predictWindow(
      model,
      words.slice(window.contextStart, window.windowEnd)
    )
    output.push(
      ...rendered.slice(
        window.emitStart - window.contextStart,
        window.emitEnd - window.contextStart
      )
    )
  }
  if (output.length !== words.length) {
    throw new Error(
      `PnC changed word cardinality: ${words.length} -> ${output.length}`
    )
  }
  return stabilizeSentenceCase(output)
}

/** One model run over one window's words, rendered with their labels [`_predict_window`]. */
async function predictWindow(
  model: PunctuationModel,
  words: readonly string[]
): Promise<string[]> {
  const encoding = model.encode(words)
  const ids = encoding.ids.slice(0, MAX_LENGTH)
  const wordIds = encoding.wordIds.slice(0, MAX_LENGTH)
  const logits = await model.run(ids)
  const predictions = argmaxRows(logits, ids.length)

  const rendered = [...words]
  const seen = new Set<number>()
  wordIds.forEach((wordId, index) => {
    if (wordId === null || seen.has(wordId)) return
    seen.add(wordId)
    const prediction = predictions[index]
    const label = model.labels.get(prediction)
    if (label === undefined) {
      throw new Error(`PnC predicted label id ${prediction}, not in id2label`)
    }
    const upper = label.endsWith('|U')
    const mark = upper ? label.slice(0, -2) : label
    const word = words[checkedWordIndex(wordId, words.length)]
    rendered[wordId] =
      (upper ? capitalizeInitialPreservingCase(word) : word) +
      (mark === 'O' ? '' : mark)
  })
  return rendered
}

/**
 * `logits[0].argmax(-1)` for the first `rows` tokens: numpy's argmax, which keeps the first
 * of equal maxima and treats NaN as the maximum.
 */
function argmaxRows(
  logits: { data: ArrayLike<number>; dims: readonly number[] },
  rows: number
): number[] {
  const [batch, tokens, labels] = logits.dims
  if (
    logits.dims.length !== 3 ||
    batch < 1 ||
    tokens < rows ||
    labels < 1 ||
    logits.data.length < tokens * labels
  ) {
    throw new Error(
      `PnC logits have shape [${logits.dims.join(', ')}] for ${rows} tokens`
    )
  }
  const predictions: number[] = []
  for (let row = 0; row < rows; row++) {
    const offset = row * labels
    let best = 0
    let bestValue = logits.data[offset]
    if (!Number.isNaN(bestValue)) {
      for (let label = 1; label < labels; label++) {
        const value = logits.data[offset + label]
        if (Number.isNaN(value)) {
          best = label
          break
        }
        if (value > bestValue) {
          best = label
          bestValue = value
        }
      }
    }
    predictions.push(best)
  }
  return predictions
}

/**
 * [`_capitalize_initial_preserving_case`] Title-case the first letter, unless the word
 * already holds an uppercase or titlecase character anywhere (`NATO`, `iPhone`, `DR` stay).
 */
function capitalizeInitialPreservingCase(word: string): string {
  const characters = Array.from(word)
  if (characters.some(isUpperOrTitle)) return word
  const index = characters.findIndex(isAlpha)
  if (index === -1) return word
  characters[index] = title(characters[index])
  return characters.join('')
}

/**
 * [`_stabilize_sentence_case`] Capitalise the first word and every word after one ending in
 * `.`, `!` or `?`, except after an abbreviation like `f.eks.`. Like the Python, the loop
 * reads the words as they stood before it started (it iterates a slice copy), so a word it
 * capitalises is not re-read when deciding about the next one.
 */
function stabilizeSentenceCase(words: string[]): string[] {
  if (words.length === 0) return words
  const rendered = [...words]
  rendered[0] = capitalizeInitialPreservingCase(rendered[0])
  const before = rendered.slice(0, -1)
  before.forEach((word, index) => {
    if (!/[.!?]$/.test(word) || isAbbreviation(word)) return
    rendered[index + 1] = capitalizeInitialPreservingCase(rendered[index + 1])
  })
  return rendered
}

/** A `.` with a letter on both sides somewhere inside the word (`f.eks.`, `i.e.`). */
function isAbbreviation(word: string): boolean {
  const characters = Array.from(word)
  for (let index = 1; index < characters.length - 1; index++) {
    if (
      characters[index] === '.' &&
      isAlpha(characters[index - 1]) &&
      isAlpha(characters[index + 1])
    ) {
      return true
    }
  }
  return false
}

/** Python's `bisect_right` on a non-decreasing list. */
function bisectRight(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (target < values[middle]) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * A tokenizer word id used as a list index. Python raises `IndexError` on one past the end,
 * where JavaScript would quietly grow the array, so check it.
 */
function checkedWordIndex(wordId: number, wordCount: number): number {
  if (!Number.isInteger(wordId) || wordId < 0 || wordId >= wordCount) {
    throw new Error(
      `PnC tokenizer gave word id ${wordId} for ${wordCount} words`
    )
  }
  return wordId
}
