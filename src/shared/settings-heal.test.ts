/**
 * The heal pass and the whole-object validator, exercised with nothing but a settings
 * object and an availability snapshot: no subprocess, no filesystem, no webview. That is
 * the whole point of the seam, per
 * docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import { describe, expect, test } from 'bun:test'
import type { DictationAvailability } from './dictation-plan'
import {
  applyFileTranscriptionSettingsPatch,
  applyRunnableDictationPatch,
  fileTranscriptionTranslateReadiness,
  healDictationSettings,
  healFileTranscriptionSettings,
  isRunnableDictationSettings,
  type FileTranscriptionHealContext,
  type RunnableDictationSettings,
  type SettingsHealReason,
} from './settings-heal'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  getSpeechModel,
} from './speech-models'
import type { FileTranscriptionSettings } from './types'

/** Model ids used below, named so the intent survives a catalog edit. */
const TRANSLATE_CAPABLE = 'small-q5_1'
const TRANSCRIBE_ONLY = DEFAULT_MODEL_ID
const ENGLISH_ONLY = 'small.en-q5_1'
const HVISKE = 'hviske-v5-tiny-f16'
const PARAKEET = DEFAULT_STREAM_CAPABLE_MODEL_ID

/** Every reason the heal pass can announce, so a new member cannot arrive untested. */
const ALL_REASONS: SettingsHealReason[] = [
  'speech_model_not_installed',
  'model_cannot_translate',
  'no_translate_source_language',
  'live_transcription_unsupported_platform',
  'parakeet_not_installed',
  'model_cannot_stream',
  'language_not_supported_by_parakeet',
  'punctuation_model_not_installed',
]

/**
 * `installed` lists the downloaded Speech Models. Bundled weights ship with the app and are
 * always present, exactly as `modelManager.isModelAvailable` reports them.
 */
function availability(
  installed: string[],
  streamSupported = true,
  punctuationModelInstalled = false
): DictationAvailability {
  return {
    isModelAvailable: (id) =>
      installed.includes(id) || (getSpeechModel(id)?.bundled ?? false),
    streamSupported,
    punctuationModelInstalled,
  }
}

/** The same, with the Punctuation Model fully on disk. */
const withPunctuationModel = (installed: string[]) =>
  availability(installed, true, true)

function settings(
  overrides: Partial<RunnableDictationSettings> = {}
): RunnableDictationSettings {
  return {
    speechModelId: DEFAULT_MODEL_ID,
    transcriptionLanguageId: 'auto',
    translateDefaultLanguageId: 'auto',
    translateToEnglish: false,
    streamMode: false,
    addPunctuation: false,
    ...overrides,
  }
}

const reasons = (s: RunnableDictationSettings, a: DictationAvailability) =>
  healDictationSettings(s, a).announcements.map((n) => n.reason)

describe('healDictationSettings - nothing to do', () => {
  test('leaves a runnable default configuration untouched and silent', () => {
    const input = settings()
    const result = healDictationSettings(input, availability([]))
    expect(result.settings).toEqual(input)
    expect(result.announcements).toEqual([])
    expect(result.unchanged).toBe(true)
  })

  test('leaves a runnable translate configuration untouched and silent', () => {
    const input = settings({
      speechModelId: TRANSLATE_CAPABLE,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    })
    const result = healDictationSettings(
      input,
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.settings).toEqual(input)
    expect(result.unchanged).toBe(true)
  })

  test('leaves a runnable Live Transcription configuration untouched and silent', () => {
    const input = settings({
      speechModelId: PARAKEET,
      streamMode: true,
    })
    const result = healDictationSettings(input, availability([PARAKEET]))
    expect(result.settings).toEqual(input)
    expect(result.unchanged).toBe(true)
  })

  test('is a pure function: the input object is not mutated', () => {
    const input = settings({
      speechModelId: TRANSLATE_CAPABLE,
      translateToEnglish: true,
      streamMode: true,
    })
    const before = { ...input }
    healDictationSettings(input, availability([]))
    expect(input).toEqual(before)
  })
})

