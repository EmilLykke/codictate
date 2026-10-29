import { describe, expect, test } from 'bun:test'
import pythonTitlecase from './fixtures/python-titlecase.json'
import {
  createPunctuationRestorer,
  type PunctuationModel,
  type PunctuationModelLoader,
} from './punctuation-restorer'

/**
 * ekko-pnc's label table has this shape: a mark, optionally with `|U` for "capitalise".
 * The last label is one no real table has: its mark starts with a space, so the word it
 * renders becomes two.
 */
const LABELS = ['O', ',', '.', '?', '!', 'O|U', ',|U', '.|U', '?|U', ' -']

interface FakeModelOptions {
  /** The label the fake model predicts for a word, by its text. */
  labels?: Record<string, string>
  /** The label for every other word. Default `O`. */
  otherWords?: string
  /** How many subtokens the fake tokenizer splits a word into. Default 1. */
  subtokens?: (word: string) => number
}

/**
 * A stand-in for the real ekko-pnc session and tokenizer. It tokenizes like a BERT-style
 * pretokenized encode (one special token at each end, one or more subtokens per word),
 * refuses more than 128 tokens like the real model's input, and predicts each token's
 * label from the word it belongs to. Non-first subtokens predict `!`, so a word labelled
 * from anything but its first subtoken shows it.
 */
function fakeModel(options: FakeModelOptions = {}): PunctuationModel {
  const vocabulary: { word: string; first: boolean }[] = [
    { word: '[CLS]', first: true },
    { word: '[SEP]', first: true },
  ]
  return {
    labels: new Map(LABELS.map((label, id) => [id, label])),
    encode(words) {
      const ids = [0]
      const wordIds: (number | null)[] = [null]
      words.forEach((word, index) => {
        const count = options.subtokens?.(word) ?? 1
        for (let piece = 0; piece < count; piece++) {
          vocabulary.push({ word, first: piece === 0 })
          ids.push(vocabulary.length - 1)
          wordIds.push(index)
        }
      })
      ids.push(1)
      wordIds.push(null)
      return { ids, wordIds }
    },
    async run(inputIds) {
      if (inputIds.length > 128) throw new Error('more than 128 tokens')
      const data = new Float32Array(inputIds.length * LABELS.length)
      inputIds.forEach((id, token) => {
        const { word, first } = vocabulary[id]
        const label = first
          ? (options.labels?.[word] ?? options.otherWords ?? 'O')
          : '!'
        data[token * LABELS.length + LABELS.indexOf(label)] = 1
      })
      return { data, dims: [1, inputIds.length, LABELS.length] }
    },
  }
}

function loaderFor(model: PunctuationModel): PunctuationModelLoader {
  return async () => model
}

/** Hand-driven time for the timeout: nothing fires until the test advances it. */
function fakeClock() {
  let now = 0
  let nextHandle = 1
  const timers = new Map<unknown, { at: number; callback: () => void }>()
  return {
    clock: {
      now: () => now,
      setTimeout(callback: () => void, ms: number): unknown {
        const handle = nextHandle++
        timers.set(handle, { at: now + ms, callback })
        return handle
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle)
      },
    },
    async advanceTo(ms: number) {
      await settle()
      now = ms
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(handle)
        timer.callback()
      }
      await settle()
    },
  }
}

/** Let every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A promise's result so far, without waiting for it. */
function track<T>(promise: Promise<T>): { result: T | undefined } {
  const state: { result: T | undefined } = { result: undefined }
  void promise.then((result) => (state.result = result))
  return state
}

const never = () => new Promise<never>(() => {})

