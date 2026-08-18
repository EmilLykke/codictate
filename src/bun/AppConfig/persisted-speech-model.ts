/**
 * Reading the selected Speech Model out of a persisted config file.
 *
 * One function, in its own module for one reason: `AppConfig.ts` cannot be imported without
 * its paths, its `modelManager` and its logger, so anything that lives in it cannot be
 * tested without a filesystem. This is the field a rename moved, on a config file written by
 * an older build, and getting it wrong resets a user's Speech Model to the default without
 * saying so - which is exactly the class of silent substitution ADR-0005 exists to remove.
 */

import { isValidSpeechModelId } from '../../shared/speech-models'

/** The current key. */
const SPEECH_MODEL_KEY = 'speechModelId'

/**
 * The pre-rename key, read but never written.
 *
 * It was renamed because it never held a whisper-only id: hviske and Parakeet selections
 * lived there too. Configs written by an older build keep it, so it is read for as long as
 * those exist on disk; the first `saveMain()` after a load persists the current key and the
 * old one drops out of the file.
 */
const LEGACY_SPEECH_MODEL_KEY = 'whisperModelId'

/**
 * The selected Speech Model id from a raw persisted config, or `null` when the file names
 * none this build recognises - in which case the caller keeps its default.
 *
 * An id that is not in the catalog is `null` rather than an error: weights can be dropped
 * from the catalog between versions, and the heal pass is what corrects the selection.
 */
export function persistedSpeechModelId(
  raw: Record<string, unknown>
): string | null {
  const current = raw[SPEECH_MODEL_KEY]
  const legacy = raw[LEGACY_SPEECH_MODEL_KEY]
  const found =
    typeof current === 'string'
      ? current
      : typeof legacy === 'string'
        ? legacy
        : null
  if (found === null) return null
  return isValidSpeechModelId(found) ? found : null
}