describe('healDictationSettings - the Speech Model selection', () => {
  test('resets a selection whose weights are gone to the bundled default', () => {
    const result = healDictationSettings(
      settings({ speechModelId: TRANSLATE_CAPABLE }),
      availability([])
    )
    expect(result.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(result.announcements).toHaveLength(1)
    expect(result.announcements[0]).toMatchObject({
      target: 'speech_model',
      reason: 'speech_model_not_installed',
    })
  })

  test('resets an unknown Speech Model id to the bundled default', () => {
    const result = healDictationSettings(
      settings({ speechModelId: 'not-a-model' }),
      availability(['not-a-model'])
    )
    expect(result.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(
      reasons(settings({ speechModelId: 'not-a-model' }), availability([]))
    ).toContain('speech_model_not_installed')
  })

  test('keeps an installed non-default selection', () => {
    const result = healDictationSettings(
      settings({ speechModelId: HVISKE }),
      availability([HVISKE])
    )
    expect(result.settings.speechModelId).toBe(HVISKE)
    expect(result.announcements).toEqual([])
  })

  test('the bundled default needs no install to survive the pass', () => {
    const result = healDictationSettings(
      settings({ speechModelId: DEFAULT_MODEL_ID }),
      availability([])
    )
    expect(result.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(result.announcements).toEqual([])
  })
})

describe('healDictationSettings - Translate to English', () => {
  test('turns Translate off when the selection cannot translate', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: TRANSCRIBE_ONLY,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      availability([])
    )
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements).toHaveLength(1)
    expect(result.announcements[0]).toMatchObject({
      target: 'translate_to_english',
      reason: 'model_cannot_translate',
    })
  })

  test('turns Translate off for an English-only selection', () => {
    expect(
      reasons(
        settings({
          speechModelId: ENGLISH_ONLY,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        availability([ENGLISH_ONLY])
      )
    ).toEqual(['model_cannot_translate'])
  })

  /**
   * The state ADR-0005 exists to remove. Translate to English used to appear to work under
   * an hviske selection by swapping in the first installed translate-capable Whisper model.
   * The heal pass applies the collapsed rule ("is the *selection* translate-capable and
   * installed"), which is what made the swap unreachable before it was deleted - and what
   * keeps `buildDictationPlan`'s `model_cannot_translate` block a last resort rather than
   * something a user meets by ordinary use.
   */
  test('turns Translate off under an hviske selection even with a translate-capable model installed', () => {
    expect(
      reasons(
        settings({
          speechModelId: HVISKE,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        availability([HVISKE, TRANSLATE_CAPABLE])
      )
    ).toEqual(['model_cannot_translate'])
  })

  test('turns Translate off when no source language is fixed', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'auto',
        translateDefaultLanguageId: 'auto',
        translateToEnglish: true,
      }),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements).toEqual([
      expect.objectContaining({
        target: 'translate_to_english',
        reason: 'no_translate_source_language',
      }),
    ])
  })

  test('the translate default language alone is a good enough source', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: TRANSLATE_CAPABLE,
        translateDefaultLanguageId: 'da',
        translateToEnglish: true,
      }),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.settings.translateToEnglish).toBe(true)
    expect(result.announcements).toEqual([])
  })

  test('a deleted translate-capable selection resets the model and turns Translate off', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      availability([])
    )
    expect(result.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements.map((n) => n.target)).toEqual([
      'speech_model',
      'translate_to_english',
    ])
  })

  test('says nothing about Translate when it was already off', () => {
    expect(
      reasons(
        settings({ speechModelId: TRANSCRIBE_ONLY, translateToEnglish: false }),
        availability([])
      )
    ).toEqual([])
  })
})

