/**
 * A Dictation started from the command line (`codictate dictate`), as `setupRecording`
 * offers it. Types only, so the command-line handlers and their tests can use them without
 * loading the recording module.
 *
 * It is the Dictation the shortcut runs - same Dictation Plan resolver, sounds, tray, HUD,
 * History and Stats - with three differences, all about where the text goes and how it ends:
 * `output: 'stdout'` hands the Dictation Outcome back instead of pasting it (and so is always
 * a Batch Dictation), `raw` skips the rewrites, and it can end on a timer or on silence.
 */

import type {
  BlockedDictationPlan,
  RunnableDictationPlan,
} from '../../shared/dictation-plan'
import type {
  DictateOutput,
  DictateUntil,
} from '../../shared/command-line-protocol'
import type { FormattingModeId } from '../../shared/formatting-modes'
import type { FailedTranscription } from '../utils/whisper/engines/transcription'

export type CommandLineDictationEvent =
  { type: 'recording' } | { type: 'transcribing' }

export interface CommandLineDictationOptions {
  output: DictateOutput
  raw: boolean
  until: DictateUntil
  /** End after this long. Codictate's own maximum recording duration applies as well. */
  maxSeconds: number | null
  /** Already checked against the catalog. `null` is the user's selection. */
  speechModelId: string | null
  /** Already checked, and coerced for the Speech Model. `null` is the user's setting. */
  transcriptionLanguageId: string | null
  /** Use this Formatting Mode instead of the one the focused app would pick. */
  formattingModeId: FormattingModeId | null
  onEvent(event: CommandLineDictationEvent): void
}

export type CommandLineDictationResult =
  | {
      status: 'ok'
      /** What was pasted, or would have been. Empty for a Live Transcription. */
      text: string
      /** The Raw Transcript. Empty for a Live Transcription. */
      rawText: string
      formattingModeId: FormattingModeId | null
      pasted: boolean
      live: boolean
      plan: RunnableDictationPlan
      audioSeconds: number
    }
  /** Cancelled from the command line, by Escape, or never got going. */
  | { status: 'cancelled' }
  | {
      status: 'failed'
      failure: FailedTranscription
      plan: RunnableDictationPlan
    }
  /** The Live Transcription helper's last-moment check refused to spawn. */
  | { status: 'blocked'; plan: BlockedDictationPlan }
  | { status: 'error'; message: string }

export type CommandLineDictationStart =
  | {
      status: 'started'
      /** End the recording and transcribe it. */
      stop(): void
      /** Discard it: nothing is transcribed, pasted or saved. */
      cancel(): void
      result: Promise<CommandLineDictationResult>
    }
  | { status: 'busy' }
  | {
      status: 'blocked'
      plan: BlockedDictationPlan
      /** The plan used per-call overrides, so it says nothing about the settings. */
      fromOverrides: boolean
    }
  | { status: 'unsupported'; message: string }

/** What `setupRecording` offers the command line. */
export interface CommandLineDictationControl {
  startCommandLineDictation(
    options: CommandLineDictationOptions
  ): Promise<CommandLineDictationStart>
  stopAnyDictation(): boolean
  getActiveDictation(): {
    active: boolean
    startedBy: 'shortcut' | 'command-line' | null
  }
}
