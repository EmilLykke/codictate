/**
 * Two halves, one rule.
 *
 * `buildDictationPlan` is the run decision: which Speech Model, Speech Engine, crispasr
 * backend and Transcription Language a press of the Dictation Shortcut produces, or the
 * closed reason it produces nothing. `getDictationReadiness` is the same rule in the
 * present tense, shipped to the webview in the settings payload so an option can be
 * disabled with a sentence before anyone presses anything.
 *
 * Both are pure functions of `(settings, availability snapshot)`, which is the whole reason
 * this file needs no subprocess, no filesystem and no platform. The last describe block
 * pins the two against each other, because two functions expressing one rule is exactly the
 * shape that drifts.
 *
 * The `resolveTranslateModelId` characterisation tests that used to live here are gone with
 * the function: ADR-0005 deletes the hviske swap and the "first available translate-capable
 * model" search, and the plan tests below assert the blocked outcome that replaced them.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID,
  TRANSLATE_CAPABLE_MODEL_IDS,
  blockedDictationPlan,
  buildDictationPlan,
  getDictationReadiness,
  hasAnyTranslateCapableModelAvailable,
  isStreamCapableModelId,
  isTranslateCapableModelId,
  type DictationAvailability,
  type DictationBlockedReason,
  type DictationPlanInput,
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

const planInput = (
  overrides: Partial<DictationPlanInput> = {}
): DictationPlanInput => ({
  speechModelId: TRANSCRIBE_ONLY,
  transcriptionLanguageId: 'auto',
  translateDefaultLanguageId: 'auto',
  translateToEnglish: false,
  streamMode: false,
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
   * The lie #47 stopped telling. Translate to English under an hviske selection used to
   * appear to work by loading an installed Whisper model instead, so the toggle is disabled
   * with a reason rather than producing a transcript from weights the user never chose.
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
   * Warmup is not a readiness reason. A cold Parakeet is being prepared right now - selecting
   * it starts the preparation - so the toggle stays live and the copy states the fact rather
   * than asking the user to do anything about it.
   */
  test('is ready while Parakeet is still cold, and says it is preparing', () => {
    const readiness = live(
      input({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
      available(PARAKEET)
    )
    expect(readiness.ready).toBe(true)
    expect(readiness.message).toContain('preparing')
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

describe('getDictationReadiness - parakeetPreparing', () => {
  const preparing = (i: DictationReadinessInput, a: DictationAvailability) =>
    getDictationReadiness(i, a).parakeetPreparing

  test('true when Parakeet is selected and installed but not yet prepared', () => {
    expect(
      preparing(
        input({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
        available(PARAKEET)
      )
    ).toBe(true)
  })

  test('false once the preparation reports done, so the line clears itself', () => {
    expect(
      preparing(
        input({ speechModelId: PARAKEET, parakeetCoreMlReady: true }),
        available(PARAKEET)
      )
    ).toBe(false)
  })

  test('false when Parakeet is not the selection, however cold it is', () => {
    expect(
      preparing(
        input({ speechModelId: TRANSCRIBE_ONLY, parakeetCoreMlReady: false }),
        available(PARAKEET, TRANSCRIBE_ONLY)
      )
    ).toBe(false)
  })

  test('false before the weights are on disk: nothing can be preparing yet', () => {
    expect(
      preparing(
        input({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
        available()
      )
    ).toBe(false)
  })

  test('does not make Live Transcription unavailable - a Dictation waits for it', () => {
    const readiness = getDictationReadiness(
      input({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
      available(PARAKEET)
    )
    expect(readiness.parakeetPreparing).toBe(true)
    expect(readiness.liveTranscription.ready).toBe(true)
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

/**
 * The Dictation Plan: the whole run decision as one value.
 *
 * These are the tests ADR-0005 names as the reason the builder is a pure function - no
 * subprocess, no filesystem, no `modelManager`, no platform probe. Everything the builder
 * needs arrives in `(settings, availability)`, so a run that can only happen on a Mac with
 * Parakeet installed is still an ordinary assertion here.
 */
describe('buildDictationPlan - batch Dictation', () => {
  test('runs the selected Speech Model, with no substitution', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: TRANSLATE_CAPABLE }),
      available(TRANSLATE_CAPABLE)
    )
    expect(plan.status).toBe('runnable')
    if (plan.status !== 'runnable') return
    expect(plan.mode).toBe('batch')
    expect(plan.speechModelId).toBe(TRANSLATE_CAPABLE)
    expect(plan.engineId).toBe('whisper_cpp')
    expect(plan.crispasrBackend).toBeNull()
    expect(plan.translateToEnglish).toBe(false)
  })

  test('carries the Transcription Language the run actually uses', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
      }),
      available(TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.transcriptionLanguageId).toBe('da')
    expect(plan.languageCode).toBe('da')
  })

  test('automatic detection carries a null language code, not the string auto', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: TRANSCRIBE_ONLY }),
      available(TRANSCRIBE_ONLY)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.transcriptionLanguageId).toBe('auto')
    expect(plan.languageCode).toBeNull()
  })

  test('an hviske run pins the cohere backend and Danish', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: HVISKE, transcriptionLanguageId: 'auto' }),
      available(HVISKE)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.engineId).toBe('hviske')
    expect(plan.crispasrBackend).toBe('cohere')
    expect(plan.transcriptionLanguageId).toBe('da')
    expect(plan.languageCode).toBe('da')
  })

  test('a Parakeet batch run carries no language: the engine detects it', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: PARAKEET }),
      available(PARAKEET)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.engineId).toBe('whisperkit')
    expect(plan.languageCode).toBeNull()
    expect(plan.crispasrBackend).toBeNull()
  })
})

