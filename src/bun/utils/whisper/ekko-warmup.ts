/**
 * ekko's background load: the first ekko Dictation after launch, after selecting ekko or after
 * its download should be about as fast as the rest.
 *
 * What it moves off the press is the first `parakeet-cli` run's setup. On the Mac that is about
 * 6.5 s of Metal shader compile the first time ever (then cached by macOS) and about half a
 * second on a later cold start; on Windows about 0.3 s (#76). So it runs `parakeet-cli` once on
 * half a second of silence (`warmUpEkko` in `engines/ekko-engine.ts`), and there is no
 * "preparing" UI.
 *
 * The rules are the ones Parakeet's background load had before Parakeet moved to loading while
 * the user speaks (commit 1fb2e76):
 *
 * - **Triggers.** Launch, ekko becoming the Dictation's selection, and its download finishing.
 *   All three arrive through `AppConfig.observeRunnableDictationSettings`, which fires at
 *   launch and on every settle of the settings and availability; a settle that leaves ekko
 *   selected and available is not a trigger, because settings writes are frequent and a broken
 *   `parakeet-cli` would otherwise be respawned on each.
 * - **Only the Dictation's selection.** Asked of the Dictation Plan: ekko, runnable (GGUF and
 *   ekko-pnc on disk). A File Transcription selection starts nothing; a File Transcription pays
 *   the setup in its own Processing Time.
 * - **One load in flight**, held in one promise that never rejects.
 * - **A failure is logged, not reported**, and the next trigger tries again.
 * - **A Dictation waits for a load in flight**, bounded (`awaitEkkoWarmup`), so it never runs a
 *   second cold `parakeet-cli` beside it.
 */

import type { DictationPlan } from '../../../shared/dictation-plan'
import { EKKO_ENGINE_ID } from '../../../shared/speech-models'
import { log as appLog } from '../logger'
import { ENGINE_PROCESS_CLEANUP_GRACE_MS } from './engines/process-supervisor'

/** How long one warm-up `parakeet-cli` may run before it is killed. */
export const EKKO_WARMUP_TIMEOUT_MS = 60_000

/**
 * How long a Dictation waits for a warm-up in flight before running anyway: the warm-up's own
 * bound plus the supervisor's cleanup grace, as Parakeet's wait was. Past it a wedged warm-up
 * costs one slow Dictation, not all of them.
 */
export const EKKO_WARMUP_WAIT_MS =
  EKKO_WARMUP_TIMEOUT_MS + ENGINE_PROCESS_CLEANUP_GRACE_MS

/** What a warm-up loads. */
export interface EkkoWarmupTarget {
  speechModelId: string
}

/** The Dictation's plan runs ekko: the one case a warm-up is for. */
export function ekkoWarmupTarget(plan: DictationPlan): EkkoWarmupTarget | null {
  return plan.status === 'runnable' && plan.engineId === EKKO_ENGINE_ID
    ? { speechModelId: plan.speechModelId }
    : null
}

export interface EkkoWarmupOptions {
  /** The Dictation's plan right now (`AppConfig.getDictationPlan`). */
  dictationPlan: () => DictationPlan
  /** One warm-up run. Rejects on failure. */
  load: (target: EkkoWarmupTarget) => Promise<void>
  log?: typeof appLog
}

export interface EkkoWarmup {
  /** Start a load if this settle is a trigger. Cheap, never throws. */
  ensureWarm(): void
  /** The load running right now, or null. Never rejects. */
  readonly inFlight: Promise<void> | null
  /** Resolves when the load in flight ends, or after `boundMs`; at once when there is none. */
  whenLoaded(boundMs: number): Promise<void>
}

export function createEkkoWarmup(options: EkkoWarmupOptions): EkkoWarmup {
  const log = options.log ?? appLog
  let inFlight: Promise<void> | null = null
  /** The Speech Model that was ekko and runnable at the previous settle, or null. */
  let loadableModelId: string | null = null

  const run = async (target: EkkoWarmupTarget): Promise<void> => {
    const startedAt = performance.now()
    try {
      await options.load(target)
      log('ekko', 'warm-up complete', {
        speechModelId: target.speechModelId,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    } catch (err) {
      // Logged, not reported: the Dictation itself still runs, just without the head start.
      // Nothing is remembered about the failure, so the next trigger simply tries again.
      log('ekko', 'warm-up failed', {
        speechModelId: target.speechModelId,
        elapsedMs: Math.round(performance.now() - startedAt),
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight = null
    }
  }

  return {
    get inFlight() {
      return inFlight
    },
    ensureWarm() {
      let target: EkkoWarmupTarget | null
      try {
        target = ekkoWarmupTarget(options.dictationPlan())
      } catch (err) {
        log('ekko', 'could not tell whether to warm up', {
          err: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const previous = loadableModelId
      loadableModelId = target?.speechModelId ?? null
      if (target === null) return
      if (previous === target.speechModelId) return
      if (inFlight !== null) return
      inFlight = run(target)
    },
    async whenLoaded(boundMs) {
      const pending = inFlight
      if (pending === null) return
      log('ekko', 'dictation waiting for the warm-up')
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log('ekko', 'stopped waiting for the warm-up', { waitedMs: boundMs })
          resolve()
        }, boundMs)
      })
      try {
        await Promise.race([pending, bound])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}

let appWarmup: EkkoWarmup | null = null

/** Wired once, from `index.ts`. */
export function installEkkoWarmup(warmup: EkkoWarmup): void {
  appWarmup = warmup
}

/** The adapter's wait: the app's warm-up in flight, bounded by `EKKO_WARMUP_WAIT_MS`. */
export async function awaitEkkoWarmup(): Promise<void> {
  await appWarmup?.whenLoaded(EKKO_WARMUP_WAIT_MS)
}
