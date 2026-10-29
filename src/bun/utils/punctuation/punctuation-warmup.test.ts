import { describe, expect, test } from 'bun:test'
import type {
  DictationAvailability,
  DictationPlanInput,
} from '../../../shared/dictation-plan'
import { DEFAULT_STREAM_CAPABLE_MODEL_ID } from '../../../shared/speech-models'
import {
  createPunctuationWarmup,
  isPunctuationRestorationReachable,
} from './punctuation-warmup'

const HVISKE = 'hviske-v5-tiny-q5_0'
const EDDA = 'edda-v0.2-q5_0'
const PARAKEET = DEFAULT_STREAM_CAPABLE_MODEL_ID

const INSTALLED: DictationAvailability = {
  isModelAvailable: () => true,
  streamSupported: true,
  punctuationModelInstalled: true,
}

const selection = (
  speechModelId: string,
  overrides: Partial<DictationPlanInput> = {}
): DictationPlanInput => ({
  speechModelId,
  transcriptionLanguageId: 'auto',
  translateDefaultLanguageId: 'auto',
  translateToEnglish: false,
  streamMode: false,
  addPunctuation: true,
  ...overrides,
})

describe('isPunctuationRestorationReachable', () => {
  test('an hviske Dictation with Add punctuation on reaches it', () => {
    expect(
      isPunctuationRestorationReachable([selection(HVISKE)], INSTALLED)
    ).toBe(true)
  })

  test('an hviske File Transcription selection reaches it while Dictation uses another Speech Model', () => {
    expect(
      isPunctuationRestorationReachable(
        [selection(PARAKEET, { streamMode: true }), selection(HVISKE)],
        INSTALLED
      )
    ).toBe(true)
  })

  test('Add punctuation off reaches nothing', () => {
    expect(
      isPunctuationRestorationReachable(
        [selection(HVISKE, { addPunctuation: false })],
        INSTALLED
      )
    ).toBe(false)
  })

  test('Edda and every other Speech Model ignore Add punctuation', () => {
    expect(
      isPunctuationRestorationReachable(
        [selection(EDDA), selection(PARAKEET), selection('small-q5_1')],
        INSTALLED
      )
    ).toBe(false)
  })

  test('nothing is reachable without the Punctuation Model: the plan is blocked', () => {
    expect(
      isPunctuationRestorationReachable([selection(HVISKE)], {
        ...INSTALLED,
        punctuationModelInstalled: false,
      })
    ).toBe(false)
  })
})

describe('createPunctuationWarmup', () => {
  function counting() {
    let warmUps = 0
    return {
      restorer: {
        warmUp: async () => {
          warmUps += 1
        },
      },
      count: () => warmUps,
    }
  }

  test('loads the Punctuation Model when restoration is reachable', () => {
    const fake = counting()
    const ensureWarm = createPunctuationWarmup({
      restorer: fake.restorer,
      isReachable: () => true,
    })
    ensureWarm()
    expect(fake.count()).toBe(1)
  })

  test('loads nothing while restoration is unreachable', () => {
    const fake = counting()
    let reachable = false
    const ensureWarm = createPunctuationWarmup({
      restorer: fake.restorer,
      isReachable: () => reachable,
    })
    ensureWarm()
    expect(fake.count()).toBe(0)
    reachable = true
    ensureWarm()
    expect(fake.count()).toBe(1)
  })

  test('a reachability check that throws loads nothing and does not throw', () => {
    const fake = counting()
    const ensureWarm = createPunctuationWarmup({
      restorer: fake.restorer,
      isReachable: () => {
        throw new Error('disk gone')
      },
      log: () => {},
    })
    expect(() => ensureWarm()).not.toThrow()
    expect(fake.count()).toBe(0)
  })
})
