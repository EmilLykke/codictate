/**
 * Turning the "Add punctuation" switch on.
 *
 * The stored setting turns true only after a verified install of the Punctuation Model
 * (ekko-pnc): the settings write is refused without it (ADR-0005), so turning the switch on
 * is a download first, then the write. With the Punctuation Model already on disk, as after
 * turning the switch off (which keeps the files), it is the write alone. A failed or cancelled
 * download leaves the switch off and reports the error, so the user can press again.
 *
 * One download at a time: a second press while one runs joins it. Turning the switch off
 * needs nothing from here; it is an ordinary settings write and deletes nothing.
 *
 * No platform imports: the install, the settings write and the window push come in as deps.
 */

import type { PunctuationModelDownloadProgress } from '../../../shared/types'

export type PunctuationModelInstall = (args: {
  signal: AbortSignal
  onProgress: (fraction: number) => void
}) => Promise<void>

export interface AddPunctuationSwitchDeps {
  isInstalled(): boolean
  install: PunctuationModelInstall
  /** Writes `addPunctuation: true` and pushes the settings. False when the write was refused. */
  enable(): Promise<boolean>
  /** To the window, when one is open. Never throws. */
  pushProgress(progress: PunctuationModelDownloadProgress): void
  log(event: string, data?: Record<string, unknown>): void
}

export interface AddPunctuationSwitch {
  /** Settles when the switch is on, or when the download behind it failed or was cancelled. */
  turnOn(): Promise<void>
  /** Stops a running download. The switch stays off. */
  cancel(): void
}

export function createAddPunctuationSwitch(
  deps: AddPunctuationSwitchDeps
): AddPunctuationSwitch {
  let running: { controller: AbortController; done: Promise<void> } | null =
    null

  async function download(controller: AbortController): Promise<void> {
    try {
      if (!deps.isInstalled()) {
        deps.log('punctuation model download started')
        deps.pushProgress({ progressFraction: 0, done: false })
        await deps.install({
          signal: controller.signal,
          onProgress: (progressFraction) =>
            deps.pushProgress({ progressFraction, done: false }),
        })
        deps.log('punctuation model installed')
      }
    } catch (err) {
      const error = downloadErrorMessage(err)
      deps.log('punctuation model download failed', { error })
      deps.pushProgress({ progressFraction: 0, done: true, error })
      return
    }

    // Refused only when the availability check does not accept what is on disk, which a
    // verified install rules out unless something removed it in between.
    if (!(await deps.enable())) {
      deps.log('add punctuation write refused after install')
      deps.pushProgress({
        progressFraction: 0,
        done: true,
        error: 'The Danish punctuation model did not install. Try again.',
      })
      return
    }
    deps.pushProgress({ progressFraction: 1, done: true })
  }

  return {
    turnOn() {
      if (running) return running.done
      const controller = new AbortController()
      const done = download(controller).finally(() => {
        running = null
      })
      running = { controller, done }
      return done
    },
    cancel() {
      running?.controller.abort()
    },
  }
}

function downloadErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'Cancelled'
  if (err instanceof Error) return err.message
  return 'Download failed'
}
