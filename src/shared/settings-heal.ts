/**
 * Keeping the settings runnable.
 *
 * Validity is a property of the whole settings object, not of the patch being written:
 * turning Translate to English on with a translate-capable Speech Model and then switching
 * to one that cannot translate is two individually valid writes with an invalid result. And
 * validity depends on files, which change with no settings write at all. So the same
 * function runs in three places - on every settings write, on every availability change, and
 * at boot - and it is a pure function of `(settings, availability snapshot)` with no
 * `modelManager`, no platform probe and no filesystem, which is what lets it be tested
 * without either.
 *
 * The write path and the availability path use it differently, on purpose (ADR-0005):
 *
 * - **On write, refuse.** A patch that asks for something that cannot run is rejected whole,
 *   because the user is standing right there and can fix it.
 * - **On an availability change, heal.** Never argue with someone deleting multi-gigabyte
 *   weights to get their disk space back. Correct the configuration instead, and say so.
 *
 * Announcements are limited to the three things the user chose deliberately - the Speech
 * Model selection, Translate to English, Live Transcription. The rest is corrected in
 * silence. Silently flipping a toggle the user set is the same class of surprise as a silent
 * fallback, so the noisy set and the quiet set are drawn on purpose rather than by
 * convenience.
 *
 * See docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import {
  NO_PARAKEET_LOAD,
  PARAKEET_LABEL,
  getDictationReadiness,
  modelLabel,
  type DictationAvailability,
  type TranslateReadiness,
} from './dictation-plan'
import {
  DEFAULT_MODEL_ID,
  coerceTranscriptionLanguageIdForModel,
  isValidSpeechModelId,
} from './speech-models'
import { isValidTranscriptionLanguageId } from './transcription-languages'
import type {
  FileTranscriptionSettings,
  FileTranscriptionSettingsPatch,
} from './types'

/**
 * The slice of the settings a Dictation depends on. Nothing else in `AppSettings` can make
 * one unrunnable, so nothing else is passed in and nothing else can be corrected by
 * accident.
 */
export interface RunnableDictationSettings {
  speechModelId: string
  transcriptionLanguageId: string
  translateDefaultLanguageId: string
  translateToEnglish: boolean
  streamMode: boolean
}

/**
 * Every field of `RunnableDictationSettings`, as an exhaustive `Record` for the same reason
 * `BLOCKED_MESSAGES` is one: `tsc` refuses to compile a new field that is not listed here.
 * `unchanged` walks this rather than comparing fields by hand, so a field added to the
 * interface cannot silently read as unchanged - and `isRunnableDictationSettings` is
 * `unchanged`, so that silence would have passed an unrunnable object as runnable.
 */
const RUNNABLE_DICTATION_SETTINGS_FIELDS: Record<
  keyof RunnableDictationSettings,
  true
> = {
  speechModelId: true,
  transcriptionLanguageId: true,
  translateDefaultLanguageId: true,
  translateToEnglish: true,
  streamMode: true,
}

const RUNNABLE_DICTATION_SETTINGS_KEYS = Object.keys(
  RUNNABLE_DICTATION_SETTINGS_FIELDS
) as (keyof RunnableDictationSettings)[]

/** The three user choices the heal pass is allowed to change out loud. */
export type SettingsHealTarget =
  'speech_model' | 'translate_to_english' | 'live_transcription'

/**
 * Closed union, so a new way for the configuration to go bad cannot join a generic bucket
 * without `tsc` demanding a message for it.
 */
export type SettingsHealReason =
  | 'speech_model_not_installed'
  | 'model_cannot_translate'
  | 'no_translate_source_language'
  | 'live_transcription_unsupported_platform'
  | 'parakeet_not_installed'
  | 'model_cannot_stream'
  | 'language_not_supported_by_parakeet'

export interface SettingsHealAnnouncement {
  target: SettingsHealTarget
  reason: SettingsHealReason
  /** One finished sentence, shown to the user as written. */
  message: string
}

export interface SettingsHealResult {
  /** The corrected settings. The input object is never mutated. */
  settings: RunnableDictationSettings
  /** What to tell the user. Empty when only the quiet corrections applied. */
  announcements: SettingsHealAnnouncement[]
  /** True when nothing changed at all, announced or quiet: the object was already runnable. */
  unchanged: boolean
}

