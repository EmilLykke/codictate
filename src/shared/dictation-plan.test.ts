/**
 * Two halves.
 *
 * `resolveTranslateModelId` is still pinned as characterisation, fallbacks included: the
 * hviske swap and the "first available translate-capable model" search are removed by
 * ADR-0005 and those tests are expected to be rewritten by that change, not preserved
 * through it.
 *
 * `getDictationReadiness` is the new half, and it is specification rather than
 * characterisation: it is the one answer to "can this run right now", shipped to the
 * webview in the settings payload. Every reason in both closed unions is exercised, and
 * every one has to carry its own sentence, because the sentence is the whole point of
 * computing this in the main process.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID,
  TRANSLATE_CAPABLE_MODEL_IDS,
  getDictationReadiness,
  hasAnyTranslateCapableModelAvailable,
  isStreamCapableModelId,
  isTranslateCapableModelId,
  resolveTranslateModelId,
  type DictationAvailability,
  type DictationReadinessInput,
  type StreamModeReadinessReason,
  type TranslateReadinessReason,
} from './dictation-plan'
import {
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  getSpeechModel,
} from './speech-models'

/** Model ids used below, named so the intent survives a catalog edit. */
const TRANSLATE_CAPABLE = 'small-q5_1'
const TRANSLATE_CAPABLE_LATER_IN_CATALOG = 'large-v3-q5_0'
const TRANSCRIBE_ONLY = 'large-v3-turbo-q5_0'
const ENGLISH_ONLY = 'small.en-q5_1'
const HVISKE = 'hviske-v5-tiny-f16'
const PARAKEET = DEFAULT_STREAM_CAPABLE_MODEL_ID

const installed =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

/** An availability snapshot listing the downloaded Speech Models; bundled weights always count. */
const available = (...ids: string[]): DictationAvailability => ({
  isModelAvailable: (id) =>
    ids.includes(id) || (getSpeechModel(id)?.bundled ?? false),
  streamSupported: true,
})

const input = (
  overrides: Partial<DictationReadinessInput> = {}
): DictationReadinessInput => ({
  speechModelId: TRANSCRIBE_ONLY,
  transcriptionLanguageId: 'auto',
  translateDefaultLanguageId: 'auto',
  parakeetCoreMlReady: false,
  ...overrides,
})

const translate = (i: DictationReadinessInput, a: DictationAvailability) =>
  getDictationReadiness(i, a).translateToEnglish

const live = (i: DictationReadinessInput, a: DictationAvailability) =>
  getDictationReadiness(i, a).liveTranscription

describe('TRANSLATE_CAPABLE_MODEL_IDS', () => {
  test('holds only multilingual whisper.cpp models, in catalog order', () => {
    expect(TRANSLATE_CAPABLE_MODEL_IDS).toContain(TRANSLATE_CAPABLE)
    expect(TRANSLATE_CAPABLE_MODEL_IDS).toContain(
      TRANSLATE_CAPABLE_LATER_IN_CATALOG
    )
    expect(TRANSLATE_CAPABLE_MODEL_IDS).not.toContain(TRANSCRIBE_ONLY)
    expect(TRANSLATE_CAPABLE_MODEL_IDS).not.toContain(ENGLISH_ONLY)
    expect(TRANSLATE_CAPABLE_MODEL_IDS).not.toContain(HVISKE)
    expect(TRANSLATE_CAPABLE_MODEL_IDS).not.toContain(PARAKEET)
    expect(TRANSLATE_CAPABLE_MODEL_IDS.indexOf(TRANSLATE_CAPABLE)).toBeLessThan(
      TRANSLATE_CAPABLE_MODEL_IDS.indexOf(TRANSLATE_CAPABLE_LATER_IN_CATALOG)
    )
  })

  test('the default translate download target is itself translate-capable', () => {
    expect(TRANSLATE_CAPABLE_MODEL_IDS).toContain(
      DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID
    )
  })
})

