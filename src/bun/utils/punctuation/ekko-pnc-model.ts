/**
 * The real Punctuation Model loader: ekko-pnc's weights from a local folder, opened the way
 * the Python reference (`ekko-stt[pnc]==0.1.2`, `Punctuator.__init__`) opens them.
 *
 * - `pnc.int8.onnx` in one ONNX Runtime session on the CPU execution provider (no GPU, no
 *   WASM), from `onnxruntime-node`, pinned to the version the parity fixture was made with.
 * - `tokenizer.json` in `@huggingface/tokenizers`. Python reads nothing else for the
 *   tokenizer, so neither does this (`tokenizer_config.json` is not read).
 * - `config.json`'s `id2label` as the label table.
 *
 * onnxruntime-node is imported when a model is loaded, not when this module is, so nothing
 * native loads until the first Punctuation Restoration or warm-up.
 *
 * Usage: `createPunctuationRestorer({ loadModel: ekkoPncModelLoader(folder) })`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import type {
  PretokenizedEncoding,
  PunctuationModel,
  PunctuationModelLoader,
} from './punctuation-restorer'

/** `Punctuator(model_filename="pnc.int8.onnx")`. */
const MODEL_FILE = 'pnc.int8.onnx'
const TOKENIZER_FILE = 'tokenizer.json'
const CONFIG_FILE = 'config.json'

/** A loader for the ekko-pnc weights in `modelDir`, for `createPunctuationRestorer`. */
export function ekkoPncModelLoader(modelDir: string): PunctuationModelLoader {
  return () => loadEkkoPncModel(modelDir)
}

async function loadEkkoPncModel(modelDir: string): Promise<PunctuationModel> {
  const [tokenizerJson, config] = await Promise.all([
    readJson(join(modelDir, TOKENIZER_FILE)),
    readJson(join(modelDir, CONFIG_FILE)),
  ])
  const labels = labelTable(config, modelDir)
  const encode = pretokenizedEncoder(tokenizerJson)

  const ort = await import('onnxruntime-node')
  const modelPath = join(modelDir, MODEL_FILE)
  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    })
  } catch (error) {
    throw new Error(
      `could not load PnC model ${modelPath}: ${message(error)}`,
      {
        cause: error,
      }
    )
  }
  const outputName = session.outputNames[0]

  return {
    labels,
    encode,
    async run(inputIds) {
      const dims = [1, inputIds.length]
      const results = await session.run({
        input_ids: new ort.Tensor(
          'int64',
          BigInt64Array.from(inputIds, BigInt),
          dims
        ),
        attention_mask: new ort.Tensor(
          'int64',
          new BigInt64Array(inputIds.length).fill(1n),
          dims
        ),
      })
      const logits = results[outputName]
      if (logits.type !== 'float32') {
        throw new Error(`PnC model gave ${logits.type} logits, not float32`)
      }
      return { data: logits.data as Float32Array, dims: logits.dims }
    },
  }
}

/** `{int(key): value for key, value in config["id2label"].items()}`. */
function labelTable(
  config: unknown,
  modelDir: string
): ReadonlyMap<number, string> {
  const id2label = (config as { id2label?: unknown } | null)?.id2label
  if (typeof id2label !== 'object' || id2label === null) {
    throw new Error(`invalid PnC config in ${modelDir}: no id2label`)
  }
  const labels = new Map<number, string>()
  for (const [key, label] of Object.entries(id2label)) {
    if (!/^\d+$/.test(key) || typeof label !== 'string') {
      throw new Error(
        `invalid PnC config in ${modelDir}: id2label ${JSON.stringify(key)}: ${JSON.stringify(label)}`
      )
    }
    labels.set(Number(key), label)
  }
  return labels
}

interface TemplatePiece {
  SpecialToken?: { id: string }
  Sequence?: { id: string }
}

interface TokenizerJson {
  truncation: unknown
  padding: unknown
  post_processor?: {
    type?: string
    single?: TemplatePiece[]
    special_tokens?: Record<string, { ids: number[] }>
  } | null
}

/**
 * Python's `tokenizer.encode(words, is_pretokenized=True)` with `ids` and `word_ids`, which
 * the JavaScript tokenizer does not have. The Rust tokenizer normalizes, pre-tokenizes and
 * splits each pretokenized word on its own and tags its tokens with the word's index, so
 * encoding word by word without special tokens gives the same tokens; the special tokens
 * then come from `tokenizer.json`'s own single-sequence template (`[CLS] A [SEP]`).
 * `tokenizer.json` has no truncation or padding, which is what lets this skip both.
 */
function pretokenizedEncoder(
  json: unknown
): (words: readonly string[]) => PretokenizedEncoding {
  const config = json as TokenizerJson
  if (config.truncation !== null || config.padding !== null) {
    throw new Error('PnC tokenizer.json sets truncation or padding')
  }
  const processor = config.post_processor
  const template = processor?.single ?? []
  if (
    processor?.type !== 'TemplateProcessing' ||
    template.filter((piece) => piece.Sequence).length !== 1
  ) {
    throw new Error('PnC tokenizer.json has no single-sequence template')
  }
  const specialIds = (name: string): number[] => {
    const ids = processor.special_tokens?.[name]?.ids
    if (!ids) throw new Error(`PnC tokenizer.json has no special token ${name}`)
    return ids
  }
  // Resolve the template once: special token ids, with `null` where the words go.
  const layout = template.flatMap((piece) =>
    piece.SpecialToken ? specialIds(piece.SpecialToken.id) : [null]
  )

  const tokenizer = new Tokenizer(json as object, {})
  return (words) => {
    const ids: number[] = []
    const wordIds: (number | null)[] = []
    for (const slot of layout) {
      if (slot !== null) {
        ids.push(slot)
        wordIds.push(null)
        continue
      }
      words.forEach((word, index) => {
        for (const piece of splitAstralCjk(word)) {
          for (const id of tokenizer.encode(piece, {
            add_special_tokens: false,
          }).ids) {
            ids.push(id)
            wordIds.push(index)
          }
        }
      })
    }
    return { ids, wordIds }
  }
}

/**
 * The Rust BertNormalizer puts spaces around every CJK ideograph, so each becomes its own
 * pre-token. The JavaScript one checks UTF-16 units and so never sees the ideographs above
 * U+FFFF; cut those out of the word here instead, using the Rust ranges (which, unlike the
 * JavaScript table, leave U+2B820..U+2B91F alone).
 */
function splitAstralCjk(word: string): string[] {
  const pieces: string[] = []
  let current = ''
  for (const character of word) {
    if (isAstralCjk(character.codePointAt(0)!)) {
      if (current) pieces.push(current)
      pieces.push(character)
      current = ''
    } else {
      current += character
    }
  }
  if (current) pieces.push(current)
  return pieces
}

function isAstralCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b920 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  )
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`could not read ${path}: ${message(error)}`, {
      cause: error,
    })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