describe('Punctuation Restorer', () => {
  test('renders predicted marks and starts each sentence with a capital', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(
        fakeModel({ labels: { dig: ',', det: '?', godt: '.' } })
      ),
    })

    expect(
      await restorer.restore(
        'hej med dig hvordan går det jeg håber alt er godt'
      )
    ).toEqual({
      text: 'Hej med dig, hvordan går det? Jeg håber alt er godt.',
      restored: true,
    })
  })

  test('capitalises on |U and never touches a word that already has a capital', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(
        fakeModel({
          labels: {
            NATO: ',|U',
            går: '.',
            iPhone: 'O|U',
            nyt: '.',
            sagt: ',',
            'f.eks': '.',
            gange: '.',
            københavn: 'O|U',
          },
        })
      ),
    })

    expect(
      await restorer.restore(
        'vi så DR og NATO i går iPhone er nyt ﬁnt sagt i københavn f.eks mange gange'
      )
    ).toEqual({
      text: 'Vi så DR og NATO, i går. iPhone er nyt. Fint sagt, i København f.eks. mange gange.',
      restored: true,
    })
  })

  test('strips the marks a Speech Engine already put at word ends, so none double', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(
        fakeModel({
          labels: { dig: ',', det: '?', 'f.eks': '.', København: '.' },
        })
      ),
    })

    expect(
      await restorer.restore(
        'Hej med dig, hvordan går det, der er 3,5 mio. mennesker i f.eks. København?!'
      )
    ).toEqual({
      text: 'Hej med dig, hvordan går det? Der er 3,5 mio mennesker i f.eks. København.',
      restored: true,
    })
  })

  test('can hand the text to the port with its marks, as the Python reference sees it', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(
        fakeModel({
          labels: { 'dig,': ',', 'det,': '?', håber: ',', 'f.eks.': '.' },
        })
      ),
      keepExistingPunctuation: true,
    })

    expect(
      await restorer.restore(
        'Hej med dig, hvordan går det, jeg håber du har det godt.'
      )
    ).toEqual({
      text: 'Hej med dig,, hvordan går det,? Jeg håber, du har det godt.',
      restored: true,
    })
    expect(
      await restorer.restore('Der er 3,5 mio. mennesker i f.eks. København.')
    ).toEqual({
      text: 'Der er 3,5 mio. Mennesker i f.eks.. København.',
      restored: true,
    })
  })

  test('punctuates every word of a text far longer than one model run takes', async () => {
    // 1,000 words; every fifth splits into three subtokens and one into 200, more than a
    // whole model run holds. Every seventh word ends a sentence.
    const words = Array.from({ length: 1000 }, (_, index) => `ord${index}`)
    const endsSentence = (index: number) => index % 7 === 6
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(
        fakeModel({
          labels: Object.fromEntries(
            words.map((word, index) => [word, endsSentence(index) ? '.' : 'O'])
          ),
          subtokens: (word) =>
            word === 'ord500' ? 200 : Number(word.slice(3)) % 5 === 0 ? 3 : 1,
        })
      ),
    })

    const expected = words
      .map((word, index) =>
        index === 0 || endsSentence(index - 1) ? `O${word.slice(1)}` : word
      )
      .map((word, index) => (endsSentence(index) ? `${word}.` : word))
      .join(' ')
    expect(await restorer.restore(words.join(' '))).toEqual({
      text: expected,
      restored: true,
    })
  })

  test('capitalises a first letter the way Python str.title() does', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(fakeModel({ otherWords: 'O|U' })),
    })

    expect(await restorer.restore('ßvar ǆep ﬁnt ŉ ǅ Ǆ')).toEqual({
      text: 'Ssvar ǅep Fint ʼN ǅ Ǆ',
      restored: true,
    })
  })

  test('matches Python on every code point whose title case differs from its upper case', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(fakeModel({ otherWords: 'O|U' })),
    })
    const { codePoints } = pythonTitlecase

    const { text } = await restorer.restore(
      codePoints.map(({ character }) => character).join(' ')
    )

    expect(text.split(' ')).toEqual(
      codePoints.map(({ capitalized }) => capitalized)
    )
  })

  test('splits words on exactly what Python str.split() treats as whitespace', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(fakeModel({ labels: { med: ',' } })),
    })

    // U+001C and U+0085 are Python whitespace but not JavaScript's; U+FEFF is the reverse.
    expect(
      await restorer.restore('  hej\u001cmed\u0085dig\ufeffder \u3000 ')
    ).toEqual({ text: 'Hej med, dig\ufeffder', restored: true })
  })

  test('keeps a word made only of marks, so the word count never changes', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: loaderFor(fakeModel()),
    })

    expect(await restorer.restore('hej ... med dig')).toEqual({
      text: 'Hej ... Med dig',
      restored: true,
    })
  })
  describe('gives back the input untouched, never an error', () => {
    const input = 'hej med dig, hvordan går det'
    const unchanged = { text: input, restored: false }

    test('when the Punctuation Model fails to load, and says why', async () => {
      const logged: string[] = []
      const restorer = createPunctuationRestorer({
        loadModel: async () => {
          throw new Error('pnc.int8.onnx is missing')
        },
        log: (_tag, message, data) =>
          logged.push(`${message} ${JSON.stringify(data)}`),
      })

      expect(await restorer.restore(input)).toEqual(unchanged)
      expect(logged.join('\n')).toContain('pnc.int8.onnx is missing')
    })

    test('when a model run fails', async () => {
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor({
          ...fakeModel(),
          run: async () => {
            throw new Error('onnxruntime: invalid input')
          },
        }),
      })

      expect(await restorer.restore(input)).toEqual(unchanged)
    })

    test('when the model predicts a label it has no name for', async () => {
      const model = fakeModel({ labels: { dig: ',' } })
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor({ ...model, labels: new Map([[0, 'O']]) }),
      })

      expect(await restorer.restore('hej med dig hvordan')).toEqual({
        text: 'hej med dig hvordan',
        restored: false,
      })
    })

    test('when the result would not have the same number of words', async () => {
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor(fakeModel({ labels: { dig: ' -' } })),
      })

      expect(await restorer.restore(input)).toEqual(unchanged)
    })

    test('when the tokenizer points at a word that is not there', async () => {
      const model = fakeModel()
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor({
          ...model,
          encode: (words) => {
            const { ids, wordIds } = model.encode(words)
            return {
              ids,
              wordIds: wordIds.map((id) => (id === null ? id : id + 1)),
            }
          },
        }),
      })

      expect(await restorer.restore(input)).toEqual(unchanged)
    })

    test('when a short text is still running after 10 s', async () => {
      const { clock, advanceTo } = fakeClock()
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor({ ...fakeModel(), run: never }),
        clock,
      })

      const call = track(restorer.restore(input))
      await advanceTo(9_999)
      expect(call.result).toBeUndefined()
      await advanceTo(10_000)
      expect(call.result).toEqual(unchanged)
    })

    test('when a long text is still running after 100 ms per model run', async () => {
      // Every word is longer than one model run holds, so each takes a run of its own.
      const words = Array.from({ length: 200 }, (_, index) => `ord${index}`)
      const { clock, advanceTo } = fakeClock()
      const restorer = createPunctuationRestorer({
        loadModel: loaderFor({
          ...fakeModel({ subtokens: () => 200 }),
          run: never,
        }),
        clock,
      })

      const call = track(restorer.restore(words.join(' ')))
      await advanceTo(19_999)
      expect(call.result).toBeUndefined()
      await advanceTo(20_000)
      expect(call.result).toEqual({ text: words.join(' '), restored: false })
    })

    test('when the load itself hangs past 10 s', async () => {
      const { clock, advanceTo } = fakeClock()
      const restorer = createPunctuationRestorer({ loadModel: never, clock })

      const call = track(restorer.restore(input))
      await advanceTo(10_000)
      expect(call.result).toEqual(unchanged)
    })
  })

  describe('loads the Punctuation Model once', () => {
    test('and keeps it for every later call', async () => {
      let loads = 0
      const restorer = createPunctuationRestorer({
        loadModel: async () => {
          loads += 1
          return fakeModel()
        },
      })

      await restorer.restore('hej')
      await restorer.restore('med dig')
      expect(loads).toBe(1)
    })

    test('shares one load between calls made while it runs', async () => {
      let loads = 0
      let finishLoad: (model: PunctuationModel) => void = () => {}
      const restorer = createPunctuationRestorer({
        loadModel: () => {
          loads += 1
          return new Promise((resolve) => (finishLoad = resolve))
        },
      })

      const warm = restorer.warmUp()
      const first = restorer.restore('hej med dig')
      const second = restorer.restore('hvordan går det')
      finishLoad(fakeModel())

      await warm
      expect(await first).toEqual({ text: 'Hej med dig', restored: true })
      expect(await second).toEqual({ text: 'Hvordan går det', restored: true })
      expect(loads).toBe(1)
    })

    test('and tries again on the next call after a failed load', async () => {
      let loads = 0
      const restorer = createPunctuationRestorer({
        loadModel: async () => {
          loads += 1
          if (loads === 1) throw new Error('disk busy')
          return fakeModel()
        },
      })

      expect(await restorer.restore('hej')).toEqual({
        text: 'hej',
        restored: false,
      })
      expect(await restorer.restore('hej')).toEqual({
        text: 'Hej',
        restored: true,
      })
    })

    test('and a failed warm-up neither throws nor stops the next call loading', async () => {
      let loads = 0
      const restorer = createPunctuationRestorer({
        loadModel: async () => {
          loads += 1
          if (loads === 1) throw new Error('disk busy')
          return fakeModel()
        },
      })

      await restorer.warmUp()
      expect(await restorer.restore('hej')).toEqual({
        text: 'Hej',
        restored: true,
      })
    })
  })

  test('gives an empty text back empty, as the Python reference does', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: never,
    })

    expect(await restorer.restore(' \n ')).toEqual({ text: '', restored: true })
  })
})