describe('healDictationSettings - Live Transcription', () => {
  /** The live bug in #46: deleting Parakeet left Live Transcription switched on. */
  test('turns Live Transcription off when the Parakeet weights are gone', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: PARAKEET,
        streamMode: true,
      }),
      availability([])
    )
    expect(result.settings.streamMode).toBe(false)
    expect(
      result.announcements.filter((n) => n.target === 'live_transcription')
    ).toEqual([expect.objectContaining({ reason: 'parakeet_not_installed' })])
  })

  test('turns Live Transcription off when the selection cannot stream', () => {
    expect(
      reasons(
        settings({ speechModelId: TRANSCRIBE_ONLY, streamMode: true }),
        availability([PARAKEET])
      )
    ).toEqual(['model_cannot_stream'])
  })

  test('turns Live Transcription off where the platform cannot run it', () => {
    expect(
      reasons(
        settings({
          speechModelId: PARAKEET,
          streamMode: true,
        }),
        availability([PARAKEET], false)
      )
    ).toEqual(['live_transcription_unsupported_platform'])
  })

  test('turns Live Transcription off on a language Parakeet cannot handle', () => {
    expect(
      reasons(
        settings({
          speechModelId: PARAKEET,
          transcriptionLanguageId: 'ja',
          streamMode: true,
        }),
        availability([PARAKEET])
      )
    ).toEqual(['language_not_supported_by_parakeet'])
  })

  test('says nothing about Live Transcription when it was already off', () => {
    expect(
      reasons(
        settings({ speechModelId: TRANSCRIBE_ONLY, streamMode: false }),
        availability([])
      )
    ).toEqual([])
  })
})

describe('healDictationSettings - Add punctuation', () => {
  test('turns Add punctuation off and says so when the Punctuation Model is gone', () => {
    const result = healDictationSettings(
      settings({ speechModelId: HVISKE, addPunctuation: true }),
      availability([HVISKE])
    )
    expect(result.settings.addPunctuation).toBe(false)
    expect(result.settings.speechModelId).toBe(HVISKE)
    expect(result.announcements).toEqual([
      {
        target: 'add_punctuation',
        reason: 'punctuation_model_not_installed',
        message:
          'Add punctuation turned off because its Danish punctuation model is no longer installed.',
      },
    ])
  })

  test('leaves Add punctuation on while the Punctuation Model is installed', () => {
    const input = settings({ speechModelId: HVISKE, addPunctuation: true })
    const result = healDictationSettings(input, withPunctuationModel([HVISKE]))
    expect(result.unchanged).toBe(true)
    expect(result.announcements).toEqual([])
  })

  /**
   * The switch is global: only hviske reads it, but leaving hviske for Edda and coming back
   * keeps it, and the File Transcription selection reads it too.
   */
  test('leaves Add punctuation on under a Speech Model that ignores it', () => {
    const input = settings({
      speechModelId: TRANSLATE_CAPABLE,
      addPunctuation: true,
    })
    const result = healDictationSettings(
      input,
      withPunctuationModel([TRANSLATE_CAPABLE])
    )
    expect(result.unchanged).toBe(true)
  })

  /**
   * Without the Punctuation Model the switch cannot be on for any selection: it only turns
   * true after a verified install, and a File Transcription on hviske reads it whatever the
   * Dictation's Speech Model is.
   */
  test('turns Add punctuation off without the Punctuation Model under any selection', () => {
    const result = healDictationSettings(
      settings({ speechModelId: TRANSLATE_CAPABLE, addPunctuation: true }),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.settings.addPunctuation).toBe(false)
    expect(result.announcements.map((a) => a.reason)).toEqual([
      'punctuation_model_not_installed',
    ])
  })

  test('refuses turning Add punctuation on without the Punctuation Model', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: HVISKE }),
      { addPunctuation: true },
      availability([HVISKE])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'add_punctuation',
    ])
  })

  test('accepts turning Add punctuation on with the Punctuation Model installed', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: HVISKE }),
      { addPunctuation: true },
      withPunctuationModel([HVISKE])
    )
    expect(outcome.kind === 'accepted' && outcome.settings.addPunctuation).toBe(
      true
    )
  })
})

describe('healDictationSettings - what it leaves alone', () => {
  test('never touches the transcription or translate default languages', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: PARAKEET,
        transcriptionLanguageId: 'ja',
        translateDefaultLanguageId: 'de',
        streamMode: true,
      }),
      availability([PARAKEET])
    )
    expect(result.settings.transcriptionLanguageId).toBe('ja')
    expect(result.settings.translateDefaultLanguageId).toBe('de')
  })
})

