/**
 * The run decision for a Dictation: which Speech Model a translate run actually loads, and
 * whether Translate to English or Live Transcription can run at all.
 *
 * Pure functions over `(settings, availability)` only - no filesystem, no platform probe,
 * no `modelManager` - because both the main process and the webview import this module.
 * Availability arrives as an `isModelAvailable(id)` predicate so the caller owns the
 * question of what "installed" means on its side.
 *
 * This is where the Dictation Plan lands, and it is the only place that answers "can this
 * run right now". `getDictationReadiness` is that answer as a plain serialisable value:
 * the main process computes it once, ships it in the settings payload, and the webview
 * renders it. Nothing downstream re-derives it - not the heal pass, not a component.
 *
 * See docs/adr/0005-no-runtime-fallbacks-for-dictation.md: the fallbacks still expressed
 * below are on their way out, and they stay only until the settings can no longer reach a
 * state that needs them.
 */

import {
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isHviskeSpeechModelId,
  parakeetSupportsTranscriptionLanguageId,
  supportsStreamMode,
} from './speech-models'

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
 * ADR-0005 names. The heal pass in settings-heal.ts takes it, and so will the Dictation
 * Plan builder. Note what is deliberately absent: Parakeet warmup is persisted settings
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

/** The first installed translate-capable Speech Model, in catalog order. */
function firstAvailableTranslateCapableModelId(
  isModelAvailable: (id: string) => boolean
): string | null {
  return TRANSLATE_CAPABLE_MODEL_IDS.find((id) => isModelAvailable(id)) ?? null
}

/**
 * The Speech Model a translate run should actually load, or `null` when translate is not
 * possible at all and the caller must transcribe verbatim instead.
 *
 * Usually that is the selected model itself, once it is both translate-capable and
 * installed. hviske is the one selection that resolves to a *different* model: its GGUF
 * weights are Danish-only, load under the crispasr `cohere` backend alone, and cannot
 * translate. Because hviske is user-selectable, "Translate to English" plus an hviske
 * Speech Model is an ordinary combination, and it has to swap the Speech Model rather than
 * fail mid-Dictation. (`large-v3-turbo` is the same shape of problem for a different
 * reason - a transcribe-only distillation - and is simply absent from
 * TRANSLATE_CAPABLE_MODEL_IDS.)
 *
 * A caller that gets back an id different from the one it passed must run it as its own
 * Speech Model and drop anything specific to the selection it replaced - hviske's pinned
 * `--backend cohere` and pinned Danish language above all.
 *
 * The hviske swap is a runtime fallback that ADR-0005 removes: once Translate to English
 * cannot be turned on under an hviske selection, this collapses to "is the selected Speech
 * Model translate-capable and installed".
 */
export function resolveTranslateModelId(
  selectedSpeechModelId: string,
  isModelAvailable: (id: string) => boolean
): string | null {
  if (isHviskeSpeechModelId(selectedSpeechModelId)) {
    return firstAvailableTranslateCapableModelId(isModelAvailable)
  }
  if (!isTranslateCapableModelId(selectedSpeechModelId)) {
    return null
  }
  if (!isModelAvailable(selectedSpeechModelId)) {
    return null
  }
  return selectedSpeechModelId
}

/**
 * Whether a translate run can load the Speech Model the user actually selected.
 *
 * This is what `resolveTranslateModelId` collapses to under ADR-0005 once the hviske swap
 * and the "first installed translate-capable model" search are gone: no substitution, so
 * the only question left is whether the selection itself can do the job. The heal pass
 * enforces this now, which is what makes the swap unreachable ahead of the change that
 * deletes it.
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

  // A cold Parakeet is ready, just slow the first time: the run prepares itself. Warmup was
  // a readiness reason nobody could act on, and ADR-0005 takes it out of the user-facing
  // set rather than dressing it up as unavailability.
  return {
    ready: true,
    reason: null,
    message: input.parakeetCoreMlReady
      ? 'Live transcription: continuous dictation.'
      : `Live transcription: continuous dictation. The first run takes a moment while ${PARAKEET_LABEL} prepares itself on this device.`,
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
