/**
 * The run decision for a Dictation, in both tenses.
 *
 * `buildDictationPlan` is the future tense: it turns `(settings, availability snapshot)`
 * into a **Dictation Plan** - one value naming the Speech Model, Speech Engine, crispasr
 * backend and Transcription Language that a press will actually run, or the closed reason
 * it will run nothing. Batch Dictation and Live Transcription are one union.
 * `getDictationReadiness` is the present tense: the same rule, per capability, as plain
 * serialisable data shipped in the settings payload so the window can disable an option
 * with a sentence before anyone presses anything.
 *
 * Pure functions over `(settings, availability)` only - no filesystem, no platform probe,
 * no `modelManager` - because both the main process and the webview import this module.
 * Availability arrives as an `isModelAvailable(id)` predicate so the caller owns the
 * question of what "installed" means on its side.
 *
 * There is no substitution anywhere below, and no silent drop. A Dictation never adapts to
 * an unrunnable state: the state is kept runnable by `settings-heal.ts`, and the one case
 * that gets past it - weights deleted behind the app's back - produces a blocked plan that
 * names its reason and starts nothing.
 *
 * See docs/adr/0005-no-runtime-fallbacks-for-dictation.md.
 */

import { HVISKE_CRISPASR_BACKEND, type CrispasrBackendId } from './asr-harness'
import {
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  HVISKE_TRANSCRIPTION_LANGUAGE_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isHviskeSpeechModelId,
  parakeetSupportsTranscriptionLanguageId,
  supportsStreamMode,
  type SpeechEngineId,
} from './speech-models'
import { whisperCodeForTranscriptionId } from './transcription-languages'

/**
 * Everything outside the settings object that decides whether a Dictation can run: which
 * Speech Model weights are on disk, and whether this platform ships the Live Transcription
 * plumbing at all (the Parakeet helper is macOS and Windows; Linux is not there yet).
 *
 * Availability arrives as a predicate rather than a map so the caller owns what "installed"
 * means on its side - the main process asks `modelManager`, the webview reads the
 * availability map it was shipped.
 *
 * This is the "availability snapshot" half of the `(settings, availability)` pair that
 * ADR-0005 names. The Dictation Plan builder takes it, and so does the heal pass in
 * settings-heal.ts. Note what is deliberately absent: Parakeet warmup is persisted settings
 * state, not availability, and it is no reason to call a configuration unrunnable.
 */
export interface DictationAvailability {
  isModelAvailable: (speechModelId: string) => boolean
  streamSupported: boolean
}

/**
 * Speech Models that support the `-tr` (translate to English) flag, in catalog order.
 * English-only and turbo Whisper models cannot, and neither Parakeet nor hviske can.
 */
export const TRANSLATE_CAPABLE_MODEL_IDS: string[] = SPEECH_MODELS.filter(
  (m) => m.engine === 'whisper_cpp' && m.translationSupport
).map((m) => m.id)

/** Offered for download when Translate to English is wanted and nothing can serve it. */
export const DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID = 'small-q5_1'

export function isTranslateCapableModelId(id: string): boolean {
  return TRANSLATE_CAPABLE_MODEL_IDS.includes(id)
}

/**
 * Whether a translate run can load the Speech Model the user actually selected.
 *
 * The whole of translate resolution. There used to be a `resolveTranslateModelId` that
 * returned a *different* Speech Model - an hviske selection resolved to the first installed
 * translate-capable Whisper model, because "Translate to English plus hviske" was an
 * offerable combination that had to be made to work somehow. ADR-0005 stops offering it, so
 * there is nothing left to resolve: either the selection can translate and its weights are
 * on disk, or translate does not run.
 */
export function isTranslateRunnableForSelection(
  selectedSpeechModelId: string,
  isModelAvailable: (id: string) => boolean
): boolean {
  return (
    isTranslateCapableModelId(selectedSpeechModelId) &&
    isModelAvailable(selectedSpeechModelId)
  )
}

export function hasAnyTranslateCapableModelAvailable(
  isModelAvailable: (id: string) => boolean
): boolean {
  return TRANSLATE_CAPABLE_MODEL_IDS.some((id) => isModelAvailable(id))
}

export function isStreamCapableModelId(id: string): boolean {
  const m = getSpeechModel(id)
  return m != null && supportsStreamMode(m)
}

/** The Speech Model's user-facing name, or the raw id when the catalog has never heard of it. */
function modelLabel(speechModelId: string): string {
  return getSpeechModel(speechModelId)?.label ?? speechModelId
}