describe('buildDictationPlan - Translate to English', () => {
  test('runs translate on a translate-capable, installed selection', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      available(TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.translateToEnglish).toBe(true)
    expect(plan.speechModelId).toBe(TRANSLATE_CAPABLE)
    expect(plan.languageCode).toBe('da')
  })

  test('translate from auto uses the translate default as the source language', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: TRANSLATE_CAPABLE,
        translateDefaultLanguageId: 'da',
        translateToEnglish: true,
      }),
      available(TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.transcriptionLanguageId).toBe('da')
    expect(plan.languageCode).toBe('da')
  })

  /**
   * The deleted swap. An hviske selection used to resolve to whatever translate-capable
   * Whisper Speech Model happened to be installed, which produced a transcript from weights
   * the user never chose. It is blocked now, and the Speech Model never changes.
   */
  test('blocks rather than swapping the Speech Model under an hviske selection', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: HVISKE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      available(HVISKE, TRANSLATE_CAPABLE)
    )
    expect(plan.status).toBe('blocked')
    if (plan.status !== 'blocked') return
    expect(plan.reason).toBe('model_cannot_translate')
  })

  /** The deleted silent drop: translate is never quietly turned into a verbatim run. */
  test('blocks rather than dropping translate on a transcribe-only selection', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: TRANSCRIBE_ONLY,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      available(TRANSCRIBE_ONLY, TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('model_cannot_translate')
    expect(plan.mode).toBe('batch')
  })

  test('blocks when translate has no source language to work from', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: TRANSLATE_CAPABLE,
        translateToEnglish: true,
      }),
      available(TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('no_translate_source_language')
  })
})

describe('buildDictationPlan - missing weights', () => {
  /** The deleted hviske substitution: a missing selection is a blocked run, not another model. */
  test('blocks an hviske selection whose weights are gone', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: HVISKE }),
      available(TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('speech_model_not_installed')
    expect(plan.message).toContain('Hviske')
  })

  test('blocks any selection whose weights are gone', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: TRANSLATE_CAPABLE }),
      available()
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('speech_model_not_installed')
  })

  test('blocks a Speech Model id the catalog has never heard of', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: 'not-a-model' }),
      { isModelAvailable: () => true, streamSupported: true }
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('speech_model_not_installed')
  })
})

describe('buildDictationPlan - Live Transcription', () => {
  test('is the same union, distinguished by mode', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: PARAKEET, streamMode: true }),
      available(PARAKEET)
    )
    expect(plan.status).toBe('runnable')
    if (plan.status !== 'runnable') return
    expect(plan.mode).toBe('live')
    expect(plan.speechModelId).toBe(PARAKEET)
    expect(plan.engineId).toBe('whisperkit')
    expect(plan.translateToEnglish).toBe(false)
  })

  test('the platform question comes before everything else', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: PARAKEET, streamMode: true }),
      { isModelAvailable: () => false, streamSupported: false }
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('live_transcription_unsupported_platform')
    expect(plan.mode).toBe('live')
  })

  test('blocks when the Parakeet weights are missing', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: PARAKEET, streamMode: true }),
      available()
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('parakeet_not_installed')
  })

  test('blocks when the selected Speech Model cannot stream', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: TRANSLATE_CAPABLE, streamMode: true }),
      available(PARAKEET, TRANSLATE_CAPABLE)
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('model_cannot_stream')
  })

  test('blocks a transcription language Parakeet cannot handle', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: PARAKEET,
        transcriptionLanguageId: 'ja',
        streamMode: true,
      }),
      available(PARAKEET)
    )
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('language_not_supported_by_parakeet')
  })

  /** Translate to English is a batch concern; a live plan never carries it. */
  test('never carries translate, even with the toggle on', () => {
    const plan = buildDictationPlan(
      planInput({
        speechModelId: PARAKEET,
        streamMode: true,
        translateToEnglish: true,
        transcriptionLanguageId: 'auto',
        translateDefaultLanguageId: 'da',
      }),
      available(PARAKEET)
    )
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.translateToEnglish).toBe(false)
  })
})

