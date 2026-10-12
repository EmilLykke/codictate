/**
 * The one Dictation running right now, whoever started it.
 *
 * Module state on purpose. There is one microphone and one recording file, and `index.ts`
 * rebuilds the `setupRecording` closure on every settings change and permission refresh
 * while a Dictation it started may still be recording or transcribing. Kept in the closure,
 * the old Dictation would be invisible to the new one: `codictate stop` would find nothing
 * to stop and a second Dictation could start on top of the first. Each start claims this
 * slot and each Dictation releases its own claim, so a late release can never clear a newer
 * Dictation's.
 */

import type { DictationStartedBy } from '../../shared/command-line-protocol'

export interface DictationClaim {
  /** The `setupRecording` instance that runs it. */
  owner: symbol
  startedBy: DictationStartedBy
  /**
   * End the recording and transcribe it. False when there is no recording left to end
   * (it is already transcribing).
   */
  stop(): boolean
  /** Discard it: nothing is transcribed, pasted or saved. */
  cancel(): void
}

let active: DictationClaim | null = null

/** Takes the slot. False, and nothing changes, when a Dictation already holds it. */
export function claimDictation(claim: DictationClaim): boolean {
  if (active !== null) return false
  active = claim
  return true
}

/** Frees the slot if `claim` still holds it. Safe to call more than once. */
export function releaseDictation(claim: DictationClaim): void {
  if (active === claim) active = null
}

export function currentDictation(): DictationClaim | null {
  return active
}

export function activeDictationStatus(): {
  active: boolean
  startedBy: DictationStartedBy | null
} {
  return active === null
    ? { active: false, startedBy: null }
    : { active: true, startedBy: active.startedBy }
}

/**
 * Ends whatever Dictation is recording, from the Dictation Shortcut or the command line. Its
 * text goes to whoever started it. False when nothing was recording.
 */
export function stopAnyDictation(): boolean {
  return active?.stop() ?? false
}