describe('healDictationSettings - announcements', () => {
  test('every reason carries its own non-empty user-facing message', () => {
    const messages = new Map<SettingsHealReason, string>()
    const cases: [RunnableDictationSettings, DictationAvailability][] = [
      [settings({ speechModelId: TRANSLATE_CAPABLE }), availability([])],
      [
        settings({
          speechModelId: TRANSCRIBE_ONLY,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        availability([]),
      ],
      [
        settings({
          speechModelId: TRANSLATE_CAPABLE,
          translateToEnglish: true,
        }),
        availability([TRANSLATE_CAPABLE]),
      ],
      [
        settings({
          speechModelId: PARAKEET,
          streamMode: true,
        }),
        availability([PARAKEET], false),
      ],
      [
        settings({ speechModelId: PARAKEET, streamMode: true }),
        availability([]),
      ],
      [
        settings({ speechModelId: TRANSCRIBE_ONLY, streamMode: true }),
        availability([PARAKEET]),
      ],
      [
        settings({
          speechModelId: PARAKEET,
          transcriptionLanguageId: 'ja',
          streamMode: true,
        }),
        availability([PARAKEET]),
      ],
      [
        settings({ speechModelId: HVISKE, addPunctuation: true }),
        availability([HVISKE]),
      ],
    ]
    for (const [input, avail] of cases) {
      for (const announcement of healDictationSettings(input, avail)
        .announcements) {
        messages.set(announcement.reason, announcement.message)
      }
    }
    for (const reason of ALL_REASONS) {
      const message = messages.get(reason)
      expect(message, `no announcement produced for ${reason}`).toBeDefined()
      expect(message!.length).toBeGreaterThan(0)
      expect(message).not.toContain('undefined')
    }
    expect(new Set(messages.values()).size).toBe(ALL_REASONS.length)
  })
})

describe('applyRunnableDictationPatch - refused', () => {
  test('refuses turning Translate on when the selection cannot translate', () => {
    const outcome = applyRunnableDictationPatch(
      settings({
        speechModelId: TRANSCRIBE_ONLY,
        transcriptionLanguageId: 'da',
      }),
      { translateToEnglish: true },
      availability([])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'translate_to_english',
    ])
  })

  test('refuses turning Translate on when the translate-capable selection is not installed', () => {
    const outcome = applyRunnableDictationPatch(
      settings({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
      }),
      { translateToEnglish: true },
      availability([])
    )
    expect(outcome.kind).toBe('refused')
  })

  test('refuses turning Translate on with no source language', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: TRANSLATE_CAPABLE }),
      { translateToEnglish: true },
      availability([TRANSLATE_CAPABLE])
    )
    expect(outcome.kind).toBe('refused')
  })

  /**
   * The gap the ticket names: `speechModelId` and `translateToEnglish` are each perfectly
   * valid values, and together they are a Dictation that cannot do what was asked.
   */
  test('refuses a patch whose fields are individually valid and jointly unrunnable', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ transcriptionLanguageId: 'da' }),
      { speechModelId: TRANSCRIBE_ONLY, translateToEnglish: true },
      availability([])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'translate_to_english',
    ])
  })

  test('refuses selecting a Speech Model that is not installed', () => {
    const outcome = applyRunnableDictationPatch(
      settings(),
      { speechModelId: TRANSLATE_CAPABLE },
      availability([])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'speech_model',
    ])
  })

  test('refuses turning Live Transcription on without the Parakeet weights', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: PARAKEET }),
      { streamMode: true },
      availability([])
    )
    // The selection is unrunnable too, so both refusals are reported.
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toContain(
      'live_transcription'
    )
  })

  test('refuses turning Live Transcription on under a Speech Model that cannot stream', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: TRANSCRIBE_ONLY }),
      { streamMode: true },
      availability([PARAKEET])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'live_transcription',
    ])
  })
})

