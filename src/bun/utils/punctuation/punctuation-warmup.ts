/**
 * The Punctuation Model's background load: the first punctuated Dictation after launch
 * should be as fast as the rest (about 250 ms of load moved off the press).
 *
 * The load runs whenever Punctuation Restoration is reachable: a Batch Dictation or a File
 * Transcription with the current selections would restore punctuation. That is the Dictation
 * Plan's own `punctuationRestoration` rule, asked about both selections, so the warm-up and
 * the run cannot disagree about when restoration happens (hviske with Add punctuation on,
 * later the ekko Speech Engine). A selection whose plan is blocked reaches nothing.
 *
 * The trigger is `AppConfig.observeRunnableDictationSettings`, which fires at launch and on
 * every settle of the settings and availability. Asking again is cheap: the Punctuation
 * Restorer loads once, a call during a load joins it, and a failed load is tried again on
 * the next call.
 */

import {
  buildDictationPlan,
  type DictationAvailability,
  type DictationPlanInput,
} from '../../../shared/dictation-plan'
import { log as appLog } from '../logger'
import type { PunctuationRestorer } from './punctuation-restorer'

/** Would a run with any of these selections restore punctuation. */
export function isPunctuationRestorationReachable(
  selections: readonly DictationPlanInput[],
  availability: DictationAvailability
): boolean {
  return selections.some((selection) => {
    const plan = buildDictationPlan(selection, availability)
    return plan.status === 'runnable' && plan.punctuationRestoration
  })
}

export interface PunctuationWarmupOptions {
  restorer: Pick<PunctuationRestorer, 'warmUp'>
  /** `AppConfig.isPunctuationRestorationReachable`, asked on every call. */
  isReachable: () => boolean
  log?: typeof appLog
}

/** Returns `ensureWarm`: start the background load if restoration is reachable. Never throws. */
export function createPunctuationWarmup(
  options: PunctuationWarmupOptions
): () => void {
  const log = options.log ?? appLog
  return () => {
    let reachable: boolean
    try {
      reachable = options.isReachable()
    } catch (error) {
      log('punctuation', 'could not tell whether to warm up', {
        cause: error instanceof Error ? error.message : String(error),
      })
      return
    }
    // `warmUp` never rejects; a failed load is logged inside the restorer.
    if (reachable) void options.restorer.warmUp()
  }
}