export function healDictationSettings(
  settings: RunnableDictationSettings,
  availability: DictationAvailability
): SettingsHealResult {
  const next: RunnableDictationSettings = { ...settings }
  const announcements: SettingsHealAnnouncement[] = []

  const announce = (
    target: SettingsHealTarget,
    reason: SettingsHealReason,
    message: string
  ) => announcements.push({ target, reason, message })

  // The selection first: everything below is judged against the Speech Model that will
  // actually load, not the one that has gone missing.
  if (
    !isValidSpeechModelId(next.speechModelId) ||
    !availability.isModelAvailable(next.speechModelId)
  ) {
    const previous = modelLabel(next.speechModelId)
    next.speechModelId = DEFAULT_MODEL_ID
    announce(
      'speech_model',
      'speech_model_not_installed',
      `Speech Model switched to ${modelLabel(DEFAULT_MODEL_ID)} because the ${previous} weights are no longer installed.`
    )
  }

  // The same readiness the webview is shipped, asked here about the *corrected* settings.
  // One definition of "can this run", so the heal pass and the UI cannot disagree about the
  // single-language combination or about anything else. What differs is only the tense: readiness
  // says why an option is unavailable, an announcement says what was switched off.
  // A Parakeet Preparation never makes anything unrunnable, so the load is left out.
  const readiness = getDictationReadiness(next, availability, NO_PARAKEET_LOAD)

  const translate = readiness.translateToEnglish
  if (next.translateToEnglish && !translate.ready) {
    next.translateToEnglish = false
    switch (translate.reason) {
      case 'single_language_selected':
      case 'model_cannot_translate':
        announce(
          'translate_to_english',
          'model_cannot_translate',
          `Translate to English turned off because ${modelLabel(next.speechModelId)} cannot translate.`
        )
        break
      case 'model_not_installed':
        // Unreachable while the selection is healed first, and kept honest anyway so the
        // union stays closed.
        announce(
          'translate_to_english',
          'model_cannot_translate',
          `Translate to English turned off because the ${modelLabel(next.speechModelId)} weights are no longer installed.`
        )
        break
      case 'needs_source_language':
        announce(
          'translate_to_english',
          'no_translate_source_language',
          'Translate to English turned off because it needs a source language rather than automatic detection.'
        )
        break
    }
  }

  const live = readiness.liveTranscription
  if (next.streamMode && !live.ready) {
    next.streamMode = false
    switch (live.reason) {
      case 'unsupported_platform':
        announce(
          'live_transcription',
          'live_transcription_unsupported_platform',
          'Live transcription turned off because this platform cannot run it yet.'
        )
        break
      case 'parakeet_not_installed':
        announce(
          'live_transcription',
          'parakeet_not_installed',
          `Live transcription turned off because the ${PARAKEET_LABEL} weights are no longer installed.`
        )
        break
      case 'model_cannot_stream':
        announce(
          'live_transcription',
          'model_cannot_stream',
          `Live transcription turned off because ${modelLabel(next.speechModelId)} cannot run it.`
        )
        break
      case 'language_not_supported':
        announce(
          'live_transcription',
          'language_not_supported_by_parakeet',
          `Live transcription turned off because ${PARAKEET_LABEL} does not support the selected transcription language.`
        )
        break
    }
  }

  return {
    settings: next,
    announcements,
    unchanged: RUNNABLE_DICTATION_SETTINGS_KEYS.every(
      (key) => next[key] === settings[key]
    ),
  }
}

/**
 * Whole-object validation: a settings object is runnable exactly when the heal pass has
 * nothing to do to it. One definition, so the validator and the heal pass cannot drift.
 */
export function isRunnableDictationSettings(
  settings: RunnableDictationSettings,
  availability: DictationAvailability
): boolean {
  return healDictationSettings(settings, availability).unchanged
}

/** The runnable slice of a settings patch, keyed the way the heal pass names things. */
export type RunnableDictationSettingsPatch = Partial<RunnableDictationSettings>

export type SettingsWriteOutcome =
  | {
      kind: 'accepted'
      settings: RunnableDictationSettings
      /** Collateral the patch never asked for, corrected and to be announced. */
      announcements: SettingsHealAnnouncement[]
    }
  | {
      kind: 'refused'
      /** The choices in the patch that cannot run. Nothing is written. */
      refusedTargets: SettingsHealTarget[]
      announcements: SettingsHealAnnouncement[]
    }