describe('applyRunnableDictationPatch - accepted', () => {
  test('accepts an ordinary write and says nothing', () => {
    const outcome = applyRunnableDictationPatch(
      settings(),
      { transcriptionLanguageId: 'da' },
      availability([])
    )
    expect(outcome.kind).toBe('accepted')
    expect(outcome.announcements).toEqual([])
    expect(
      outcome.kind === 'accepted' && outcome.settings.transcriptionLanguageId
    ).toBe('da')
  })

  /** Two individually valid writes, an invalid result, and the second one heals the first. */
  test('switching to a Speech Model that cannot translate turns Translate off and announces it', () => {
    const outcome = applyRunnableDictationPatch(
      settings({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      { speechModelId: TRANSCRIBE_ONLY },
      availability([TRANSLATE_CAPABLE])
    )
    expect(outcome.kind).toBe('accepted')
    expect(outcome.kind === 'accepted' && outcome.settings).toMatchObject({
      speechModelId: TRANSCRIBE_ONLY,
      translateToEnglish: false,
    })
    expect(outcome.announcements.map((n) => n.target)).toEqual([
      'translate_to_english',
    ])
  })

  test('switching to a Speech Model that cannot stream turns Live Transcription off and announces it', () => {
    const outcome = applyRunnableDictationPatch(
      settings({
        speechModelId: PARAKEET,
        streamMode: true,
      }),
      { speechModelId: TRANSCRIBE_ONLY },
      availability([PARAKEET])
    )
    expect(outcome.kind === 'accepted' && outcome.settings.streamMode).toBe(
      false
    )
    expect(outcome.announcements.map((n) => n.target)).toEqual([
      'live_transcription',
    ])
  })

  test('turning Translate off is never refused', () => {
    const outcome = applyRunnableDictationPatch(
      settings({
        speechModelId: TRANSCRIBE_ONLY,
        translateToEnglish: true,
        transcriptionLanguageId: 'da',
      }),
      { translateToEnglish: false },
      availability([])
    )
    expect(outcome.kind).toBe('accepted')
    expect(outcome.announcements).toEqual([])
  })

  test('turning Live Transcription off is never refused', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: PARAKEET, streamMode: true }),
      { streamMode: false },
      availability([])
    )
    expect(outcome.kind).toBe('accepted')
  })

  test('turning Live Transcription on with Parakeet selected is allowed', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: PARAKEET }),
      { streamMode: true },
      availability([PARAKEET])
    )
    expect(outcome.kind).toBe('accepted')
    expect(outcome.kind === 'accepted' && outcome.settings.streamMode).toBe(
      true
    )
  })
})

