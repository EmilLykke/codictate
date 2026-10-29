import { describe, expect, test } from 'bun:test'
import { EKKO_ENGINE_ID } from '../../../../shared/speech-models'
import { runTranscription } from './run-transcription'

describe('runTranscription', () => {
  // A GGUF that is not there stops every adapter before it spawns, so this stays hermetic;
  // only the ekko adapter names the GGUF in its diagnostic.
  test('runs an ekko Request on the ekko adapter', async () => {
    const result = await runTranscription({
      engineId: EKKO_ENGINE_ID,
      speechModelId: 'ekko-v1-tiny-q5_0',
      audioPath: '/nonexistent/recording.wav',
      timeoutMs: 60_000,
      modelPath: '/nonexistent/ekko-v1-tiny-q5_0.gguf',
    })
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'engine_runtime_missing',
      diagnostic: 'ekko GGUF not on disk: /nonexistent/ekko-v1-tiny-q5_0.gguf',
    })
  })
})
