/**
 * The heal pass and the whole-object validator, exercised with nothing but a settings
 * object and an availability snapshot: no subprocess, no filesystem, no webview. That is
 * the whole point of the seam, per
 * docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import { describe, expect, test } from 'bun:test'
import type { DictationAvailability } from './dictation-plan'
import {
  applyRunnableDictationPatch,
  healDictationSettings,
  isRunnableDictationSettings,
  type RunnableDictationSettings,
  type SettingsHealReason,
} from './settings-heal'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  getSpeechModel,
} from './speech-models'

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
]

/**
 * `installed` lists the downloaded Speech Models. Bundled weights ship with the app and are
 * always present, exactly as `modelManager.isModelAvailable` reports them.
 */
function availability(
  installed: string[],
  streamSupported = true
): DictationAvailability {
  return {
    isModelAvailable: (id) =>
      installed.includes(id) || (getSpeechModel(id)?.bundled ?? false),
    streamSupported,
  }
}

function settings(
  overrides: Partial<RunnableDictationSettings> = {}
): RunnableDictationSettings {
  return {
    speechModelId: DEFAULT_MODEL_ID,
    transcriptionLanguageId: 'auto',
    translateDefaultLanguageId: 'auto',
    translateToEnglish: false,
    streamMode: false,
    parakeetCoreMlReady: false,
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
      parakeetCoreMlReady: true,
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
        parakeetCoreMlReady: true,
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
          parakeetCoreMlReady: true,
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
          parakeetCoreMlReady: true,
        }),
        availability([PARAKEET])
      )
    ).toEqual(['language_not_supported_by_parakeet'])
  })

  /**
   * Warmup is transient runtime state the user cannot act on, so it is not a heal reason.
   * A cold Parakeet run prepares itself; ADR-0005 takes `need_warmup` out of the
   * user-facing set entirely.
   */
  test('leaves Live Transcription on while Parakeet is still cold', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: PARAKEET,
        streamMode: true,
        parakeetCoreMlReady: false,
      }),
      availability([PARAKEET])
    )
    expect(result.settings.streamMode).toBe(true)
    expect(result.announcements).toEqual([])
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

describe('healDictationSettings - the quiet corrections', () => {
  test('clears the Parakeet preparation flag when the weights are gone, silently', () => {
    const result = healDictationSettings(
      settings({ parakeetCoreMlReady: true }),
      availability([])
    )
    expect(result.settings.parakeetCoreMlReady).toBe(false)
    expect(result.announcements).toEqual([])
    expect(result.unchanged).toBe(false)
  })

  test('keeps the Parakeet preparation flag while the weights are installed', () => {
    const result = healDictationSettings(
      settings({ parakeetCoreMlReady: true }),
      availability([PARAKEET])
    )
    expect(result.settings.parakeetCoreMlReady).toBe(true)
    expect(result.unchanged).toBe(true)
  })

  test('never touches the transcription or translate default languages', () => {
    const result = healDictationSettings(
      settings({
        speechModelId: PARAKEET,
        transcriptionLanguageId: 'ja',
        translateDefaultLanguageId: 'de',
        streamMode: true,
        parakeetCoreMlReady: true,
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
          parakeetCoreMlReady: true,
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
          parakeetCoreMlReady: true,
        }),
        availability([PARAKEET]),
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
   * The gap the ticket names: `whisperModelId` and `translateToEnglish` are each perfectly
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
        parakeetCoreMlReady: true,
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

  test('turning Live Transcription on while Parakeet is still cold is allowed', () => {
    const outcome = applyRunnableDictationPatch(
      settings({ speechModelId: PARAKEET, parakeetCoreMlReady: false }),
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

  test('is false when a quiet correction is still outstanding', () => {
    expect(
      isRunnableDictationSettings(
        settings({ parakeetCoreMlReady: true }),
        availability([])
      )
    ).toBe(false)
  })
})