describe('isTranslateCapableModelId', () => {
  test('is true only for multilingual whisper.cpp models', () => {
    expect(isTranslateCapableModelId(TRANSLATE_CAPABLE)).toBe(true)
    expect(isTranslateCapableModelId(TRANSCRIBE_ONLY)).toBe(false)
    expect(isTranslateCapableModelId(ENGLISH_ONLY)).toBe(false)
    expect(isTranslateCapableModelId(HVISKE)).toBe(false)
    expect(isTranslateCapableModelId(PARAKEET)).toBe(false)
    expect(isTranslateCapableModelId('not-a-model')).toBe(false)
  })
})

describe('resolveTranslateModelId', () => {
  test('keeps the selection when it is translate-capable and installed', () => {
    expect(
      resolveTranslateModelId(TRANSLATE_CAPABLE, installed(TRANSLATE_CAPABLE))
    ).toBe(TRANSLATE_CAPABLE)
  })

  test('is null when the translate-capable selection is not installed', () => {
    expect(resolveTranslateModelId(TRANSLATE_CAPABLE, installed())).toBeNull()
  })

  test('is null for a transcribe-only selection even when it is installed', () => {
    expect(
      resolveTranslateModelId(TRANSCRIBE_ONLY, installed(TRANSCRIBE_ONLY))
    ).toBeNull()
  })

  test('is null for an unknown model id', () => {
    expect(resolveTranslateModelId('not-a-model', () => true)).toBeNull()
  })

  // Current fallback semantics, removed by ADR-0005 once the settings can no longer
  // reach an hviske-plus-translate state.
  test('swaps an hviske selection for the first installed translate-capable model', () => {
    expect(
      resolveTranslateModelId(
        HVISKE,
        installed(HVISKE, TRANSLATE_CAPABLE_LATER_IN_CATALOG)
      )
    ).toBe(TRANSLATE_CAPABLE_LATER_IN_CATALOG)
  })

  test('the hviske swap follows catalog order, not availability order', () => {
    expect(
      resolveTranslateModelId(
        HVISKE,
        installed(TRANSLATE_CAPABLE_LATER_IN_CATALOG, TRANSLATE_CAPABLE)
      )
    ).toBe(TRANSLATE_CAPABLE)
  })

  test('is null for an hviske selection with nothing to swap to', () => {
    expect(resolveTranslateModelId(HVISKE, installed(HVISKE))).toBeNull()
  })
})

describe('hasAnyTranslateCapableModelAvailable', () => {
  test('is true when at least one translate-capable model is installed', () => {
    expect(
      hasAnyTranslateCapableModelAvailable(installed(TRANSLATE_CAPABLE))
    ).toBe(true)
  })

  test('is false when only transcribe-only models are installed', () => {
    expect(
      hasAnyTranslateCapableModelAvailable(
        installed(TRANSCRIBE_ONLY, ENGLISH_ONLY, HVISKE, PARAKEET)
      )
    ).toBe(false)
  })
})

describe('isStreamCapableModelId', () => {
  test('is true only for Parakeet', () => {
    expect(isStreamCapableModelId(PARAKEET)).toBe(true)
    expect(isStreamCapableModelId(TRANSLATE_CAPABLE)).toBe(false)
    expect(isStreamCapableModelId(HVISKE)).toBe(false)
    expect(isStreamCapableModelId('not-a-model')).toBe(false)
  })
})

