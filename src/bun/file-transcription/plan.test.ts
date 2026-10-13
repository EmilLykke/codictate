import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL_ID, SPEECH_MODELS } from '../../shared/speech-models'
import type { TranscriptionFailureReason } from '../utils/whisper/engines/transcription'
import {
  engineFailureLine,
  fileTranscriptionRequest,
  oneLine,
  planFileTranscription,
  publicEngineName,
  resultLanguage,
  selectFileTranscription,
  selectSpeechModelAndLanguage,
} from './plan'

const PARAKEET = 'parakeet-tdt-0.6b-v3'
const HVISKE = 'hviske-v5-tiny-q5_0'
const EDDA = 'edda-v0.2-q5_0'
const LARGE_V3 = 'large-v3-q5_0'

const everythingInstalled = () => true
const locations = {
  getModelPath: (id: string) => `/models/${id}.bin`,
  getParakeetInstallDir: (id: string) => `/models/${id}-coreml`,
}

const TURBO = 'large-v3-turbo-q5_0'
const SMALL = 'small-q5_1'

function settings(
  speechModelId: string,
  transcriptionLanguageId = 'auto',
  translateToEnglish = false,
  translateDefaultLanguageId = 'auto'
) {
  return {
    getFileTranscriptionSettings: () => ({
      speechModelId,
      transcriptionLanguageId,
      translateToEnglish,
    }),
    getTranslateDefaultLanguageId: () => translateDefaultLanguageId,
  }
}

type Overrides = {
  speechModelId?: string | null
  languageId?: string | null
  translateToEnglish?: boolean | null
}

function planned(
  current: ReturnType<typeof settings>,
  overrides: Overrides = {}
) {
  const selected = selectFileTranscription(current, overrides)
  if (selected.status !== 'ok') throw new Error(selected.message)
  return planFileTranscription(selected.selection, everythingInstalled)
}

function runnable(
  current: ReturnType<typeof settings>,
  overrides: Overrides = {}
) {
  const selected = selectFileTranscription(current, overrides)
  if (selected.status !== 'ok') throw new Error(selected.message)
  const planned = planFileTranscription(selected.selection, everythingInstalled)
  if (planned.status !== 'runnable') throw new Error(planned.message)
  return planned.plan
}

describe('selectFileTranscription and planFileTranscription', () => {
  test('a Whisper selection runs on the default backend in the configured language', () => {
    expect(runnable(settings(LARGE_V3, 'fr'))).toMatchObject({
      mode: 'batch',
      speechModelId: LARGE_V3,
      engineId: 'whisper_cpp',
      crispasrBackend: null,
      transcriptionLanguageId: 'fr',
      languageCode: 'fr',
      translateToEnglish: false,
    })
  })

  test('a language override replaces the setting for this call, any case', () => {
    expect(
      runnable(settings(LARGE_V3, 'fr'), { languageId: 'auto' })
    ).toMatchObject({ transcriptionLanguageId: 'auto', languageCode: null })
    expect(runnable(settings(LARGE_V3), { languageId: ' DE ' })).toMatchObject({
      languageCode: 'de',
    })
  })

  test('a Speech Model override replaces the selection for this call', () => {
    expect(
      runnable(settings(LARGE_V3, 'fr'), { speechModelId: HVISKE })
    ).toMatchObject({ speechModelId: HVISKE, engineId: 'hviske' })
  })

  test('empty overrides mean the settings', () => {
    expect(
      runnable(settings(LARGE_V3, 'fr'), { speechModelId: '', languageId: '' })
    ).toMatchObject({ speechModelId: LARGE_V3, transcriptionLanguageId: 'fr' })
  })

  test('hviske pins Danish and the cohere backend, whatever was asked', () => {
    for (const languageId of [null, 'en', 'auto']) {
      expect(runnable(settings(HVISKE, 'en'), { languageId })).toMatchObject({
        engineId: 'hviske',
        crispasrBackend: 'cohere',
        transcriptionLanguageId: 'da',
        languageCode: 'da',
      })
    }
  })

  test('Edda pins Danish on the default backend', () => {
    expect(runnable(settings(EDDA), { languageId: 'en' })).toMatchObject({
      engineId: 'whisper_cpp',
      crispasrBackend: null,
      transcriptionLanguageId: 'da',
      languageCode: 'da',
    })
  })

  test('Parakeet detects the language itself, so a language is coerced to automatic', () => {
    expect(
      runnable(settings(PARAKEET, 'da'), { languageId: 'en' })
    ).toMatchObject({
      engineId: 'whisperkit',
      transcriptionLanguageId: 'auto',
      languageCode: null,
    })
  })

  test('an unknown Speech Model or language is refused, not substituted', () => {
    expect(
      selectFileTranscription(settings(DEFAULT_MODEL_ID), {
        speechModelId: 'large-v9',
      })
    ).toMatchObject({ status: 'failed', code: 'unknown_model' })
    expect(
      selectFileTranscription(settings(DEFAULT_MODEL_ID), {
        languageId: 'klingon',
      })
    ).toMatchObject({ status: 'failed', code: 'unknown_language' })
  })

  test('missing weights are model_not_installed, naming the Speech Model, and nothing substitutes', () => {
    const selected = selectFileTranscription(settings(HVISKE), {})
    if (selected.status !== 'ok') throw new Error('unexpected')
    const planned = planFileTranscription(
      selected.selection,
      (id) => id !== HVISKE
    )
    expect(planned).toMatchObject({
      status: 'failed',
      code: 'model_not_installed',
    })
    if (planned.status === 'failed') expect(planned.message).toContain(HVISKE)
  })
})