const PARAKEET_LABEL = modelLabel(DEFAULT_STREAM_CAPABLE_MODEL_ID)

/**
 * The settings readiness depends on. Deliberately not the whole settings object and
 * deliberately not `RunnableDictationSettings` (which lives one module up and imports this
 * one): a `RunnableDictationSettings` satisfies it structurally, so `AppConfig` passes the
 * one it already builds.
 *
 * Note what is absent: `translateToEnglish` and `streamMode`. Readiness is "can this run",
 * not "is this on", and mixing the two is how a component ends up deciding for itself.
 */
export interface DictationReadinessInput {
  speechModelId: string
  transcriptionLanguageId: string
  translateDefaultLanguageId: string
  /** Parakeet has finished its one-time on-device preparation. */
  parakeetCoreMlReady: boolean
}

/**
 * Why Translate to English cannot run. Closed union, so a new way for it to be unavailable
 * cannot arrive without `tsc` demanding a sentence for it.
 */
export type TranslateReadinessReason =
  /** hviske is selected: Danish-only GGUF weights that cannot translate at all. */
  | 'hviske_selected'
  /** A turbo, English-only or Parakeet selection: translation is not in the weights. */
  | 'model_cannot_translate'
  /** The selection could translate, but its weights are not on disk. */
  | 'model_not_installed'
  /** Translating from automatic detection is not a thing whisper.cpp can do. */
  | 'needs_source_language'

/** Why Live Transcription cannot run. Closed union, same contract. */
export type StreamModeReadinessReason =
  /** No Parakeet plumbing on this platform yet. */
  | 'unsupported_platform'
  | 'parakeet_not_installed'
  | 'model_cannot_stream'
  | 'language_not_supported'

/**
 * One capability, decided. Plain data: it rides the settings payload across the Electrobun
 * RPC bridge, so no functions and no class instances.
 *
 * `message` is a finished sentence written here rather than in the window, for the same
 * reason `SettingsHealAnnouncement.message` is: the rule and the wording it justifies drift
 * apart the moment they live in different files.
 */
export type CapabilityReadiness<Reason extends string> =
  | {
      /** Runnable right now, exactly as configured. */
      ready: true
      reason: null
      /** One finished sentence, shown to the user as written. */
      message: string
      downloadModelId: null
    }
  | {
      ready: false
      /** Why not. Discriminated on `ready`, so a reader cannot forget to check. */
      reason: Reason
      /** One finished sentence, shown to the user as written. */
      message: string
      /**
       * The Speech Model whose download would unblock this capability, or `null` when no
       * download helps and the user has to change the configuration instead. This is what
       * lets the UI offer a way forward rather than only refusing.
       */
      downloadModelId: string | null
    }

export type TranslateReadiness = CapabilityReadiness<TranslateReadinessReason>
export type StreamModeReadiness = CapabilityReadiness<StreamModeReadinessReason>

/** What the webview is shipped, and the whole of what it knows about what can run. */
export interface DictationReadiness {
  translateToEnglish: TranslateReadiness
  liveTranscription: StreamModeReadiness
}

function translateReadiness(
  input: DictationReadinessInput,
  availability: DictationAvailability
): TranslateReadiness {
  const selected = input.speechModelId
  const selectedLabel = modelLabel(selected)

  // hviske before the general capability check, because "Danish-only weights" is a better
  // sentence than "cannot translate" and because this is the combination ADR-0005 stops
  // offering. It used to appear to work by loading a Whisper model the user never chose.
  if (isHviskeSpeechModelId(selected)) {
    return {
      ready: false,
      reason: 'hviske_selected',
      message: `Translate to English is unavailable while ${selectedLabel} is selected: its Danish weights cannot translate. Switch to a Whisper Small or Large Speech Model.`,
      downloadModelId: null,
    }
  }

  if (!isTranslateCapableModelId(selected)) {
    const canSwitchToInstalled = hasAnyTranslateCapableModelAvailable(
      availability.isModelAvailable
    )
    return {
      ready: false,
      reason: 'model_cannot_translate',
      message: canSwitchToInstalled
        ? `${selectedLabel} cannot translate to English. Switch to an installed Whisper Small or Large Speech Model.`
        : `${selectedLabel} cannot translate to English. Download ${modelLabel(DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID)} to use it.`,
      downloadModelId: canSwitchToInstalled
        ? null
        : DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID,
    }
  }

  if (!availability.isModelAvailable(selected)) {
    return {
      ready: false,
      reason: 'model_not_installed',
      message: `Translate to English needs the ${selectedLabel} weights, which are not installed. Download them to use it.`,
      downloadModelId: selected,
    }
  }

  if (
    input.transcriptionLanguageId === 'auto' &&
    input.translateDefaultLanguageId === 'auto'
  ) {
    return {
      ready: false,
      reason: 'needs_source_language',
      message:
        'Translate to English needs a source language rather than automatic detection. Choose one below.',
      downloadModelId: null,
    }
  }

  return {
    ready: true,
    reason: null,
    message: 'Translate mode: transcribe and translate to English.',
    downloadModelId: null,
  }
}

