/**
 * Downloading and removing Speech Model weights, for the window and the command line alike.
 *
 * One download per Speech Model at a time. A second request for weights already on their way
 * joins the running download instead of starting another, whichever surface asked first, so
 * the window's Models page shows a command-line download and `codictate models download`
 * waits on one the window started. Every download and every removal ends in the same heal
 * pass (ADR-0005): an availability change is what it corrects.
 *
 * A request right after a Cancel never joins the cancelled download. It starts a new one,
 * but only once the store has finished winding the old one down: `modelManager` keys its
 * abort controller and its temp file by Speech Model, so two downloads of the same weights
 * overlapping would delete each other's files.
 *
 * No platform imports: the weights store, the window pushes and the heal pass come in as
 * deps, so the tests need no app.
 */

import type { ModelDownloadProgress } from '../shared/types'

/** The part of `modelManager` this module drives. */
export interface SpeechModelStore {
  downloadModel(
    modelId: string,
    onProgress: (fraction: number, done: boolean, error?: string) => void
  ): Promise<void>
  cancelDownload(modelId: string): void
  deleteModel(modelId: string): boolean
}

export type ModelDownloadRequester = 'window' | 'command-line'

export type ModelDownloadOutcome =
  | { status: 'installed' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

export interface ModelDownload {
  /** The shared download's progress from now on, as a fraction of 1. Returns unsubscribe. */
  onProgress(listener: (fraction: number) => void): () => void
  /** Settles after the heal pass when the weights landed, so a next command sees it. */
  result: Promise<ModelDownloadOutcome>
  /**
   * This requester no longer wants the weights. The download stops when nobody else asked
   * for it: a window that asked keeps it running, since the window has its own Cancel.
   */
  release(): void
}

export interface ModelOperations {
  download(modelId: string, requester: ModelDownloadRequester): ModelDownload
  /** The window's Cancel: stops the download for everyone waiting on it. */
  cancelDownload(modelId: string): void
  /** Deletes the weights and runs the heal pass. False when there was nothing to delete. */
  remove(modelId: string): Promise<boolean>
}

export interface ModelOperationsDeps {
  store: SpeechModelStore
  /** To the window, when one is open. Never throws. */
  pushProgress(progress: ModelDownloadProgress): void
  pushAvailability(data: { modelId: string; available: boolean }): void
  /** The heal pass, the settings push and the tray sync that follow an availability change. */
  onAvailabilityChanged(): Promise<void>
  log(event: string, data?: Record<string, unknown>): void
}

interface RunningDownload {
  requestedByWindow: boolean
  commandLineHolders: number
  cancelled: boolean
  listeners: Set<(fraction: number) => void>
  result: Promise<ModelDownloadOutcome>
  /** Resolves when the store's `downloadModel` has returned, cleanup included. */
  storeSettled: Promise<void>
}

export function createModelOperations(
  deps: ModelOperationsDeps
): ModelOperations {
  const running = new Map<string, RunningDownload>()

  const healAfterAvailabilityChange = async () => {
    try {
      await deps.onAvailabilityChanged()
    } catch (err) {
      deps.log('heal after availability change failed', { err: String(err) })
    }
  }

  const cancel = (modelId: string) => {
    const entry = running.get(modelId)
    if (entry) entry.cancelled = true
    deps.store.cancelDownload(modelId)
  }

  /** `after`: a cancelled download of the same weights the store is still winding down. */
  const start = (
    modelId: string,
    after: Promise<void> | null
  ): RunningDownload => {
    let settle!: (outcome: ModelDownloadOutcome) => void
    let storeSettled!: () => void
    const entry: RunningDownload = {
      requestedByWindow: false,
      commandLineHolders: 0,
      cancelled: false,
      listeners: new Set(),
      result: new Promise((resolve) => {
        settle = resolve
      }),
      storeSettled: new Promise((resolve) => {
        storeSettled = resolve
      }),
    }
    running.set(modelId, entry)

    const finish = async (error: string | undefined) => {
      if (running.get(modelId) === entry) running.delete(modelId)
      if (error === undefined) {
        // The heal pass also settles the runnable-settings observer, which is what starts
        // Parakeet's preparation when the weights that just landed are the selected ones.
        await healAfterAvailabilityChange()
        settle({ status: 'installed' })
      } else if (entry.cancelled) {
        settle({ status: 'cancelled' })
      } else {
        settle({ status: 'failed', message: error })
      }
    }

    const begin = () => {
      if (entry.cancelled) {
        // Cancelled while it waited for the previous one: the store never saw it.
        storeSettled()
        deps.pushProgress({
          modelId,
          progressFraction: 0,
          done: true,
          error: 'Cancelled',
          requestedByWindow: entry.requestedByWindow,
        })
        void finish('Cancelled')
        return
      }
      runInStore()
    }

    const runInStore = () =>
      deps.store
        .downloadModel(modelId, (fraction, done, error) => {
          deps.pushProgress({
            modelId,
            progressFraction: fraction,
            done,
            error,
            requestedByWindow: entry.requestedByWindow,
          })
          if (!done) {
            for (const listener of entry.listeners) listener(fraction)
            return
          }
          void finish(error)
        })
        .catch((err: unknown) => {
          deps.log('model download threw', { modelId, err: String(err) })
          void finish(err instanceof Error ? err.message : 'Download failed')
        })
        .finally(storeSettled)

    if (after === null) begin()
    else void after.then(begin)
    return entry
  }

  return {
    download(modelId, requester) {
      const current = running.get(modelId)
      const entry =
        current === undefined
          ? start(modelId, null)
          : current.cancelled
            ? start(modelId, current.storeSettled)
            : current
      if (requester === 'window') entry.requestedByWindow = true
      else entry.commandLineHolders += 1

      let released = requester === 'window'
      const ownListeners = new Set<(fraction: number) => void>()
      return {
        onProgress(listener) {
          entry.listeners.add(listener)
          ownListeners.add(listener)
          return () => {
            entry.listeners.delete(listener)
            ownListeners.delete(listener)
          }
        },
        result: entry.result,
        release() {
          for (const listener of ownListeners) entry.listeners.delete(listener)
          ownListeners.clear()
          if (released) return
          released = true
          entry.commandLineHolders -= 1
          if (
            running.get(modelId) === entry &&
            entry.commandLineHolders === 0 &&
            !entry.requestedByWindow
          ) {
            cancel(modelId)
          }
        },
      }
    },

    cancelDownload: cancel,

    async remove(modelId) {
      // Deleting weights is never refused, so the configuration is what gets corrected: a
      // dangling selection, a Translate toggle with nothing to translate with, a Live
      // Transcription switched on without Parakeet.
      if (!deps.store.deleteModel(modelId)) return false
      deps.pushAvailability({ modelId, available: false })
      await healAfterAvailabilityChange()
      return true
    },
  }
}
