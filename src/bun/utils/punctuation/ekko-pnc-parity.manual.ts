/**
 * The parity check: the Punctuation Restorer on the real ekko-pnc weights gives exactly what
 * the Python reference (`ekko-stt[pnc]==0.1.2`, onnxruntime 1.30.0) gives on the same text,
 * byte for byte, for every case in fixtures/ekko-pnc-parity.json.
 *
 * Needs the weights at the pinned upstream revision in a local folder (`pnc.int8.onnx`,
 * `tokenizer.json`, `tokenizer_config.json`, `config.json`):
 *
 *   CODICTATE_EKKO_PNC_MODEL_DIR=<folder> bun test ./src/bun/utils/punctuation/ekko-pnc-parity.manual.ts
 *
 * Regenerate the fixture with scripts/generate-pnc-parity-fixture.py.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import fixture from './fixtures/ekko-pnc-parity.json'
import { ekkoPncModelLoader } from './ekko-pnc-model'
import { pythonSplit } from './python-text'
import {
  createPunctuationRestorer,
  type PunctuationModel,
} from './punctuation-restorer'

const MODEL_DIR = process.env.CODICTATE_EKKO_PNC_MODEL_DIR

if (!MODEL_DIR) {
  throw new Error(
    'Set CODICTATE_EKKO_PNC_MODEL_DIR to a folder with the ekko-pnc weights'
  )
}

const loadModel = ekkoPncModelLoader(MODEL_DIR)
let model: PunctuationModel

beforeAll(async () => {
  const startedAt = performance.now()
  model = await loadModel()
  console.log(`ekko-pnc load: ${(performance.now() - startedAt).toFixed(0)} ms`)
})

describe('ekko-pnc parity with the Python reference', () => {
  test('the fixture covers about 1,000 words of Danish', () => {
    expect(fixture.passageWords).toBeGreaterThanOrEqual(950)
  })

  for (const parityCase of fixture.cases) {
    test(`tokenizes like Python: ${parityCase.name}`, () => {
      const encoding = model.encode(pythonSplit(parityCase.input))
      expect({ ids: encoding.ids, wordIds: encoding.wordIds }).toEqual({
        ids: parityCase.ids,
        wordIds: parityCase.wordIds,
      })
    })

    test(`punctuates like Python: ${parityCase.name}`, async () => {
      const restorer = createPunctuationRestorer({
        loadModel: async () => model,
        keepExistingPunctuation: true,
      })
      const result = await restorer.restore(parityCase.input)
      expect(result).toEqual({ text: parityCase.output, restored: true })
    })
  }

  test('per-sentence cost', async () => {
    const restorer = createPunctuationRestorer({
      loadModel: async () => model,
      keepExistingPunctuation: true,
    })
    const sentences = fixture.cases
      .filter((parityCase) => parityCase.name.startsWith('already punctuated'))
      .map((parityCase) => parityCase.input)
    const rounds = 50
    const startedAt = performance.now()
    for (let round = 0; round < rounds; round++) {
      for (const sentence of sentences) await restorer.restore(sentence)
    }
    const perSentence =
      (performance.now() - startedAt) / (rounds * sentences.length)
    console.log(`ekko-pnc per sentence: ${perSentence.toFixed(2)} ms`)
  })
})