function streamModeReadiness(
  input: DictationReadinessInput,
  availability: DictationAvailability
): StreamModeReadiness {
  if (!availability.streamSupported) {
    return {
      ready: false,
      reason: 'unsupported_platform',
      message: 'Live transcription is not available on this platform yet.',
      downloadModelId: null,
    }
  }

  if (!availability.isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID)) {
    return {
      ready: false,
      reason: 'parakeet_not_installed',
      message: `Live transcription needs the ${PARAKEET_LABEL} weights. Download them to use it.`,
      downloadModelId: DEFAULT_STREAM_CAPABLE_MODEL_ID,
    }
  }

  if (!isStreamCapableModelId(input.speechModelId)) {
    return {
      ready: false,
      reason: 'model_cannot_stream',
      message: `${modelLabel(input.speechModelId)} cannot run live transcription. Switch to ${PARAKEET_LABEL}.`,
      downloadModelId: null,
    }
  }

  if (!parakeetSupportsTranscriptionLanguageId(input.transcriptionLanguageId)) {
    return {
      ready: false,
      reason: 'language_not_supported',
      message: `${PARAKEET_LABEL} does not support the selected transcription language.`,
      downloadModelId: null,
    }
  }

  // A cold Parakeet is ready, and its preparation is already running: selecting Parakeet
  // starts it. Warmup was a readiness reason nobody could act on, and ADR-0005 takes it out
  // of the user-facing set rather than dressing it up as unavailability. What is left is a
  // fact, and it stops being said the moment the preparation reports done - the settings push
  // recomputes this, so the copy corrects itself with no restart and no second attempt.
  return {
    ready: true,
    reason: null,
    message: input.parakeetCoreMlReady
      ? 'Live transcription: continuous dictation.'
      : `Live transcription: continuous dictation. ${PARAKEET_LABEL} is preparing itself on this device; a dictation started before it finishes waits for it.`,
    downloadModelId: null,
  }
}

/**
 * The single answer to "what can run right now", for every surface that asks.
 *
 * Computed in the main process (`AppConfig.getSettings`) and shipped whole, because the
 * availability half of the pair is a filesystem question the window cannot ask and a
 * predicate that cannot cross the RPC bridge. Recomputed on every settings push, which is
 * what keeps it live when a Speech Model is downloaded or deleted.
 */
export function getDictationReadiness(
  input: DictationReadinessInput,
  availability: DictationAvailability
): DictationReadiness {
  return {
    translateToEnglish: translateReadiness(input, availability),
    liveTranscription: streamModeReadiness(input, availability),
  }
}

// ── The Dictation Plan ──────────────────────────────────────────────────────────
//
// Everything above answers "is this option available". Everything below answers "what does
// this press run", which is the same rule with the toggles applied. They share the
// predicates deliberately: two functions expressing one rule is the shape that drifts, and
// dictation-plan.test.ts pins them against each other.

/**
 * Batch Dictation records to a file and transcribes it once; Live Transcription streams
 * into the Parakeet Native Helper, which captures and pastes for itself. One union rather
 * than two, because the shortcut press has to pick between them and every surface that
 * reports a Dictation has to report either.
 */
export type DictationMode = 'batch' | 'live'

/**
 * The settings a Dictation Plan is built from. Deliberately not the whole settings object:
 * nothing else in `AppSettings` can change what runs.
 *
 * A `RunnableDictationSettings` (settings-heal.ts, one module up) satisfies this
 * structurally, which is how `AppConfig` passes the object it already builds without this
 * module importing the one that imports it.
 */
export interface DictationPlanInput {
  speechModelId: string
  transcriptionLanguageId: string
  translateDefaultLanguageId: string
  translateToEnglish: boolean
  streamMode: boolean
}

/**
 * Why a Dictation will not run. Closed union: a new failure mode cannot join a generic
 * bucket, because `BLOCKED_MESSAGES` below is an exhaustive `Record` over it and `tsc`
 * refuses to compile a member without a sentence.
 *
 * Seven of the eight share their names with `SettingsHealReason`, on purpose - a blocked
 * plan and the heal that follows it are the same fact in two tenses ("this cannot run" and
 * "this was switched off"), so they should not need a translation table between them.
 */
