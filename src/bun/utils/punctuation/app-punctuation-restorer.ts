/**
 * The app's one Punctuation Restorer, on the installed ekko-pnc weights.
 *
 * One per process, because the Punctuation Model is loaded once and kept for the life of the
 * process: Batch Dictation (`runDictation`), File Transcription (#97) and the background
 * warm-up (`punctuation-warmup.ts`) all share it, so a warm-up's load is the one a Dictation
 * uses. Created on first use; creating it loads nothing.
 */

import { ekkoPncModelLoader } from './ekko-pnc-model'
import { PUNCTUATION_MODEL_DIR } from './punctuation-model-files'
import {
  createPunctuationRestorer,
  type PunctuationRestorer,
} from './punctuation-restorer'

let restorer: PunctuationRestorer | null = null

export function appPunctuationRestorer(): PunctuationRestorer {
  restorer ??= createPunctuationRestorer({
    loadModel: ekkoPncModelLoader(PUNCTUATION_MODEL_DIR),
  })
  return restorer
}