describe('buildDictationPlan - the blocked reasons', () => {
  test('every reason carries its own sentence, and no two reasons share one', () => {
    const cases: [DictationPlanInput, DictationAvailability][] = [
      [planInput({ speechModelId: TRANSLATE_CAPABLE }), available()],
      [
        planInput({
          speechModelId: TRANSCRIBE_ONLY,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        available(TRANSCRIBE_ONLY),
      ],
      [
        planInput({
          speechModelId: TRANSLATE_CAPABLE,
          translateToEnglish: true,
        }),
        available(TRANSLATE_CAPABLE),
      ],
      [
        planInput({ speechModelId: PARAKEET, streamMode: true }),
        { isModelAvailable: () => true, streamSupported: false },
      ],
      [planInput({ speechModelId: PARAKEET, streamMode: true }), available()],
      [
        planInput({ speechModelId: TRANSLATE_CAPABLE, streamMode: true }),
        available(PARAKEET, TRANSLATE_CAPABLE),
      ],
      [
        planInput({
          speechModelId: PARAKEET,
          transcriptionLanguageId: 'ja',
          streamMode: true,
        }),
        available(PARAKEET),
      ],
    ]

    const messages = new Map<DictationBlockedReason, string>()
    for (const [i, a] of cases) {
      const plan = buildDictationPlan(i, a)
      if (plan.status !== 'blocked')
        throw new Error('case is unexpectedly runnable')
      messages.set(plan.reason, plan.message)
    }
    // The eighth reason is the pre-spawn race check, which no settings snapshot can reach.
    messages.set(
      'parakeet_helper_missing',
      blockedDictationPlan('live', 'parakeet_helper_missing', PARAKEET).message
    )

    expect([...messages.keys()].sort()).toEqual([
      'language_not_supported_by_parakeet',
      'live_transcription_unsupported_platform',
      'model_cannot_stream',
      'model_cannot_translate',
      'no_translate_source_language',
      'parakeet_helper_missing',
      'parakeet_not_installed',
      'speech_model_not_installed',
    ])
    const all = [...messages.values()]
    expect(new Set(all).size).toBe(all.length)
    for (const message of all) {
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('undefined')
    }
  })

  test('a blocked plan carries no functions, so it survives the RPC bridge', () => {
    const plan = buildDictationPlan(
      planInput({ speechModelId: TRANSLATE_CAPABLE }),
      available()
    )
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })
})

/**
 * The plan and the shipped readiness are two tenses of one rule - "this run is blocked" and
 * "this option is unavailable". They are computed by two functions in this module, so the
 * only thing stopping them drifting is that they share the predicates and that this test
 * fails when they do not.
 */
describe('buildDictationPlan agrees with getDictationReadiness', () => {
  const selections = [
    TRANSLATE_CAPABLE,
    TRANSCRIBE_ONLY,
    ENGLISH_ONLY,
    HVISKE,
    PARAKEET,
  ]
  const languages = ['auto', 'da', 'ja']
  const snapshots: DictationAvailability[] = [
    available(),
    available(TRANSLATE_CAPABLE),
    available(HVISKE, TRANSLATE_CAPABLE),
    available(PARAKEET),
    available(TRANSLATE_CAPABLE, HVISKE, PARAKEET, ENGLISH_ONLY),
    { isModelAvailable: () => true, streamSupported: false },
  ]

  test('translate runs exactly when readiness says it can', () => {
    for (const speechModelId of selections) {
      for (const transcriptionLanguageId of languages) {
        for (const availability of snapshots) {
          if (!availability.isModelAvailable(speechModelId)) continue
          const shared = { speechModelId, transcriptionLanguageId }
          const plan = buildDictationPlan(
            planInput({ ...shared, translateToEnglish: true }),
            availability
          )
          const readiness = getDictationReadiness(
            input({ ...shared, translateDefaultLanguageId: 'auto' }),
            availability
          ).translateToEnglish
          expect(plan.status === 'runnable').toBe(readiness.ready)
        }
      }
    }
  })

  test('live transcription runs exactly when readiness says it can', () => {
    for (const speechModelId of selections) {
      for (const transcriptionLanguageId of languages) {
        for (const availability of snapshots) {
          const shared = { speechModelId, transcriptionLanguageId }
          const plan = buildDictationPlan(
            planInput({ ...shared, streamMode: true }),
            availability
          )
          const readiness = getDictationReadiness(
            input({ ...shared, translateDefaultLanguageId: 'auto' }),
            availability
          ).liveTranscription
          expect(plan.status === 'runnable').toBe(readiness.ready)
        }
      }
    }
  })
})