describe('isRunnableDictationSettings', () => {
  test('is true for a runnable object', () => {
    expect(
      isRunnableDictationSettings(
        settings({
          speechModelId: TRANSLATE_CAPABLE,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        availability([TRANSLATE_CAPABLE])
      )
    ).toBe(true)
  })

  /**
   * The gap the ticket names: each field of the patch is individually valid, and the
   * object it produces is not.
   */
  test('is false when Translate is on with a Speech Model that cannot translate', () => {
    expect(
      isRunnableDictationSettings(
        settings({
          speechModelId: TRANSCRIBE_ONLY,
          transcriptionLanguageId: 'da',
          translateToEnglish: true,
        }),
        availability([])
      )
    ).toBe(false)
  })

  test('is false when Live Transcription is on without the Parakeet weights', () => {
    expect(
      isRunnableDictationSettings(
        settings({ speechModelId: PARAKEET, streamMode: true }),
        availability([])
      )
    ).toBe(false)
  })
})

describe('healFileTranscriptionSettings', () => {
  function file(
    overrides: Partial<FileTranscriptionSettings> = {}
  ): FileTranscriptionSettings {
    return {
      speechModelId: DEFAULT_MODEL_ID,
      transcriptionLanguageId: 'auto',
      translateToEnglish: false,
      ...overrides,
    }
  }
  function context(
    overrides: Partial<FileTranscriptionHealContext> = {}
  ): FileTranscriptionHealContext {
    return {
      dictationSpeechModelId: DEFAULT_MODEL_ID,
      translateDefaultLanguageId: 'auto',
      ...overrides,
    }
  }

  test('leaves runnable settings untouched and silent', () => {
    const input = file({
      speechModelId: TRANSLATE_CAPABLE,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    })
    const result = healFileTranscriptionSettings(
      input,
      context(),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result).toEqual({
      settings: input,
      announcements: [],
      unchanged: true,
    })
  })

  test("falls back to the Dictation's Speech Model, not the bundled default, and says so", () => {
    const input = file({ speechModelId: TRANSLATE_CAPABLE })
    const result = healFileTranscriptionSettings(
      input,
      context({ dictationSpeechModelId: PARAKEET }),
      availability([PARAKEET])
    )
    expect(result.settings.speechModelId).toBe(PARAKEET)
    expect(result.unchanged).toBe(false)
    expect(result.announcements).toEqual([
      {
        target: 'speech_model',
        reason: 'speech_model_not_installed',
        message: `File transcription switched to ${getSpeechModel(PARAKEET)?.label} because the ${getSpeechModel(TRANSLATE_CAPABLE)?.label} weights are no longer installed.`,
      },
    ])
    expect(input.speechModelId).toBe(TRANSLATE_CAPABLE)
  })

  test('an unknown Speech Model id falls back the same way', () => {
    const result = healFileTranscriptionSettings(
      file({ speechModelId: 'retired-model' }),
      context(),
      availability([])
    )
    expect(result.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(result.announcements.map((n) => n.reason)).toEqual([
      'speech_model_not_installed',
    ])
  })

  test('turns Translate off for turbo and says so', () => {
    const result = healFileTranscriptionSettings(
      file({
        speechModelId: TRANSCRIBE_ONLY,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      context(),
      availability([])
    )
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements).toEqual([
      {
        target: 'translate_to_english',
        reason: 'model_cannot_translate',
        message: `Translate to English for files turned off because ${getSpeechModel(TRANSCRIBE_ONLY)?.label} cannot translate.`,
      },
    ])
  })

  test('a fallback to a Speech Model that cannot translate turns Translate off too', () => {
    const result = healFileTranscriptionSettings(
      file({
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      context(),
      availability([])
    )
    expect(result.settings).toEqual(
      file({ transcriptionLanguageId: 'da', translateToEnglish: false })
    )
    expect(result.announcements.map((n) => n.target)).toEqual([
      'speech_model',
      'translate_to_english',
    ])
  })

  test('turns Translate off when no source language is fixed', () => {
    const result = healFileTranscriptionSettings(
      file({ speechModelId: TRANSLATE_CAPABLE, translateToEnglish: true }),
      context(),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements).toEqual([
      {
        target: 'translate_to_english',
        reason: 'no_translate_source_language',
        message:
          'Translate to English for files turned off because it needs a source language rather than automatic detection.',
      },
    ])
  })

  test("the Dictation's translate default is a good enough source", () => {
    const result = healFileTranscriptionSettings(
      file({ speechModelId: TRANSLATE_CAPABLE, translateToEnglish: true }),
      context({ translateDefaultLanguageId: 'da' }),
      availability([TRANSLATE_CAPABLE])
    )
    expect(result.unchanged).toBe(true)
  })

  test('quietly coerces the language for Parakeet', () => {
    const result = healFileTranscriptionSettings(
      file({ speechModelId: PARAKEET, transcriptionLanguageId: 'da' }),
      context(),
      availability([PARAKEET])
    )
    expect(result.settings.transcriptionLanguageId).toBe('auto')
    expect(result.announcements).toEqual([])
    expect(result.unchanged).toBe(false)
  })

  test('quietly coerces a language hviske does not speak, and keeps Danish', () => {
    const coerced = healFileTranscriptionSettings(
      file({ speechModelId: HVISKE, transcriptionLanguageId: 'en' }),
      context(),
      availability([HVISKE])
    )
    expect(coerced.settings.transcriptionLanguageId).toBe('auto')
    expect(coerced.announcements).toEqual([])

    const kept = healFileTranscriptionSettings(
      file({ speechModelId: HVISKE, transcriptionLanguageId: 'da' }),
      context(),
      availability([HVISKE])
    )
    expect(kept.unchanged).toBe(true)
  })

  test('turns Translate off under hviske with its single-language reason', () => {
    const result = healFileTranscriptionSettings(
      file({
        speechModelId: HVISKE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      context(),
      availability([HVISKE])
    )
    expect(result.settings.translateToEnglish).toBe(false)
    expect(result.announcements.map((n) => n.reason)).toEqual([
      'model_cannot_translate',
    ])
  })

  test('readiness is the same one the heal pass asks', () => {
    expect(
      fileTranscriptionTranslateReadiness(
        file({
          speechModelId: TRANSLATE_CAPABLE,
          transcriptionLanguageId: 'da',
        }),
        context(),
        availability([TRANSLATE_CAPABLE])
      ).ready
    ).toBe(true)
    expect(
      fileTranscriptionTranslateReadiness(file(), context(), availability([]))
    ).toMatchObject({ ready: false, reason: 'model_cannot_translate' })
  })

  test('user-facing sentences have no em dashes', () => {
    const result = healFileTranscriptionSettings(
      file({ speechModelId: 'small-q5_1', translateToEnglish: true }),
      context(),
      availability([])
    )
    for (const announcement of result.announcements) {
      expect(announcement.message).not.toContain('\u2014')
    }
  })
})

describe('applyFileTranscriptionSettingsPatch', () => {
  const current: FileTranscriptionSettings = {
    speechModelId: DEFAULT_MODEL_ID,
    transcriptionLanguageId: 'da',
    translateToEnglish: false,
  }
  const context: FileTranscriptionHealContext = {
    dictationSpeechModelId: DEFAULT_MODEL_ID,
    translateDefaultLanguageId: 'auto',
  }

  test('accepts a runnable switch', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      current,
      { speechModelId: TRANSLATE_CAPABLE, translateToEnglish: true },
      context,
      availability([TRANSLATE_CAPABLE])
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      settings: {
        speechModelId: TRANSLATE_CAPABLE,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      },
      announcements: [],
    })
  })

  test('refuses a Speech Model that is not installed, rather than falling back', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      current,
      { speechModelId: TRANSLATE_CAPABLE },
      context,
      availability([])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'speech_model',
    ])
  })

  test('refuses an unknown Speech Model id', () => {
    expect(
      applyFileTranscriptionSettingsPatch(
        current,
        { speechModelId: 'nope' },
        context,
        availability([])
      ).kind
    ).toBe('refused')
  })

  test('refuses Translate to English where it cannot run', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      current,
      { translateToEnglish: true },
      context,
      availability([])
    )
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.refusedTargets).toEqual([
      'translate_to_english',
    ])
  })

  test('refuses Translate to English from automatic detection with no default', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      { ...current, speechModelId: TRANSLATE_CAPABLE },
      { transcriptionLanguageId: 'auto', translateToEnglish: true },
      context,
      availability([TRANSLATE_CAPABLE])
    )
    expect(outcome.kind).toBe('refused')
  })

  test('refuses an invalid language id, and one the Speech Model cannot take', () => {
    expect(
      applyFileTranscriptionSettingsPatch(
        current,
        { transcriptionLanguageId: 'klingon' },
        context,
        availability([])
      ).kind
    ).toBe('refused')
    expect(
      applyFileTranscriptionSettingsPatch(
        current,
        { speechModelId: HVISKE, transcriptionLanguageId: 'en' },
        context,
        availability([HVISKE])
      ).kind
    ).toBe('refused')
  })

  test('switching to Parakeet coerces the language quietly', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      current,
      { speechModelId: PARAKEET },
      context,
      availability([PARAKEET])
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      settings: {
        speechModelId: PARAKEET,
        transcriptionLanguageId: 'auto',
        translateToEnglish: false,
      },
      announcements: [],
    })
  })

  test('switching to a Speech Model that cannot translate turns Translate off and announces it', () => {
    const outcome = applyFileTranscriptionSettingsPatch(
      {
        ...current,
        speechModelId: TRANSLATE_CAPABLE,
        translateToEnglish: true,
      },
      { speechModelId: ENGLISH_ONLY },
      context,
      availability([TRANSLATE_CAPABLE, ENGLISH_ONLY])
    )
    expect(outcome.kind).toBe('accepted')
    expect(outcome.kind === 'accepted' && outcome.settings).toMatchObject({
      speechModelId: ENGLISH_ONLY,
      translateToEnglish: false,
    })
    expect(outcome.announcements.map((n) => n.target)).toEqual([
      'translate_to_english',
    ])
  })

  test('turning Translate off is never refused', () => {
    expect(
      applyFileTranscriptionSettingsPatch(
        { ...current, translateToEnglish: true },
        { translateToEnglish: false },
        context,
        availability([])
      ).kind
    ).toBe('accepted')
  })
})
