/**
 * The Punctuation Restorer: Punctuation Restoration for a Raw Transcript, with ekko-pnc.
 *
 * One call, `restore(text)`, gives back the text with punctuation and capitals added, and
 * whether that worked. It never throws: whatever goes wrong (the Punctuation Model fails to
 * load, a model run fails, the result would not have the same words, or it takes too long),
 * the caller gets its input back unchanged with `restored: false`, and the cause is logged.
 * A Dictation must never be lost to a punctuation fault.
 *
 * Inside it, in order:
 *
 * - **The strip step** removes the marks a Speech Engine already put at word ends.
 * - **The port** of the Python reference (`ekko-pnc.ts`), byte-identical to
 *   `ekko-stt[pnc]==0.1.2`'s `Punctuator.__call__` on the same weights.
 *
 * The Punctuation Model comes from an injected loader, so everything here runs in tests on a
 * fake one. It is loaded once and kept for the life of the process: a call made during a
 * load waits for that load, and a failed load is tried again on the next call. There is no
 * lock; concurrent calls only read the loaded model.
 */

import { log as appLog } from '../logger'
import { planWindows, punctuateWords } from './ekko-pnc'
import { pythonSplit } from './python-text'

/** What Python's `tokenizer.encode(words, is_pretokenized=True)` gives. */
export interface PretokenizedEncoding {
  /** `encoding.ids`, special tokens included. */
  ids: readonly number[]
  /** `encoding.word_ids`: the word each token belongs to, null for a special token. */
  wordIds: readonly (number | null)[]
}

/** One model run's output tensor: row-major scores of shape `[1, tokens, labels]`. */
export interface PunctuationLogits {
  data: ArrayLike<number>
  dims: readonly number[]
}

/**
 * A loaded Punctuation Model: what the Python reference holds as its tokenizer, ONNX
 * session and `id2label`. The real one is the tokenizer from `tokenizer.json`, one CPU ONNX
 * Runtime session on `pnc.int8.onnx`, and the label table from `config.json`.
 */
export interface PunctuationModel {
  /**
   * Tokenize whitespace words as one pretokenized sequence, exactly as the Python
   * `tokenizers` library does with `is_pretokenized=True` and `tokenizer.json`'s own
   * settings. Synchronous; may throw.
   */
  encode(words: readonly string[]): PretokenizedEncoding
  /**
   * One session run on a single sequence of at most 128 ids: `input_ids` of shape
   * `[1, n]` (int64) and an all-ones `attention_mask` of the same shape. Resolves to the
   * first output. May reject.
   */
  run(inputIds: readonly number[]): Promise<PunctuationLogits>
  /** `config.json`'s `id2label`, keyed by label id (`O`, `,`, `.|U`, ...). */
  labels: ReadonlyMap<number, string>
}

/** Opens the Punctuation Model. Called once, and again only after a failure. */
export type PunctuationModelLoader = () => Promise<PunctuationModel>

export interface RestoredText {
  /** The punctuated text, or the input unchanged when `restored` is false. */
  text: string
  restored: boolean
}

export interface PunctuationRestorer {
  /** Punctuate a Raw Transcript. Never throws. */
  restore(text: string): Promise<RestoredText>
  /**
   * Load the Punctuation Model ahead of the first call, for the background warm-up.
   * Resolves once the load has finished or failed; never throws.
   */
  warmUp(): Promise<void>
}

/** The timeout's clock. Injected so tests can drive time by hand. */
export interface RestorerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface PunctuationRestorerOptions {
  loadModel: PunctuationModelLoader
  /**
   * Hand the text to the port with its existing marks, as the Python `__call__` sees it.
   * Only for the parity check against the Python reference; the app always strips.
   */
  keepExistingPunctuation?: boolean
  log?: typeof appLog
  clock?: RestorerClock
}