export type DictationBlockedReason =
  /** The selected Speech Model's weights are not on disk, or the id is not in the catalog. */
  | 'speech_model_not_installed'
  /** Translate to English is on and the selection cannot translate: turbo, English-only, Parakeet or hviske. */
  | 'model_cannot_translate'
  /** Translate to English is on with automatic detection on both language settings. */
  | 'no_translate_source_language'
  /** No Parakeet plumbing on this platform yet. */
  | 'live_transcription_unsupported_platform'
  | 'parakeet_not_installed'
  | 'model_cannot_stream'
  | 'language_not_supported_by_parakeet'
  /**
   * The Parakeet Native Helper binary is missing from the installation. Only the pre-spawn
   * check can see this - it is a packaging fault, not a settings state, so no availability
   * snapshot reaches it.
   */
  | 'parakeet_helper_missing'

/** A Dictation that will run, exactly as described. Nothing downstream re-derives a field. */
export interface RunnableDictationPlan {
  status: 'runnable'
  mode: DictationMode
  /** The Speech Model that loads. Always the user's selection: nothing substitutes. */
  speechModelId: string
  /** The Speech Engine that runs it. `whisperkit` is the id; the engine is FluidAudio. */
  engineId: SpeechEngineId
  /** crispasr `--backend` to pin, or `null` for the default backend. hviske needs `cohere`. */
  crispasrBackend: CrispasrBackendId | null
  /**
   * The Transcription Language the run actually uses, which is what stats record. Not always
   * the setting: an hviske run is pinned to Danish, and a translate run from automatic
   * detection uses the translate default as its source language.
   */
  transcriptionLanguageId: string
  /** The whisper.cpp language token, or `null` for automatic detection. */
  languageCode: string | null
  /** Whether the run passes `-tr`. Never true on a live plan. */
  translateToEnglish: boolean
}

/**
 * A Dictation that will not run, and the sentence to say so.
 *
 * Plain data with no functions, so it rides the settings payload across the Electrobun RPC
 * bridge into the in-window banner, and the same `message` goes into the notification when
 * no window is open.
 */
export interface BlockedDictationPlan {
  status: 'blocked'
  /** What the user asked for, so the report can name Live Transcription rather than "dictation". */
  mode: DictationMode
  reason: DictationBlockedReason
  /** One finished sentence, shown to the user as written. */
  message: string
}

export type DictationPlan = RunnableDictationPlan | BlockedDictationPlan

/**
 * One sentence per blocked reason, written here rather than at the four surfaces that show
 * it (error sound aside: tray, notification, banner, log). Exhaustive by construction - add
 * a reason to the union and this stops compiling until it has a sentence.
 */
const BLOCKED_MESSAGES: Record<
  DictationBlockedReason,
  (speechModelLabel: string) => string
> = {
  speech_model_not_installed: (label) =>
    `Dictation stopped because the ${label} weights are no longer installed. The Speech Model selection has been reset, so the next press works.`,
  model_cannot_translate: (label) =>
    `Dictation stopped because Translate to English is on and ${label} cannot translate. Translate to English has been turned off, so the next press works.`,
  no_translate_source_language: () =>
    'Dictation stopped because Translate to English needs a source language rather than automatic detection. Choose one in Settings, or turn Translate to English off.',
  live_transcription_unsupported_platform: () =>
    'Live transcription cannot start because this platform cannot run it yet. It has been turned off, so the next press dictates normally.',
  parakeet_not_installed: () =>
    `Live transcription cannot start because the ${PARAKEET_LABEL} weights are no longer installed. Download them in Settings to use it again.`,
  model_cannot_stream: (label) =>
    `Live transcription cannot start because ${label} cannot run it. Switch to ${PARAKEET_LABEL}, or turn live transcription off.`,
  language_not_supported_by_parakeet: () =>
    `Live transcription cannot start because ${PARAKEET_LABEL} does not support the selected transcription language.`,
  parakeet_helper_missing: () =>
    `Live transcription cannot start because the ${PARAKEET_LABEL} helper is missing from this installation. Reinstalling Codictate restores it.`,
}

/**
 * The one constructor for a blocked plan, so the sentence and the reason cannot be paired up
 * differently in two places. Exported because the pre-spawn race check in
 * `parakeet-stream-runner.ts` produces one too: it runs after the plan is built, in the gap
 * where a race lands, and ADR-0005 keeps it for exactly that reason - but it reports in
 * plan shape instead of throwing an `Error` that its caller discarded.
 */