/**
 * Which patch field owns each announced target. Only the "on" direction can ever be
 * contradicted, because the heal pass only ever switches things off.
 */
const PATCH_OWNS_TARGET: Record<
  SettingsHealTarget,
  (patch: RunnableDictationSettingsPatch) => boolean
> = {
  speech_model: (patch) => patch.speechModelId !== undefined,
  translate_to_english: (patch) => patch.translateToEnglish === true,
  live_transcription: (patch) => patch.streamMode === true,
}

/**
 * The write arm of the enforcement: validate the object the patch would produce, not the
 * fields in the patch.
 *
 * A heal that contradicts something the patch asked for explicitly refuses the write whole,
 * because the user is right there and can fix it - turning Translate to English on under a
 * Speech Model that cannot translate is told no, rather than accepted and quietly undone. A
 * heal that corrects a field the patch never mentioned is applied and announced, which is the
 * "switching Speech Model turns Translate off, visibly" case.
 */
export function applyRunnableDictationPatch(
  current: RunnableDictationSettings,
  patch: RunnableDictationSettingsPatch,
  availability: DictationAvailability
): SettingsWriteOutcome {
  const healed = healDictationSettings({ ...current, ...patch }, availability)
  const refusedTargets = healed.announcements
    .map((announcement) => announcement.target)
    .filter((target) => PATCH_OWNS_TARGET[target](patch))
  if (refusedTargets.length > 0) {
    return {
      kind: 'refused',
      refusedTargets,
      announcements: healed.announcements,
    }
  }
  return {
    kind: 'accepted',
    settings: healed.settings,
    announcements: healed.announcements,
  }
}

// ── File Transcription Settings ─────────────────────────────────────────────────
//
// The Speech Model, Transcription Language and Translate to English that File
// Transcriptions use, chosen apart from the Dictation's and kept runnable the same way:
// refused on write, healed on every availability change and at boot. What differs is where
// a missing Speech Model lands. A Dictation's falls back to the bundled default; a File
// Transcription's falls back to the Dictation's, which the heal pass has already made
// runnable, because "the same as my Dictations" is what the user started from.

/**
 * What the File Transcription Settings borrow from the Dictation's. Read after the Dictation
 * heal, so `dictationSpeechModelId` is always installed.
 */
export interface FileTranscriptionHealContext {
  /** The Dictation's Speech Model after healing: where a missing file selection falls back to. */
  dictationSpeechModelId: string
  /** The source language Translate to English uses when the Transcription Language is `auto`. */
  translateDefaultLanguageId: string
}

export interface FileTranscriptionSettingsHealResult {
  /** The corrected settings. The input object is never mutated. */
  settings: FileTranscriptionSettings
  /** What to tell the user on the Transcribe page. Empty when only quiet corrections applied. */
  announcements: SettingsHealAnnouncement[]
  /** True when nothing changed at all, announced or quiet. */
  unchanged: boolean
}

/**
 * Can Translate to English run with these File Transcription Settings, and the sentence when
 * it cannot. The same readiness the Dictation's Translate toggle uses, asked about the file
 * selection, so the Transcribe page and the heal pass cannot disagree.
 */
export function fileTranscriptionTranslateReadiness(
  settings: FileTranscriptionSettings,
  context: FileTranscriptionHealContext,
  availability: DictationAvailability
): TranslateReadiness {
  return getDictationReadiness(
    {
      speechModelId: settings.speechModelId,
      transcriptionLanguageId: settings.transcriptionLanguageId,
      translateDefaultLanguageId: context.translateDefaultLanguageId,
    },
    availability,
    // A File Transcription never starts the background load, and translate ignores it.
    NO_PARAKEET_LOAD
  ).translateToEnglish
}