/**
 * A call gives up after `max(10 s, 100 ms × model runs)`, measured from when it was made.
 * Measured: a model run takes 3 to 8 ms and the load about 250 ms, so only something stuck
 * gets near it, and a long File Transcription still gets 100 ms per run.
 */
const TIMEOUT_MS = 10_000
const TIMEOUT_PER_WINDOW_MS = 100

const LOG_TAG = 'punctuation'

const systemClock: RestorerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createPunctuationRestorer(
  options: PunctuationRestorerOptions
): PunctuationRestorer {
  const log = options.log ?? appLog
  const clock = options.clock ?? systemClock
  let model: PunctuationModel | null = null
  let loading: Promise<PunctuationModel> | null = null

  function loadModel(): Promise<PunctuationModel> {
    if (model) return Promise.resolve(model)
    if (!loading) {
      loading = options.loadModel().then(
        (loaded) => {
          model = loaded
          loading = null
          return loaded
        },
        (error: unknown) => {
          loading = null
          throw error
        }
      )
    }
    return loading
  }

  async function punctuate(
    words: string[],
    onWindowCount: (windows: number) => void
  ): Promise<string> {
    const loaded = await loadModel()
    const windows = planWindows(loaded, words)
    onWindowCount(windows.length)
    const text = (await punctuateWords(loaded, words, windows)).join(' ')
    const outputWords = pythonSplit(text).length
    if (outputWords !== words.length) {
      throw new Error(
        `Punctuation changed the word count: ${words.length} -> ${outputWords}`
      )
    }
    return text
  }

  return {
    restore(text) {
      const words = pythonSplit(text)
      const input = options.keepExistingPunctuation
        ? words
        : words.map(stripWordEndMarks)
      // `" ".join([])`: what the Python reference gives for a text with no words.
      if (input.length === 0)
        return Promise.resolve({ text: '', restored: true })

      const startedAt = clock.now()
      return new Promise((resolve) => {
        let settled = false
        let timer: unknown

        const finish = (result: RestoredText, cause?: unknown) => {
          if (settled) return
          settled = true
          clock.clearTimeout(timer)
          if (cause !== undefined) {
            log(
              LOG_TAG,
              'Punctuation Restoration failed, kept the text as is',
              {
                cause: describe(cause),
                words: words.length,
              }
            )
          }
          resolve(result)
        }
        const giveUpAfter = (budgetMs: number) => {
          clock.clearTimeout(timer)
          timer = clock.setTimeout(
            () =>
              finish(
                { text, restored: false },
                `timed out after ${budgetMs} ms`
              ),
            Math.max(0, startedAt + budgetMs - clock.now())
          )
        }

        giveUpAfter(TIMEOUT_MS)
        punctuate(input, (windows) =>
          giveUpAfter(Math.max(TIMEOUT_MS, TIMEOUT_PER_WINDOW_MS * windows))
        ).then(
          (punctuated) => finish({ text: punctuated, restored: true }),
          (error: unknown) => finish({ text, restored: false }, error)
        )
      })
    },

    async warmUp() {
      try {
        await loadModel()
      } catch (error) {
        log(LOG_TAG, 'Punctuation Model failed to load', {
          cause: describe(error),
        })
      }
    },
  }
}

/**
 * The strip step: drop the `,` `.` `?` `!` a Speech Engine already put at the end of a word
 * (`dig,` -> `dig`, `f.eks.` -> `f.eks`; `3,5` keeps its inner comma). The Python reference
 * keeps existing marks and adds its own, which gives `,,`, `,?` and `f.eks..` on hviske's
 * output. A word made only of marks is left whole: emptying it would change the word count,
 * which File Transcription relies on to map punctuated words back onto their times.
 * Outside the parity surface, and a no-op for ekko, whose Raw Transcript has no marks.
 */
function stripWordEndMarks(word: string): string {
  const stripped = word.replace(/[,.?!]+$/, '')
  return stripped === '' ? word : stripped
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