describe('getDictationReadiness - Translate to English', () => {
  test('is ready with an explicit transcription language', () => {
    const readiness = translate(
      input({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
      }),
      available(TRANSLATE_CAPABLE)
    )
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toBeNull()
    expect(readiness.downloadModelId).toBeNull()
  })

  test('is ready when only the translate default language is set', () => {
    expect(
      translate(
        input({
          speechModelId: TRANSLATE_CAPABLE,
          translateDefaultLanguageId: 'da',
        }),
        available(TRANSLATE_CAPABLE)
      ).ready
    ).toBe(true)
  })

  /**
   * The lie #47 exists to stop telling. `resolveTranslateModelId` still swaps hviske for
   * an installed Whisper model and would call this runnable; readiness refuses to, so the
   * toggle is disabled with a reason instead of appearing to work on weights the user
   * never chose.
   */
  test('is unavailable under an hviske selection even with a Whisper model installed', () => {
    const readiness = translate(
      input({ speechModelId: HVISKE, transcriptionLanguageId: 'da' }),
      available(HVISKE, TRANSLATE_CAPABLE)
    )
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('hviske_selected')
    expect(readiness.downloadModelId).toBeNull()
  })

  test('offers no download under an hviske selection with nothing else installed', () => {
    const readiness = translate(
      input({ speechModelId: HVISKE, transcriptionLanguageId: 'da' }),
      available(HVISKE)
    )
    expect(readiness.reason).toBe('hviske_selected')
    expect(readiness.downloadModelId).toBeNull()
  })

  test('asks for a model switch when a transcribe-only model is selected and another is installed', () => {
    const readiness = translate(
      input({ speechModelId: TRANSCRIBE_ONLY, transcriptionLanguageId: 'da' }),
      available(TRANSCRIBE_ONLY, TRANSLATE_CAPABLE)
    )
    expect(readiness.reason).toBe('model_cannot_translate')
    expect(readiness.downloadModelId).toBeNull()
  })

  test('offers a download when nothing installed can translate', () => {
    const readiness = translate(
      input({ speechModelId: TRANSCRIBE_ONLY, transcriptionLanguageId: 'da' }),
      available(TRANSCRIBE_ONLY)
    )
    expect(readiness.reason).toBe('model_cannot_translate')
    expect(readiness.downloadModelId).toBe(DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID)
  })

  test('is unavailable for an English-only selection', () => {
    expect(
      translate(
        input({ speechModelId: ENGLISH_ONLY, transcriptionLanguageId: 'da' }),
        available(ENGLISH_ONLY)
      ).reason
    ).toBe('model_cannot_translate')
  })

  test('offers the selection itself when its weights are missing', () => {
    const readiness = translate(
      input({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
      }),
      available()
    )
    expect(readiness.reason).toBe('model_not_installed')
    expect(readiness.downloadModelId).toBe(TRANSLATE_CAPABLE)
  })

  test('needs a source language when both language settings are auto', () => {
    const readiness = translate(
      input({ speechModelId: TRANSLATE_CAPABLE }),
      available(TRANSLATE_CAPABLE)
    )
    expect(readiness.reason).toBe('needs_source_language')
    expect(readiness.downloadModelId).toBeNull()
  })

  /** The Speech Model question comes first: no source language rescues weights that cannot translate. */
  test('an unrunnable model outranks the language question', () => {
    expect(
      translate(input({ speechModelId: TRANSCRIBE_ONLY }), available()).reason
    ).toBe('model_cannot_translate')
  })

  test('is unavailable for an unknown Speech Model id', () => {
    expect(
      translate(
        input({ speechModelId: 'not-a-model', transcriptionLanguageId: 'da' }),
        available('not-a-model')
      ).ready
    ).toBe(false)
  })
})

