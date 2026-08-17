/**
 * Characterisation tests: they pin the translate resolution and the two readiness unions
 * exactly as they behave today, fallbacks included. They are the safety net for the
 * Dictation Plan work in docs/adr/0005-no-runtime-fallbacks-for-dictation.md, where the
 * hviske swap and the "first available translate-capable model" search are removed on
 * purpose. Tests that assert a fallback are expected to be rewritten by that change, not
 * preserved through it.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID,
  TRANSLATE_CAPABLE_MODEL_IDS,
  getStreamModeReadiness,
  getTranslateReadiness,
  hasAnyTranslateCapableModelAvailable,
  isStreamCapableModelId,
  isTranslateCapableModelId,
  resolveTranslateModelId,
} from './dictation-plan'
import { DEFAULT_STREAM_CAPABLE_MODEL_ID } from './speech-models'

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

describe('getTranslateReadiness', () => {
  test('needs a language when both the transcription and translate defaults are auto', () => {
    expect(
      getTranslateReadiness(
        TRANSLATE_CAPABLE,
        'auto',
        'auto',
        installed(TRANSLATE_CAPABLE)
      )
    ).toEqual({ kind: 'need_language' })
  })

  test('the language check wins over an unrunnable model', () => {
    expect(
      getTranslateReadiness(TRANSCRIBE_ONLY, 'auto', 'auto', installed())
    ).toEqual({ kind: 'need_language' })
  })

  test('is ready with an explicit transcription language', () => {
    expect(
      getTranslateReadiness(
        TRANSLATE_CAPABLE,
        'da',
        'auto',
        installed(TRANSLATE_CAPABLE)
      )
    ).toEqual({ kind: 'ready' })
  })

  test('is ready when only the translate default language is set', () => {
    expect(
      getTranslateReadiness(
        TRANSLATE_CAPABLE,
        'auto',
        'da',
        installed(TRANSLATE_CAPABLE)
      )
    ).toEqual({ kind: 'ready' })
  })

  test('needs a download when the translate-capable selection is missing', () => {
    expect(
      getTranslateReadiness(TRANSLATE_CAPABLE, 'da', 'auto', installed())
    ).toEqual({ kind: 'need_download' })
  })

  test('needs a model switch when a transcribe-only model is selected and another is installed', () => {
    expect(
      getTranslateReadiness(
        TRANSCRIBE_ONLY,
        'da',
        'auto',
        installed(TRANSCRIBE_ONLY, TRANSLATE_CAPABLE)
      )
    ).toEqual({ kind: 'need_switch_model' })
  })

  test('needs a download when a transcribe-only model is selected and nothing else is installed', () => {
    expect(
      getTranslateReadiness(
        TRANSCRIBE_ONLY,
        'da',
        'auto',
        installed(TRANSCRIBE_ONLY)
      )
    ).toEqual({ kind: 'need_download' })
  })

  // Current fallback semantics, removed by ADR-0005: the hviske swap makes this ready.
  test('is ready for an hviske selection when a translate-capable model is installed', () => {
    expect(
      getTranslateReadiness(
        HVISKE,
        'da',
        'auto',
        installed(HVISKE, TRANSLATE_CAPABLE)
      )
    ).toEqual({ kind: 'ready' })
  })

  test('needs a download for an hviske selection with nothing to swap to', () => {
    expect(
      getTranslateReadiness(HVISKE, 'da', 'auto', installed(HVISKE))
    ).toEqual({ kind: 'need_download' })
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

describe('getStreamModeReadiness', () => {
  test('needs the Parakeet download before anything else is considered', () => {
    expect(getStreamModeReadiness(PARAKEET, 'auto', installed(), true)).toEqual(
      { kind: 'need_parakeet_download' }
    )
  })

  test('needs a model switch when Parakeet is installed but not selected', () => {
    expect(
      getStreamModeReadiness(
        TRANSLATE_CAPABLE,
        'auto',
        installed(PARAKEET),
        true
      )
    ).toEqual({ kind: 'need_switch_model' })
  })

  test('needs a language Parakeet supports', () => {
    expect(
      getStreamModeReadiness(PARAKEET, 'ja', installed(PARAKEET), true)
    ).toEqual({ kind: 'need_language' })
  })

  test('needs warmup when Parakeet has not run on this device yet', () => {
    expect(
      getStreamModeReadiness(PARAKEET, 'auto', installed(PARAKEET), false)
    ).toEqual({ kind: 'need_warmup' })
  })

  test('is ready with Parakeet installed, selected, warm and on a supported language', () => {
    expect(
      getStreamModeReadiness(PARAKEET, 'da', installed(PARAKEET), true)
    ).toEqual({ kind: 'ready' })
  })
})