describe('Translate to English', () => {
  test('follows the File Transcription Settings when the request does not say', () => {
    expect(runnable(settings(SMALL, 'da', true))).toMatchObject({
      translateToEnglish: true,
      transcriptionLanguageId: 'da',
      languageCode: 'da',
    })
    for (const translateToEnglish of [null, undefined]) {
      expect(
        runnable(settings(SMALL, 'da', true), { translateToEnglish })
      ).toMatchObject({ translateToEnglish: true })
    }
    expect(runnable(settings(SMALL, 'da'))).toMatchObject({
      translateToEnglish: false,
    })
  })

  test('the request forces it on or off for this call', () => {
    expect(
      runnable(settings(SMALL, 'da'), { translateToEnglish: true })
    ).toMatchObject({ translateToEnglish: true })
    expect(
      runnable(settings(SMALL, 'da', true), { translateToEnglish: false })
    ).toMatchObject({ translateToEnglish: false })
  })

  test('the selection fixes the translate default when the job is queued', () => {
    const selected = selectFileTranscription(
      settings(SMALL, 'auto', true, 'de'),
      {}
    )
    expect(selected).toEqual({
      status: 'ok',
      selection: {
        speechModelId: SMALL,
        transcriptionLanguageId: 'auto',
        translateToEnglish: true,
        translateDefaultLanguageId: 'de',
      },
    })
  })

  test('from automatic detection, the translate default is the source language', () => {
    const plan = runnable(settings(SMALL, 'auto', true, 'de'))
    expect(plan).toMatchObject({
      translateToEnglish: true,
      transcriptionLanguageId: 'de',
      languageCode: 'de',
    })
    expect(resultLanguage(plan)).toBe('de')
  })

  test('a Speech Model that cannot translate is cannot_translate, naming it, and nothing substitutes', () => {
    for (const id of [TURBO, PARAKEET, HVISKE, EDDA]) {
      const result = planned(settings(id, 'da'), { translateToEnglish: true })
      expect(result).toMatchObject({
        status: 'failed',
        code: 'cannot_translate',
      })
      if (result.status === 'failed') {
        expect(result.message).toContain("can't translate to English")
      }
    }
    const turbo = planned(settings(TURBO, 'da', true))
    if (turbo.status !== 'failed') throw new Error('expected a refusal')
    expect(turbo.message).toBe(
      "Large V3 Turbo can't translate to English. Choose a Whisper Small or Large Speech Model, or turn off Translate to English."
    )
  })

  test('automatic detection with no translate default is cannot_translate', () => {
    expect(planned(settings(SMALL, 'auto', true, 'auto'))).toEqual({
      status: 'failed',
      code: 'cannot_translate',
      message:
        'Translate to English needs a Transcription Language. Choose one instead of Auto-detect.',
    })
  })

  test('missing weights come first: model_not_installed, not cannot_translate', () => {
    const selected = selectFileTranscription(settings(TURBO, 'da', true), {})
    if (selected.status !== 'ok') throw new Error('unexpected')
    expect(
      planFileTranscription(selected.selection, () => false)
    ).toMatchObject({ code: 'model_not_installed' })
  })
})