describe('getDictationReadiness - Live Transcription', () => {
  test('is ready with Parakeet installed, selected, warm and on a supported language', () => {
    const readiness = live(
      input({
        speechModelId: PARAKEET,
        transcriptionLanguageId: 'da',
        parakeetCoreMlReady: true,
      }),
      available(PARAKEET)
    )
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toBeNull()
  })

  /**
   * Warmup is not a readiness reason. A cold Parakeet is slow on its first run, not
   * unavailable, so the toggle stays live and the copy says so (ADR-0005; #49 removes the
   * wait itself by warming automatically).
   */
  test('is ready while Parakeet is still cold, and says the first run is slow', () => {
    const readiness = live(
      input({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
      available(PARAKEET)
    )
    expect(readiness.ready).toBe(true)
    expect(readiness.message).toContain('first run')
  })

  test('the platform question comes before everything else', () => {
    const readiness = live(
      input({ speechModelId: PARAKEET, parakeetCoreMlReady: true }),
      { isModelAvailable: () => false, streamSupported: false }
    )
    expect(readiness.reason).toBe('unsupported_platform')
    expect(readiness.downloadModelId).toBeNull()
  })

  test('offers the Parakeet download when its weights are missing', () => {
    const readiness = live(input({ speechModelId: PARAKEET }), available())
    expect(readiness.reason).toBe('parakeet_not_installed')
    expect(readiness.downloadModelId).toBe(PARAKEET)
  })

  test('asks for a model switch when Parakeet is installed but not selected', () => {
    const readiness = live(
      input({ speechModelId: TRANSLATE_CAPABLE }),
      available(PARAKEET, TRANSLATE_CAPABLE)
    )
    expect(readiness.reason).toBe('model_cannot_stream')
    expect(readiness.downloadModelId).toBeNull()
  })

  test('refuses a transcription language Parakeet cannot handle', () => {
    expect(
      live(
        input({
          speechModelId: PARAKEET,
          transcriptionLanguageId: 'ja',
          parakeetCoreMlReady: true,
        }),
        available(PARAKEET)
      ).reason
    ).toBe('language_not_supported')
  })
})

describe('getDictationReadiness - the copy', () => {
  test('every reason carries its own sentence, and no two reasons share one', () => {
    const translateCases: [DictationReadinessInput, DictationAvailability][] = [
      [
        input({ speechModelId: HVISKE, transcriptionLanguageId: 'da' }),
        available(HVISKE),
      ],
      [
        input({
          speechModelId: TRANSCRIBE_ONLY,
          transcriptionLanguageId: 'da',
        }),
        available(TRANSCRIBE_ONLY),
      ],
      [
        input({
          speechModelId: TRANSLATE_CAPABLE,
          transcriptionLanguageId: 'da',
        }),
        available(),
      ],
      [
        input({ speechModelId: TRANSLATE_CAPABLE }),
        available(TRANSLATE_CAPABLE),
      ],
    ]
    const liveCases: [DictationReadinessInput, DictationAvailability][] = [
      [
        input({ speechModelId: PARAKEET }),
        { isModelAvailable: () => true, streamSupported: false },
      ],
      [input({ speechModelId: PARAKEET }), available()],
      [input({ speechModelId: TRANSLATE_CAPABLE }), available(PARAKEET)],
      [
        input({ speechModelId: PARAKEET, transcriptionLanguageId: 'ja' }),
        available(PARAKEET),
      ],
    ]

    const translateMessages = new Map<TranslateReadinessReason, string>()
    for (const [i, a] of translateCases) {
      const readiness = translate(i, a)
      if (readiness.ready) throw new Error('case is unexpectedly ready')
      translateMessages.set(readiness.reason, readiness.message)
    }
    const liveMessages = new Map<StreamModeReadinessReason, string>()
    for (const [i, a] of liveCases) {
      const readiness = live(i, a)
      if (readiness.ready) throw new Error('case is unexpectedly ready')
      liveMessages.set(readiness.reason, readiness.message)
    }

    expect([...translateMessages.keys()].sort()).toEqual([
      'hviske_selected',
      'model_cannot_translate',
      'model_not_installed',
      'needs_source_language',
    ])
    expect([...liveMessages.keys()].sort()).toEqual([
      'language_not_supported',
      'model_cannot_stream',
      'parakeet_not_installed',
      'unsupported_platform',
    ])
    const all = [...translateMessages.values(), ...liveMessages.values()]
    expect(new Set(all).size).toBe(all.length)
    for (const message of all) {
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('undefined')
    }
  })

  test('the download offer is a real Speech Model id', () => {
    const offered = translate(
      input({ speechModelId: TRANSCRIBE_ONLY, transcriptionLanguageId: 'da' }),
      available(TRANSCRIBE_ONLY)
    ).downloadModelId
    expect(getSpeechModel(offered ?? '')).toBeDefined()
  })

  test('carries no functions, so it survives the RPC bridge', () => {
    const readiness = getDictationReadiness(
      input({ speechModelId: TRANSCRIBE_ONLY }),
      available()
    )
    expect(JSON.parse(JSON.stringify(readiness))).toEqual(readiness)
  })
})