export function healFileTranscriptionSettings(
  settings: FileTranscriptionSettings,
  context: FileTranscriptionHealContext,
  availability: DictationAvailability
): FileTranscriptionSettingsHealResult {
  const next: FileTranscriptionSettings = { ...settings }
  const announcements: SettingsHealAnnouncement[] = []

  if (
    !isValidSpeechModelId(next.speechModelId) ||
    !availability.isModelAvailable(next.speechModelId)
  ) {
    const previous = modelLabel(next.speechModelId)
    next.speechModelId = context.dictationSpeechModelId
    announcements.push({
      target: 'speech_model',
      reason: 'speech_model_not_installed',
      message: `File transcription switched to ${modelLabel(next.speechModelId)} because the ${previous} weights are no longer installed.`,
    })
  }

  // Quiet, as it is for a Dictation: Parakeet always detects the language itself, and a
  // single-language Speech Model cannot take one it does not speak.
  if (!isValidTranscriptionLanguageId(next.transcriptionLanguageId)) {
    next.transcriptionLanguageId = 'auto'
  }
  next.transcriptionLanguageId = coerceTranscriptionLanguageIdForModel(
    next.speechModelId,
    next.transcriptionLanguageId
  )

  const translate = fileTranscriptionTranslateReadiness(
    next,
    context,
    availability
  )
  if (next.translateToEnglish && !translate.ready) {
    next.translateToEnglish = false
    announcements.push(
      translate.reason === 'needs_source_language'
        ? {
            target: 'translate_to_english',
            reason: 'no_translate_source_language',
            message:
              'Translate to English for files turned off because it needs a source language rather than automatic detection.',
          }
        : {
            target: 'translate_to_english',
            reason: 'model_cannot_translate',
            message: `Translate to English for files turned off because ${modelLabel(next.speechModelId)} cannot translate.`,
          }
    )
  }

  return {
    settings: next,
    announcements,
    unchanged:
      next.speechModelId === settings.speechModelId &&
      next.transcriptionLanguageId === settings.transcriptionLanguageId &&
      next.translateToEnglish === settings.translateToEnglish,
  }
}

export type FileTranscriptionSettingsWriteOutcome =
  | {
      kind: 'accepted'
      settings: FileTranscriptionSettings
      /** Collateral the patch never asked for, corrected and to be announced. */
      announcements: SettingsHealAnnouncement[]
    }
  | {
      kind: 'refused'
      /** The choices in the patch that cannot run. Nothing is written. */
      refusedTargets: SettingsHealTarget[]
      announcements: SettingsHealAnnouncement[]
    }

/**
 * The write arm for the File Transcription Settings, with the same rule as
 * `applyRunnableDictationPatch`: validate the object the patch would produce, refuse a patch
 * whose own request cannot run, and apply and announce a correction to a field it never
 * mentioned (switching to a Speech Model that cannot translate turns Translate off, visibly).
 *
 * Stricter than the heal pass in two places, because a write is the user standing right
 * there: a Speech Model that is not installed is refused rather than swapped for the
 * Dictation's, and a Transcription Language that is not a language, or that the Speech Model
 * cannot take, is refused rather than coerced. A patch that changes only the Speech Model
 * still has its language coerced quietly, exactly as a model switch does in Settings.
 */
export function applyFileTranscriptionSettingsPatch(
  current: FileTranscriptionSettings,
  patch: FileTranscriptionSettingsPatch,
  context: FileTranscriptionHealContext,
  availability: DictationAvailability
): FileTranscriptionSettingsWriteOutcome {
  const refuse = (target: SettingsHealTarget) => ({
    kind: 'refused' as const,
    refusedTargets: [target],
    announcements: [],
  })
  const merged: FileTranscriptionSettings = { ...current, ...patch }

  if (
    patch.speechModelId !== undefined &&
    (!isValidSpeechModelId(patch.speechModelId) ||
      !availability.isModelAvailable(patch.speechModelId))
  ) {
    return refuse('speech_model')
  }
  if (patch.transcriptionLanguageId !== undefined) {
    if (
      !isValidTranscriptionLanguageId(patch.transcriptionLanguageId) ||
      coerceTranscriptionLanguageIdForModel(
        merged.speechModelId,
        patch.transcriptionLanguageId
      ) !== patch.transcriptionLanguageId
    ) {
      // Not a heal target of its own: the language is corrected quietly, so a refused one is
      // filed under the Speech Model whose languages it falls outside.
      return refuse('speech_model')
    }
  }

  const healed = healFileTranscriptionSettings(merged, context, availability)
  const refusedTargets = healed.announcements
    .map((announcement) => announcement.target)
    .filter((target) => PATCH_OWNS_TARGET[target](patch))
  if (refusedTargets.length > 0) {
    return {
      kind: 'refused',
      refusedTargets,
      announcements: healed.announcements,
    }
  }
  return {
    kind: 'accepted',
    settings: healed.settings,
    announcements: healed.announcements,
  }
}