describe('selectSpeechModelAndLanguage', () => {
  test('puts the overrides on the defaults it is given, as a command-line Dictation needs', () => {
    const defaults = { speechModelId: LARGE_V3, transcriptionLanguageId: 'fr' }
    expect(selectSpeechModelAndLanguage(defaults, {})).toEqual({
      status: 'ok',
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'fr',
    })
    expect(
      selectSpeechModelAndLanguage(defaults, { speechModelId: PARAKEET })
    ).toEqual({
      status: 'ok',
      speechModelId: PARAKEET,
      transcriptionLanguageId: 'auto',
    })
    expect(
      selectSpeechModelAndLanguage(defaults, { languageId: 'nope' })
    ).toMatchObject({ status: 'failed', code: 'unknown_language' })
  })
})

describe('fileTranscriptionRequest', () => {
  test('carries the hviske backend, the Danish pin, the signal and low priority', () => {
    const signal = new AbortController().signal
    const plan = runnable(settings(HVISKE))
    expect(
      fileTranscriptionRequest(plan, '/tmp/a.wav', 200_000, locations, signal)
    ).toEqual({
      engineId: 'hviske',
      speechModelId: HVISKE,
      audioPath: '/tmp/a.wav',
      timeoutMs: 200_000,
      modelPath: `/models/${HVISKE}.bin`,
      languageCode: 'da',
      translateToEnglish: false,
      crispasrBackend: 'cohere',
      signal,
      lowPriority: true,
    })
  })

  test('a Parakeet request names the install directory and no language', () => {
    const plan = runnable(settings(PARAKEET))
    expect(
      fileTranscriptionRequest(plan, '/tmp/a.wav', 180_000, locations)
    ).toEqual({
      engineId: 'whisperkit',
      speechModelId: PARAKEET,
      audioPath: '/tmp/a.wav',
      timeoutMs: 180_000,
      modelDir: `/models/${PARAKEET}-coreml`,
      signal: undefined,
      lowPriority: true,
    })
  })
})

describe('result fields', () => {
  test('language is null when the engine detects it', () => {
    expect(resultLanguage(runnable(settings(PARAKEET)))).toBeNull()
    expect(resultLanguage(runnable(settings(LARGE_V3)))).toBeNull()
    expect(resultLanguage(runnable(settings(HVISKE)))).toBe('da')
  })

  test('every Speech Engine has a public name, and none leaks the internal id', () => {
    const names = new Set(SPEECH_MODELS.map((m) => publicEngineName(m.engine)))
    expect([...names].sort()).toEqual(['hviske', 'parakeet', 'whisper'])
  })
})

describe('messages', () => {
  test('an engine failure is one line naming the Speech Model and the engine’s words', () => {
    const reasons: TranscriptionFailureReason[] = [
      'engine_exited_nonzero',
      'engine_runtime_missing',
      'engine_timed_out',
      'parakeet_no_final_line',
      'engine_output_unreadable',
      'cancelled',
    ]
    for (const reason of reasons) {
      const line = engineFailureLine(
        reason,
        HVISKE,
        'exit 1:\nggml: failed\n  to load'
      )
      expect(line).not.toContain('\n')
      expect(line).toContain('Hviske V5 Tiny Q5')
      expect(line).toContain('(exit 1: ggml: failed to load)')
      expect(line).not.toContain('pasted')
    }
  })

  test('oneLine keeps the end of a long message', () => {
    expect(oneLine('a\n b', 10)).toBe('a b')
    expect(oneLine(`${'x'.repeat(20)}END`, 5)).toBe('...xxEND')
  })
})