export function blockedDictationPlan(
  mode: DictationMode,
  reason: DictationBlockedReason,
  speechModelId: string
): BlockedDictationPlan {
  return {
    status: 'blocked',
    mode,
    reason,
    message: BLOCKED_MESSAGES[reason](modelLabel(speechModelId)),
  }
}

/**
 * The Transcription Language a batch run actually uses.
 *
 * whisper.cpp cannot translate from automatic detection, so a translate run falls back to
 * the translate default when the Transcription Language is `auto`. This is a *language*
 * choice the user made in Settings, not a Speech Model substitution - and the plan carries
 * the answer so stats record the language that ran rather than the one selected afterwards.
 */
function runTranscriptionLanguageId(input: DictationPlanInput): string {
  if (!input.translateToEnglish) return input.transcriptionLanguageId
  return input.transcriptionLanguageId !== 'auto'
    ? input.transcriptionLanguageId
    : input.translateDefaultLanguageId
}

/**
 * The whole run decision, as one value.
 *
 * Called on every press of the Dictation Shortcut (`AppConfig.getDictationPlan()`), and the
 * only thing that decides what a Dictation does. The settings are already kept runnable by
 * `healDictationSettings`, so a blocked plan means the world changed underneath them -
 * weights deleted in Finder, a failed disk, a cloud-storage eviction. That is why a blocked
 * plan is reported *and* triggers the heal pass rather than only being reported: the press
 * is the app's first notice, and the next press has to work.
 */
export function buildDictationPlan(
  input: DictationPlanInput,
  availability: DictationAvailability
): DictationPlan {
  const selected = input.speechModelId
  const mode: DictationMode = input.streamMode ? 'live' : 'batch'
  const blocked = (reason: DictationBlockedReason) =>
    blockedDictationPlan(mode, reason, selected)

  if (mode === 'live') {
    // Same order as `streamModeReadiness`: platform, then weights, then selection, then
    // language. The platform question first because nothing below it can be true without it.
    if (!availability.streamSupported) {
      return blocked('live_transcription_unsupported_platform')
    }
    if (!availability.isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID)) {
      return blocked('parakeet_not_installed')
    }
    if (!isStreamCapableModelId(selected)) {
      return blocked('model_cannot_stream')
    }
    if (!availability.isModelAvailable(selected)) {
      return blocked('speech_model_not_installed')
    }
    if (
      !parakeetSupportsTranscriptionLanguageId(input.transcriptionLanguageId)
    ) {
      return blocked('language_not_supported_by_parakeet')
    }
    return {
      status: 'runnable',
      mode,
      speechModelId: selected,
      engineId: getSpeechModel(selected)?.engine ?? 'whisperkit',
      crispasrBackend: null,
      transcriptionLanguageId: input.transcriptionLanguageId,
      // Parakeet detects the language itself and takes no language argument, and Translate
      // to English is a whisper.cpp flag with no live equivalent.
      languageCode: null,
      translateToEnglish: false,
    }
  }

  const model = getSpeechModel(selected)
  if (model === undefined || !availability.isModelAvailable(selected)) {
    return blocked('speech_model_not_installed')
  }

  if (input.translateToEnglish) {
    if (
      !isTranslateRunnableForSelection(selected, availability.isModelAvailable)
    ) {
      return blocked('model_cannot_translate')
    }
    if (
      input.transcriptionLanguageId === 'auto' &&
      input.translateDefaultLanguageId === 'auto'
    ) {
      return blocked('no_translate_source_language')
    }
  }

  // hviske GGUF weights load under the crispasr `cohere` backend alone and are Danish only,
  // so both are pinned to the Speech Model rather than taken from the user's Transcription
  // Language. With the translate swap gone, the Speech Model that runs is always the one
  // selected, so nothing can inherit a pin that belongs to a different Speech Model.
  const isHviskeRun = isHviskeSpeechModelId(selected)
  const transcriptionLanguageId = isHviskeRun
    ? HVISKE_TRANSCRIPTION_LANGUAGE_ID
    : runTranscriptionLanguageId(input)

  return {
    status: 'runnable',
    mode,
    speechModelId: selected,
    engineId: model.engine,
    crispasrBackend: isHviskeRun ? HVISKE_CRISPASR_BACKEND : null,
    transcriptionLanguageId,
    languageCode:
      model.engine === 'whisperkit'
        ? null
        : whisperCodeForTranscriptionId(transcriptionLanguageId),
    translateToEnglish: input.translateToEnglish,
  }
}
