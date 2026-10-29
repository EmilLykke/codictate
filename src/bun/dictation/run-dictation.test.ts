/**
 * One Batch Dictation through `runDictation`, with a fake Speech Engine, a fake Punctuation
 * Restorer and a fake Formatting Mode, each of which leaves a mark or records what it was
 * handed. The brand table and the Dictionary are the real ones: they are pure.
 *
 * The order under test is ADR-0006's: engine -> Punctuation Restoration (when the plan says
 * so) -> brand table -> Dictionary -> Formatting Mode.
 */

import { describe, expect, test } from 'bun:test'
import type { RunnableDictationPlan } from '../../shared/dictation-plan'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../shared/types'
import type { TranscriptionResult } from '../utils/whisper/engines/transcription'
import {
  runDictation,
  type DictationRunDependencies,
  type DictationRunRequest,
} from './run-dictation'

const HVISKE_PLAN: RunnableDictationPlan = {
  status: 'runnable',
  mode: 'batch',
  speechModelId: 'hviske-v5-tiny-q5_0',
  engineId: 'hviske',
  crispasrBackend: 'cohere',
  transcriptionLanguageId: 'da',
  languageCode: 'da',
  translateToEnglish: false,
  punctuationRestoration: true,
}

/** Only the fake Formatting Mode reads these, and it ignores them. */
const FORMATTING_SETTINGS = {} as FormattingRuntimeSettings

const FEDT_TO_SUPER: DictionaryEntry = {
  kind: 'replacement',
  from: 'fedt',
  text: 'super',
  source: 'manual',
}

interface Recorded {
  restorerSaw: string[]
  formatterSaw: string[]
}

function fakes(
  engineText: string,
  overrides: Partial<DictationRunDependencies> = {}
): { deps: DictationRunDependencies; recorded: Recorded } {
  const recorded: Recorded = { restorerSaw: [], formatterSaw: [] }
  const deps: DictationRunDependencies = {
    runEngine: async (): Promise<TranscriptionResult> => ({
      status: 'ok',
      rawTranscript: engineText,
    }),
    punctuationRestorer: {
      async restore(text) {
        recorded.restorerSaw.push(text)
        return { text: `${text}.`, restored: true }
      },
    },
    formatTranscript: async (transcript) => {
      recorded.formatterSaw.push(transcript)
      return { output: `<formatted>${transcript}</formatted>`, modeId: 'email' }
    },
    ...overrides,
  }
  return { deps, recorded }
}

function request(
  overrides: Partial<DictationRunRequest> = {}
): DictationRunRequest {
  return {
    plan: HVISKE_PLAN,
    audioPath: '/nowhere.wav',
    durationMs: 1200,
    formattingSettings: FORMATTING_SETTINGS,
    dictionaryEntries: [FEDT_TO_SUPER],
    ...overrides,
  }
}

describe('runDictation - Punctuation Restoration in the pipeline', () => {
  test('runs between the engine and the brand table, Dictionary and Formatting Mode', async () => {
    const { deps, recorded } = fakes('code dictate er fedt')
    const result = await runDictation(request(), deps)
    if (result.status !== 'ok') throw new Error('expected an Outcome')

    // Nothing rewrote the Raw Transcript before Punctuation Restoration saw it.
    expect(recorded.restorerSaw).toEqual(['code dictate er fedt'])
    // The brand table and the Dictionary ran on the punctuated text, and the Formatting
    // Mode was handed the result.
    expect(recorded.formatterSaw).toEqual(['Codictate er super.'])
    expect(result.raw).toBe('Codictate er super.')
    expect(result.output).toBe('<formatted>Codictate er super.</formatted>')
    expect(result.punctuationRestored).toBe(true)
  })

  test('keeps the Raw Transcript as the engine wrote it', async () => {
    const { deps } = fakes('code dictate er fedt')
    const result = await runDictation(request(), deps)
    if (result.status !== 'ok') throw new Error('expected an Outcome')
    expect(result.rawTranscript).toBe('code dictate er fedt')
  })

  test('runs with no Formatting Mode, and the pasted text is punctuated', async () => {
    const { deps } = fakes('hej med dig', {
      formatTranscript: async () => null,
    })
    const result = await runDictation(request({ dictionaryEntries: [] }), deps)
    if (result.status !== 'ok') throw new Error('expected an Outcome')
    expect(result.raw).toBe('hej med dig.')
    expect(result.output).toBe('hej med dig.')
    expect(result.formattingUsed).toBe(false)
    expect(result.punctuationRestored).toBe(true)
  })

  test('does not run when the plan does not ask for it', async () => {
    const { deps, recorded } = fakes('hej med dig', {
      formatTranscript: async () => null,
    })
    const result = await runDictation(
      request({
        plan: { ...HVISKE_PLAN, punctuationRestoration: false },
        dictionaryEntries: [],
      }),
      deps
    )
    if (result.status !== 'ok') throw new Error('expected an Outcome')
    expect(recorded.restorerSaw).toEqual([])
    expect(result.output).toBe('hej med dig')
    expect(result.punctuationRestored).toBe(false)
  })

  test('a raw request returns the engine output, unpunctuated', async () => {
    const { deps, recorded } = fakes('code dictate er fedt')
    const result = await runDictation(request({ raw: true }), deps)
    if (result.status !== 'ok') throw new Error('expected an Outcome')
    expect(recorded.restorerSaw).toEqual([])
    expect(result.raw).toBe('code dictate er fedt')
    expect(result.output).toBe('code dictate er fedt')
    expect(result.punctuationRestored).toBe(false)
  })

  test('a failed restorer still gives an Outcome with the words, unpunctuated', async () => {
    const { deps, recorded } = fakes('code dictate er fedt', {
      punctuationRestorer: {
        restore: async (text) => ({ text, restored: false }),
      },
    })
    const result = await runDictation(request(), deps)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.punctuationRestored).toBe(false)
    expect(result.raw).toBe('Codictate er super')
    expect(recorded.formatterSaw).toEqual(['Codictate er super'])
  })

  test('an empty transcript is not punctuated', async () => {
    const { deps, recorded } = fakes('  ')
    const result = await runDictation(request(), deps)
    if (result.status !== 'ok') throw new Error('expected an Outcome')
    expect(recorded.restorerSaw).toEqual([])
    expect(result.output).toBe('')
    expect(result.punctuationRestored).toBe(false)
  })

  test('an engine failure comes back as it was, and nothing runs after it', async () => {
    const { deps, recorded } = fakes('', {
      runEngine: async () => ({
        status: 'failed',
        reason: 'engine_exited_nonzero',
        message: 'The engine stopped.',
      }),
    })
    const result = await runDictation(request(), deps)
    expect(result).toEqual({
      status: 'failed',
      reason: 'engine_exited_nonzero',
      message: 'The engine stopped.',
    })
    expect(recorded.restorerSaw).toEqual([])
    expect(recorded.formatterSaw).toEqual([])
  })
})
