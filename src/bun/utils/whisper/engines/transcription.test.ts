import { describe, expect, it } from 'bun:test'
import {
  buildDictationPlan,
  type RunnableDictationPlan,
} from '../../../../shared/dictation-plan'
import { PARAKEET_ENGINE_ID } from '../../../../shared/speech-models'
import {
  failedTranscription,
  transcriptionRequestFromPlan,
  type SpeechModelLocations,
  type TranscriptionFailureReason,
} from './transcription'

/**
 * Fixed answers instead of `modelManager`, which is the point of the derivation taking a
 * locator: the plan-to-Request step is pure and testable without a models directory.
 */
const locations: SpeechModelLocations = {
  getModelPath: (id) => `/models/${id}.bin`,
  getParakeetInstallDir: (id) => `/models/${id}-coreml`,
}

/** A real plan rather than a hand-written literal, so a plan field change is caught here. */
function planFor(
  speechModelId: string,
  overrides: {
    transcriptionLanguageId?: string
    translateToEnglish?: boolean
    streamMode?: boolean
  } = {}
): RunnableDictationPlan {
  const plan = buildDictationPlan(
    {
      speechModelId,
      transcriptionLanguageId: overrides.transcriptionLanguageId ?? 'auto',
      translateDefaultLanguageId: 'auto',
      translateToEnglish: overrides.translateToEnglish ?? false,
      streamMode: overrides.streamMode ?? false,
    },
    { isModelAvailable: () => true, streamSupported: true }
  )
  if (plan.status !== 'runnable') {
    throw new Error(`expected a runnable plan, got ${plan.reason}`)
  }
  return plan
}

describe('transcriptionRequestFromPlan', () => {
  it('carries the plan across for a Whisper run without re-deriving anything', () => {
    const plan = planFor('large-v3-q5_0', { transcriptionLanguageId: 'danish' })

    expect(
      transcriptionRequestFromPlan(plan, '/tmp/capture.wav', locations)
    ).toEqual({
      engineId: 'whisper_cpp',
      speechModelId: 'large-v3-q5_0',
      audioPath: '/tmp/capture.wav',
      modelPath: '/models/large-v3-q5_0.bin',
      languageCode: plan.languageCode,
      translateToEnglish: false,
      crispasrBackend: null,
    })
  })

  it('keeps the translate flag and the source language the plan resolved', () => {
    const plan = planFor('large-v3-q5_0', {
      transcriptionLanguageId: 'spanish',
      translateToEnglish: true,
    })

    const request = transcriptionRequestFromPlan(plan, '/tmp/a.wav', locations)
    expect(request.engineId).not.toBe(PARAKEET_ENGINE_ID)
    if (request.engineId === PARAKEET_ENGINE_ID) return
    expect(request.translateToEnglish).toBe(true)
    expect(request.languageCode).toBe(plan.languageCode)
  })

  it('pins the cohere backend an hviske plan carries', () => {
    const plan = planFor('hviske-v5-tiny-q5_0')

    const request = transcriptionRequestFromPlan(plan, '/tmp/a.wav', locations)
    expect(request.engineId).toBe('hviske')
    if (request.engineId === PARAKEET_ENGINE_ID) return
    expect(request.crispasrBackend).toBe('cohere')
    expect(request.modelPath).toBe('/models/hviske-v5-tiny-q5_0.bin')
  })

  it('derives a Parakeet Request with an install directory and no language', () => {
    const plan = planFor('parakeet-tdt-0.6b-v3')

    expect(
      transcriptionRequestFromPlan(plan, '/tmp/capture.wav', locations)
    ).toEqual({
      engineId: PARAKEET_ENGINE_ID,
      speechModelId: 'parakeet-tdt-0.6b-v3',
      audioPath: '/tmp/capture.wav',
      modelDir: '/models/parakeet-tdt-0.6b-v3-coreml',
    })
  })

  it('takes the audio path as a parameter rather than a process-global', () => {
    const plan = planFor('large-v3-q5_0')

    expect(
      transcriptionRequestFromPlan(plan, '/samples/fleurs/0001.wav', locations)
        .audioPath
    ).toBe('/samples/fleurs/0001.wav')
  })
})

describe('failedTranscription', () => {
  const reasons: TranscriptionFailureReason[] = [
    'engine_exited_nonzero',
    'engine_runtime_missing',
    'parakeet_no_final_line',
    'engine_output_unreadable',
  ]

  it('writes a finished sentence for every reason', () => {
    for (const reason of reasons) {
      const failed = failedTranscription(reason, 'large-v3-q5_0')
      expect(failed.status).toBe('failed')
      expect(failed.reason).toBe(reason)
      expect(failed.message.length).toBeGreaterThan(0)
      expect(failed.message.endsWith('.')).toBe(true)
    }
  })

  it('names the Speech Model by its catalog label', () => {
    const failed = failedTranscription(
      'engine_exited_nonzero',
      'parakeet-tdt-0.6b-v3'
    )
    expect(failed.message).toContain('Parakeet')
  })

  it('falls back to the raw id for a Speech Model the catalog never heard of', () => {
    const failed = failedTranscription('engine_exited_nonzero', 'not-a-model')
    expect(failed.message).toContain('not-a-model')
  })

  it('does not promise the next press works, because nothing is healed', () => {
    for (const reason of reasons) {
      expect(
        failedTranscription(reason, 'large-v3-q5_0').message
      ).not.toContain('next press')
    }
  })

  it('gives every reason its own sentence', () => {
    const messages = reasons.map(
      (reason) => failedTranscription(reason, 'large-v3-q5_0').message
    )
    expect(new Set(messages).size).toBe(reasons.length)
  })

  it('carries a diagnostic when the engine gave one', () => {
    const failed = failedTranscription(
      'engine_exited_nonzero',
      'large-v3-q5_0',
      'exit 1: could not load model'
    )
    expect(failed.diagnostic).toBe('exit 1: could not load model')
  })

  it('omits the diagnostic rather than carrying an empty one', () => {
    expect(
      failedTranscription('engine_exited_nonzero', 'large-v3-q5_0').diagnostic
    ).toBeUndefined()
    expect(
      failedTranscription('engine_exited_nonzero', 'large-v3-q5_0', '   \n')
        .diagnostic
    ).toBeUndefined()
  })

  it('keeps the diagnostic out of the sentence the user reads', () => {
    const failed = failedTranscription(
      'engine_exited_nonzero',
      'large-v3-q5_0',
      'ggml_backend_metal_device_init: error'
    )
    expect(failed.message).not.toContain('ggml')
  })
})
