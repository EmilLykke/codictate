import { expect, test } from 'bun:test'
import { runS1Formatter } from './s1-runner'

// Explicit opt-in: CODICTATE_S1_MODEL_PATH=/path/to/model bun test ./src/bun/utils/formatting/s1-inference.manual.ts
const modelPath = process.env.CODICTATE_S1_MODEL_PATH

for (const [transcript, expected] of [
  ['um', ''],
  ['lets meet at 6, no wait make that 8.', "Let's meet at 8."],
  ["let's meet at 6, no 8.", "Let's meet at 8."],
  ["So let me test let's meet at 6, no 8.", "So let me test. Let's meet at 8."],
  [
    'send it to support at superwhisper dot com',
    'Send it to support@superwhisper.com.',
  ],
  [
    'i think the answer is forty two no sorry forty three',
    'I think the answer is 43.',
  ],
] as const) {
  test.skipIf(!modelPath)(
    `S1-mini inference: ${transcript}`,
    async () => {
      const output = await runS1Formatter({
        transcript,
        modelPath: modelPath!,
        styling: 'semi-formal',
        structure: 'lists',
        context: 'general',
      })
      expect(output).toBe(expected)
    },
    180_000
  )
}
