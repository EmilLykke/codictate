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
  getStreamModeReadiness,
  isTranslateRunnableForSelection,
  type DictationAvailability,
} from './dictation-plan'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  getSpeechModel,
  isValidSpeechModelId,
} from './speech-models'

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
  /** Parakeet has finished its one-time on-device preparation. */
  parakeetCoreMlReady: boolean
}

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

function modelLabel(speechModelId: string): string {
  return getSpeechModel(speechModelId)?.label ?? speechModelId
}

const PARAKEET_LABEL = modelLabel(DEFAULT_STREAM_CAPABLE_MODEL_ID)

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

  // Quiet: warmup is a fact about installed weights, so it cannot outlive them. Deleting
  // Parakeet and downloading it again has to prepare the new copy.
  if (
    next.parakeetCoreMlReady &&
    !availability.isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID)
  ) {
    next.parakeetCoreMlReady = false
  }

  if (next.translateToEnglish) {
    // Deliberately not `getTranslateReadiness`: that still reports `ready` for an hviske
    // selection whenever some other translate-capable Speech Model happens to be installed,
    // via the runtime swap ADR-0005 removes. Applying the collapsed rule here is what makes
    // that state unreachable, so the swap has nothing left to catch when it goes.
    if (
      !isTranslateRunnableForSelection(
        next.speechModelId,
        availability.isModelAvailable
      )
    ) {
      next.translateToEnglish = false
      announce(
        'translate_to_english',
        'model_cannot_translate',
        `Translate to English turned off because ${modelLabel(next.speechModelId)} cannot translate.`
      )
    } else if (
      next.transcriptionLanguageId === 'auto' &&
      next.translateDefaultLanguageId === 'auto'
    ) {
      next.translateToEnglish = false
      announce(
        'translate_to_english',
        'no_translate_source_language',
        'Translate to English turned off because it needs a source language rather than automatic detection.'
      )
    }
  }

  if (next.streamMode) {
    if (!availability.streamSupported) {
      next.streamMode = false
      announce(
        'live_transcription',
        'live_transcription_unsupported_platform',
        'Live transcription turned off because this platform cannot run it yet.'
      )
    } else {
      const readiness = getStreamModeReadiness(
        next.speechModelId,
        next.transcriptionLanguageId,
        availability.isModelAvailable,
        next.parakeetCoreMlReady
      )
      switch (readiness.kind) {
        case 'need_parakeet_download':
          next.streamMode = false
          announce(
            'live_transcription',
            'parakeet_not_installed',
            `Live transcription turned off because the ${PARAKEET_LABEL} weights are no longer installed.`
          )
          break
        case 'need_switch_model':
          next.streamMode = false
          announce(
            'live_transcription',
            'model_cannot_stream',
            `Live transcription turned off because ${modelLabel(next.speechModelId)} cannot run it.`
          )
          break
        case 'need_language':
          next.streamMode = false
          announce(
            'live_transcription',
            'language_not_supported_by_parakeet',
            `Live transcription turned off because ${PARAKEET_LABEL} does not support the selected transcription language.`
          )
          break
        case 'need_warmup':
        case 'ready':
          // Warmup is transient state the user cannot act on, and a cold Parakeet run
          // prepares itself, so it is not a reason to switch anything off. ADR-0005 takes
          // it out of the user-facing set entirely.
          break
      }
    }
  }

  return {
    settings: next,
    announcements,
    unchanged:
      next.speechModelId === settings.speechModelId &&
      next.transcriptionLanguageId === settings.transcriptionLanguageId &&
      next.translateDefaultLanguageId === settings.translateDefaultLanguageId &&
      next.translateToEnglish === settings.translateToEnglish &&
      next.streamMode === settings.streamMode &&
      next.parakeetCoreMlReady === settings.parakeetCoreMlReady,
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
