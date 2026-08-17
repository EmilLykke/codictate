/**
 * The run decision for a Dictation: which Speech Model a translate run actually loads, and
 * whether Translate to English or Live Transcription can run at all.
 *
 * Pure functions over `(settings, availability)` only - no filesystem, no platform probe,
 * no `modelManager` - because both the main process and the webview import this module.
 * Availability arrives as an `isModelAvailable(id)` predicate so the caller owns the
 * question of what "installed" means on its side.
 *
 * This is where the Dictation Plan lands. See
 * docs/adr/0005-no-runtime-fallbacks-for-dictation.md: the fallbacks still expressed below
 * are on their way out, and they stay only until the settings can no longer reach a state
 * that needs them.
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

export function hasAnyTranslateCapableModelAvailable(
  isModelAvailable: (id: string) => boolean
): boolean {
  return TRANSLATE_CAPABLE_MODEL_IDS.some((id) => isModelAvailable(id))
}

export type TranslateReadiness =
  | { kind: 'ready' }
  | { kind: 'need_download' }
  | { kind: 'need_switch_model' }
  | { kind: 'need_language' }

export function getTranslateReadiness(
  speechModelId: string,
  transcriptionLanguageId: string,
  translateDefaultLanguageId: string,
  isModelAvailable: (id: string) => boolean
): TranslateReadiness {
  const langOk =
    transcriptionLanguageId !== 'auto' || translateDefaultLanguageId !== 'auto'
  if (!langOk) {
    return { kind: 'need_language' }
  }

  if (resolveTranslateModelId(speechModelId, isModelAvailable) !== null) {
    return { kind: 'ready' }
  }

  if (isTranslateCapableModelId(speechModelId)) {
    return { kind: 'need_download' }
  }

  if (hasAnyTranslateCapableModelAvailable(isModelAvailable)) {
    return { kind: 'need_switch_model' }
  }

  return { kind: 'need_download' }
}

export function isStreamCapableModelId(id: string): boolean {
  const m = getSpeechModel(id)
  return m != null && supportsStreamMode(m)
}

export type StreamModeReadiness =
  | { kind: 'ready' }
  | { kind: 'need_parakeet_download' }
  | { kind: 'need_switch_model' }
  | { kind: 'need_language' }
  | { kind: 'need_warmup' }

/** Whether stream (Parakeet) dictation can be enabled with the given config. */
export function getStreamModeReadiness(
  speechModelId: string,
  transcriptionLanguageId: string,
  isModelAvailable: (id: string) => boolean,
  parakeetCoreMlReady: boolean
): StreamModeReadiness {
  if (!isModelAvailable(DEFAULT_STREAM_CAPABLE_MODEL_ID)) {
    return { kind: 'need_parakeet_download' }
  }
  if (!isStreamCapableModelId(speechModelId)) {
    return { kind: 'need_switch_model' }
  }
  if (!parakeetSupportsTranscriptionLanguageId(transcriptionLanguageId)) {
    return { kind: 'need_language' }
  }
  if (!parakeetCoreMlReady) {
    return { kind: 'need_warmup' }
  }
  return { kind: 'ready' }
}
