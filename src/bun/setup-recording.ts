import {
  getShortcutDefinition as buildShortcutDefinition,
  Key,
  KeyCode,
  MODIFIER_KEYCODES,
  FN_PHYSICAL_KEYCODES,
  isWindowsModifierReleaseEvent as matchesModifierRelease,
  isWindowsComboTriggerReleaseEvent as matchesTriggerRelease,
  type KeyEvent,
} from '../shared/shortcut-matching'
import { isModifierChord } from '../shared/shortcut-options'

import {
  startRecording,
  stopRecording,
  type CaptureResult,
  type RecordingSession,
} from './utils/audio/start-rec'
import {
  startParakeetStream,
  stopParakeetStream,
  type StreamSession,
} from './utils/whisper/parakeet-stream-runner'
import {
  blockedPlanHealsSettings,
  type BlockedDictationPlan,
  type DictationMode,
  type DictationPlan,
  type RunnableDictationPlan,
} from '../shared/dictation-plan'
import {
  finishObservedCorrection,
  pasteTranscript,
  startKeyboardListener,
  type PermissionStatus,
} from './utils/keyboard/keyboard-events'
import {
  duckDelayAfterStartChimeMs,
  playCancelSound,
  playEndSound,
  playErrorSound,
  playStartSound,
} from './utils/sound/play-sound'
import { AppConfig } from './AppConfig/AppConfig'
import type { TrayHandlers } from './setup-tray'
import { findDevices, type AudioDeviceSnapshot } from './utils/audio/devices'
import { startAudioDucking } from './utils/audio/audio-ducking'
import { microphoneDeviceRef } from '../shared/microphone'
import { DICTATION_HOLD_QUALIFY_MS } from '../shared/dictation-shortcut'
import type { AppStatus, ShortcutId } from '../shared/types'
import { runDictation, type DictationOutcome } from './dictation/run-dictation'
import type { FailedTranscription } from './utils/whisper/engines/transcription'
import { windowsUsesModifierReleaseHold } from '../shared/shortcut-options'
import { checkMicrophoneAuthorization } from './utils/audio/check-mic-authorization'
import { log } from './utils/logger'
import { startObserverHelper } from './utils/keyboard/observer-helper'
import { getPlatformRuntime, RECORDING_PATH } from './platform/runtime'
import type { DictationStartedBy } from '../shared/command-line-protocol'
import type { FormattingModeId } from '../shared/formatting-modes'
import {
  activeDictationStatus,
  claimDictation,
  currentDictation,
  releaseDictation,
  stopAnyDictation,
  type DictationClaim,
} from './dictation/active-dictation'
import type {
  CommandLineDictationControl,
  CommandLineDictationOptions,
  CommandLineDictationResult,
  CommandLineDictationStart,
} from './dictation/command-line-dictation'
import {
  DEFAULT_END_OF_SPEECH_OPTIONS,
  createEndOfSpeechDetector,
  createLevelMeter,
} from './dictation/end-of-speech'
import {
  watchGrowingWav,
  type GrowingWavWatcher,
} from './utils/audio/growing-wav'
import {
  startLanguageWhileRecording,
  type LanguageWhileRecording,
} from './dictation/language-while-recording'
import { modelManager } from './utils/whisper/model-manager'

const getShortcutDefinition = (
  id: ShortcutId,
  options?: { requireLeftOption?: boolean }
) => buildShortcutDefinition(id, { ...options, platform: getPlatformRuntime() })

/** Keycodes that should not cancel "wait for Fn chord" when main is fn-globe + hold is fn-* (non-globe). */
const FN_GLOBE_DEFER_CANCEL_SUPPRESS = new Set<number>(
  Object.values(MODIFIER_KEYCODES).flat()
)

function holdFnChordConflictsWithFnGlobeMain(
  hybridId: ShortcutId,
  holdId: ShortcutId | null
): holdId is ShortcutId {
  return (
    hybridId === 'fn-globe' && holdId !== null && isModifierChord(holdId, 'fn')
  )
}

/** How a finished Batch Dictation ended, for whoever started it. */
type DictationFinish =
  /** Cancelled (Escape, or the command line), or the recorder was killed. */
  | { status: 'cancelled' }
  /** Too short to be speech, or no usable file. Silence, not a failure. */
  | { status: 'empty'; durationMs: number }
  | { status: 'failed'; failure: FailedTranscription }
  | { status: 'ok'; outcome: DictationOutcome; pasted: boolean }
  | { status: 'error'; message: string }

/**
 * Where one Batch Dictation's Outcome goes. ADR-0006: the run returns an Outcome and placing
 * it is the starter's job, so the shortcut pastes it and the command line may hand it back
 * instead. History and Stats are saved the same way for both.
 */
interface DictationDelivery {
  claim: DictationClaim
  paste: boolean
  /** Output the Raw Transcript: no brand table, Dictionary or Formatting Mode. */
  raw: boolean
  /** Use this Formatting Mode instead of the focused app's. */
  formattingModeId: FormattingModeId | null
  /** Aborted to cancel a Dictation that is already transcribing. */
  signal?: AbortSignal
  onRecording?(session: RecordingSession): void
  onTranscribing?(): void
  onFinished?(finish: DictationFinish): void
}

/** How a Live Transcription session ended. */
type StreamEnd =
  | { status: 'stopped' }
  | { status: 'blocked'; plan: BlockedDictationPlan }
  | { status: 'error'; message: string }

const SILENCE_WITH_LIVE_MESSAGE =
  '--until silence does not work with live transcription. Leave out --paste, or turn live transcription off in Settings.'

function mergeSwallowRules(a: KeyEvent[], b: KeyEvent[]): KeyEvent[] {
  const seen = new Set<string>()
  const out: KeyEvent[] = []
  for (const r of [...a, ...b]) {
    const k = `${r.keycode}|${r.option}|${r.leftOption}|${r.rightOption}|${r.command}|${r.control}|${r.shift}|${r.fn}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

export const setupRecording = (
  appConfig: AppConfig,
  {
    setTrayIdle,
    setTrayRecording,
    setTrayTranscribing,
    setTrayStreaming,
    setTrayError,
  }: TrayHandlers,
  onStatusChange?: (status: AppStatus) => void,
  onPermissions?: (status: PermissionStatus) => void,
  getAudioDevices?: () => AudioDeviceSnapshot,
  onAutoLearnedEntry?: () => void,
  onHistorySave?: (transcript: string) => Promise<void>,
  /**
   * One argument, because the Dictation Outcome already carries what a stats row needs -
   * including `engineId` and `languageId`, which come from the Dictation Plan rather than
   * from a config read after the run. See ADR-0006.
   */
  onStatsSave?: (outcome: DictationOutcome) => Promise<void>,
  /**
   * Every Dictation Plan a shortcut press produces, runnable or blocked. The main process
   * owns the surfaces a blocked plan has to reach that this module cannot: the notification,
   * the in-window banner, and the heal pass that makes the next press work.
   */
  onDictationPlan?: (plan: DictationPlan) => Promise<void>,
  /**
   * A Dictation that started and then produced nothing. The same two main-process surfaces a
   * blocked plan gets - notification or banner - and deliberately not the third: no heal
   * pass. See `reportFailedDictation` below.
   */
  onDictationFailed?: (failure: FailedTranscription) => Promise<void>
) => {
  /** Tells this instance's Dictations apart from those of an instance `index.ts` replaced. */
  const instance = Symbol('setupRecording')
  let recorderProc: ReturnType<typeof Bun.spawn> | null = null
  let recordingSession: RecordingSession | null = null
  let sessionStarting = false
  let sessionStopping = false
  let transcriptionPipelineActive = false
  let pendingHoldReleaseWhileStarting = false
  let pendingHoldReleaseStartedAtMs = 0
  let pendingStreamHoldReleaseWhileStarting = false
  let pendingStreamHoldReleaseStartedAtMs = 0
  /** `stop()` / `cancel()` from a claim arrived while the recorder was still spawning. */
  let pendingStopWhileStarting = false
  let pendingCancelWhileStarting = false

  // Stream mode state
  let streamSession: StreamSession | null = null
  let streamStarting = false
  /** When stream was started via push-to-talk, release must stop (unlike hybrid tap-to-toggle). */
  let activeStreamShortcutMode: 'hybrid' | 'holdOnly' | null = null
  /** Monotonic id for log correlation with Parakeet helper stderr (`[sN]`). */
  let streamDebugSeq = 0
  /** Ends the running stream's claim and tells its starter. Once per stream. */
  let streamEnd: ((end: StreamEnd) => void) | null = null

  /** Anything at all in flight, here or in an instance this one replaced. */
  const isBusy = () =>
    currentDictation() !== null ||
    recorderProc !== null ||
    sessionStarting ||
    transcriptionPipelineActive ||
    streamSession !== null ||
    streamStarting

  /**
   * The Microphone, resolved the same way batch Dictation resolves it for MicRecorder. Both
   * platform helpers record from it; without it they would record from the system default
   * input, which on a Mac with the lid closed is a built-in microphone that delivers silence.
   */
  const resolveStreamDeviceRef = async (): Promise<string> => {
    let currentSnapshot = getAudioDevices?.() ?? { devices: {}, details: {} }
    if (Object.keys(currentSnapshot.devices).length === 0) {
      currentSnapshot = await findDevices()
    }

    const microphone = appConfig.resolveMicrophone(currentSnapshot.details)
    if (microphone === null) throw new Error('No microphone connected')
    const deviceRef = microphoneDeviceRef(microphone.device)

    log('stream', 'resolved stream microphone', {
      index: microphone.device.index,
      name: microphone.device.name,
      transport: microphone.device.transport,
      isPick: microphone.isPick,
      deviceRef,
    })

    return deviceRef
  }

  let holdArmTimer: ReturnType<typeof setTimeout> | null = null
  /** True after HOLD_QUALIFY_MS with no qualifying release cancelling the arm timer. */
  let holdQualified = false
  /** Which shortcut started the current session (when recorder is active). */
  let activeRecordingMode: 'hybrid' | 'holdOnly' | null = null
  /**
   * Fn-down was swallowed so Fn+key push-to-talk can win over main `fn-globe` (which would
   * otherwise start hybrid on Fn press and drop the chord while `sessionStarting` is true).
   */
  let pendingFnGlobeHybridDefer = false

  const mainShortcutUsesLeftOptionOnly = () =>
    appConfig.getShortcutHoldOnlyId() === 'right-option' &&
    isModifierChord(appConfig.getShortcutId(), 'option')

  const getHybridShortcut = () =>
    getShortcutDefinition(appConfig.getShortcutId(), {
      requireLeftOption: mainShortcutUsesLeftOptionOnly(),
    })

  const getHoldOnlyShortcut = () => {
    const id = appConfig.getShortcutHoldOnlyId()
    return id !== null ? getShortcutDefinition(id) : null
  }

  const getMergedSwallowRules = (): KeyEvent[] => {
    const hybrid = getHybridShortcut()
    const hold = getHoldOnlyShortcut()
    if (hold === null) return hybrid.swallowRules
    return mergeSwallowRules(hybrid.swallowRules, hold.swallowRules)
  }

  const clearHoldArmTimer = () => {
    if (holdArmTimer !== null) {
      clearTimeout(holdArmTimer)
      holdArmTimer = null
    }
  }

  const resetHoldGate = () => {
    clearHoldArmTimer()
    holdQualified = false
  }

  const armHoldGateAfterStart = () => {
    resetHoldGate()
    holdArmTimer = setTimeout(() => {
      holdArmTimer = null
      if (recorderProc !== null || streamSession !== null || streamStarting) {
        holdQualified = true
      }
    }, DICTATION_HOLD_QUALIFY_MS)
  }

  const keyLabel = (keycode: number) => KeyCode[keycode] ?? String(keycode)

  const usesWindowsModifierReleaseHold = (shortcutId: ShortcutId): boolean =>
    getPlatformRuntime() === 'windows' &&
    windowsUsesModifierReleaseHold(shortcutId)

  const isWindowsModifierReleaseEvent = (
    shortcutId: ShortcutId,
    keyEvent: KeyEvent
  ): boolean => {
    if (!usesWindowsModifierReleaseHold(shortcutId)) return true
    return matchesModifierRelease(
      shortcutId,
      keyEvent,
      mainShortcutUsesLeftOptionOnly() &&
        shortcutId === appConfig.getShortcutId()
    )
  }

  const isWindowsComboTriggerReleaseEvent = (
    shortcutId: ShortcutId,
    keyEvent: KeyEvent
  ): boolean => {
    if (!usesWindowsModifierReleaseHold(shortcutId)) return false
    return matchesTriggerRelease(shortcutId, keyEvent)
  }

  const keyEventDebug = (e: KeyEvent) => ({
    keycode: e.keycode,
    key: keyLabel(e.keycode),
    keyDown: e.keyDown,
    isRepeat: e.isRepeat,
    option: e.option,
    leftOption: e.leftOption,
    rightOption: e.rightOption,
    command: e.command,
    control: e.control,
    shift: e.shift,
    fn: e.fn,
  })

  const logShortcutDecision = (
    reason: string,
    mode: 'hybrid' | 'holdOnly',
    action: 'start' | 'stop' | 'blocked',
    keyEvent?: KeyEvent,
    /** The Dictation Plan's own mode, when a plan was built for this press. */
    planMode?: DictationMode
  ) => {
    log('shortcut', 'routing shortcut', {
      reason,
      mode,
      action,
      planMode,
      streamSessionActive: streamSession !== null,
      streamDebugId: streamSession?.streamDebugId,
      activeStreamShortcutMode,
      hybridShortcutId: appConfig.getShortcutId(),
      holdShortcutId: appConfig.getShortcutHoldOnlyId(),
      recorderActive: recorderProc !== null,
      transcriptionPipelineActive,
      keyEvent: keyEvent ? keyEventDebug(keyEvent) : undefined,
    })
  }

  /**
   * A Dictation that will not run, made impossible to miss.
   *
   * Four surfaces, because the app is usable with no window open: the error chime and the
   * tray error state are owned here, and `onDictationPlan` carries the same sentence out to
   * the notification (window closed) or the in-window banner (window open) and runs the heal
   * pass so the next press works. ADR-0005: a blocked Dictation is never silent.
   */
  const reportBlockedDictation = async (plan: BlockedDictationPlan) => {
    log('shortcut', 'dictation blocked', {
      planMode: plan.mode,
      reason: plan.reason,
    })
    if (appConfig.getSoundEffectsEnabled()) playErrorSound()
    setTrayError(plan.message)
    await onDictationPlan?.(plan)
  }

  /**
   * A Dictation that ran and produced nothing, made impossible to miss.
   *
   * The same four surfaces as a blocked plan, and for the same reason: the app is usable with
   * no window open, so an error chime and the tray error state are owned here while
   * `onDictationFailed` carries the sentence out to the notification or the in-window banner.
   *
   * What it deliberately does not do is heal. A blocked plan means the configuration is
   * unrunnable and healing is the correction; a crashed helper means the configuration was
   * fine, and running the heal pass on every crash would let a flaky helper quietly rewrite
   * settings the user chose. ADR-0006.
   */
  const reportFailedDictation = async (failure: FailedTranscription) => {
    log('whisper', 'dictation failed', {
      reason: failure.reason,
      message: failure.message,
    })
    if (appConfig.getSoundEffectsEnabled()) playErrorSound()
    setTrayError(failure.message)
    await onDictationFailed?.(failure)
  }

  /**
   * The Dictation pipeline is free again.
   *
   * Runs on every path out of a finished capture, the failure ones included: this is the only
   * signal the shortcut router has, so an escaping throw used to leave
   * `transcriptionPipelineActive` true for the rest of the process and every later press was
   * refused until restart. A failed Dictation must cost one Dictation, not all of them.
   */
  const releaseDictationPipeline = (claim: DictationClaim) => {
    transcriptionPipelineActive = false
    recordingSession = null
    releaseDictation(claim)
    setTrayIdle()
    onStatusChange?.('ready')
  }

  /**
   * The capture is over; everything after it happens here.
   *
   * The order is load-bearing and unchanged from when it lived inside the mic process's
   * `onExit`: tray and indicator to transcribing, the end chime, the pipeline, and the paste
   * on the statement after the pipeline returns. Nothing is awaited between the transcript
   * and the paste. What changed is who does it - `setup-recording.ts` already owns every
   * other post-Dictation surface, and the audio module should not be orchestrating the
   * Formatting Backend. ADR-0006.
   *
   * The Outcome goes to `delivery`, which belongs to whoever started the Dictation: the
   * shortcut pastes it, the command line may only hand it back. History and Stats are the
   * same for both.
   */
  const handleCaptureFinished = async (
    plan: RunnableDictationPlan,
    session: RecordingSession,
    capture: CaptureResult,
    delivery: DictationDelivery,
    languageCheck: LanguageWhileRecording | null
  ) => {
    // The recorder has exited, whichever way. Nothing newer can be running: this Dictation
    // still holds the claim until the release below.
    recorderProc = null
    activeRecordingMode = null

    // Cancelled, or too short to be speech. Silence, not a failure: no chime, no notice, and
    // the session ends where it stands. A cancel can land after the recorder exited but
    // before this ran (the recorder's `onExit` reads `session.discard`, then inspects the
    // WAV), so the session and the signal are asked again here, not only the capture.
    const cancelled =
      capture.discarded || session.discard || delivery.signal?.aborted === true
    if (cancelled || capture.skipReason !== null) {
      languageCheck?.cancel()
      releaseDictationPipeline(delivery.claim)
      delivery.onFinished?.(
        cancelled
          ? { status: 'cancelled' }
          : { status: 'empty', durationMs: capture.durationMs }
      )
      return
    }

    transcriptionPipelineActive = true

    // Held rather than reported inline, because the tray error state has to outlive the
    // release below - which puts the tray back to idle. Same order the blocked-stream path
    // uses: idle first, then the error.
    let failure: FailedTranscription | null = null
    let finish: DictationFinish

    // Everything from here is inside the `try`, so a throw anywhere, these status calls
    // included, still releases the claim.
    try {
      setTrayTranscribing()
      onStatusChange?.('transcribing')
      delivery.onTranscribing?.()

      if (appConfig.getSoundEffectsEnabled())
        playEndSound(appConfig.getFunModeEnabled())

      // The previous Dictation's Dictionary hits are promoted now, before this one records
      // its own. Hoisted out of the pipeline because it is bookkeeping about the last run,
      // not part of producing this transcript.
      await appConfig.acceptPreviouslyAppliedEntries()

      // Under automatic detection, the language checked while the user spoke. Null when there
      // was too little speech, and the decode detects for itself.
      const detectedLanguage = await languageCheck?.finish()

      const formattingSettings = appConfig.getFormattingRuntimeSettings()
      const outcome = await runDictation({
        plan,
        detectedLanguage: detectedLanguage ?? undefined,
        audioPath: capture.audioPath,
        durationMs: capture.durationMs,
        formattingSettings:
          delivery.formattingModeId === null
            ? formattingSettings
            : { ...formattingSettings, forceModeId: delivery.formattingModeId },
        dictionaryEntries: appConfig.getDictionaryEntries(),
        onAppliedEntries: (entries) => appConfig.notifyAppliedEntries(entries),
        raw: delivery.raw,
        signal: delivery.signal,
      })

      if (delivery.signal?.aborted === true) {
        // Cancelled while it was transcribing: nothing is pasted or saved, and the engine
        // stopping on the signal is not a failure to report.
        finish = { status: 'cancelled' }
      } else if (outcome.status === 'failed') {
        failure = outcome
        finish = { status: 'failed', failure: outcome }
      } else {
        // An empty output is a Dictation the Speech Engine heard nothing in, and it writes
        // nothing: no paste, no history entry, no stats row, no error chime. It used to paste
        // an empty string over the cursor and count a zero-word stats row.
        let pasted = false
        if (outcome.output !== '') {
          if (delivery.paste) {
            await pasteTranscript(outcome.output)
            pasted = true
          }

          if (onHistorySave) {
            try {
              await onHistorySave(outcome.output)
            } catch (err) {
              log('history', 'failed to save entry', { err: String(err) })
            }
          }
          if (onStatsSave) {
            try {
              await onStatsSave(outcome)
            } catch (err) {
              log('stats', 'failed to save session', { err: String(err) })
            }
          }
        }
        finish = { status: 'ok', outcome, pasted }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('whisper', 'transcription pipeline failed', { err: message })
      finish = { status: 'error', message: `The Dictation failed: ${message}` }
    } finally {
      languageCheck?.cancel()
      releaseDictationPipeline(delivery.claim)
    }

    delivery.onFinished?.(finish)
    if (failure !== null) await reportFailedDictation(failure)
  }

  const shortcutDelivery = (claim: DictationClaim): DictationDelivery => ({
    claim,
    paste: true,
    raw: false,
    formattingModeId: null,
  })

  /**
   * Escape, for a Batch Dictation that is recording: the recorder is killed and the capture
   * discarded, so nothing is transcribed, pasted or saved. False when nothing was recording.
   */
  const discardRecording = (): boolean => {
    if (!recorderProc) return false
    resetHoldGate()
    activeRecordingMode = null
    if (recordingSession) recordingSession.discard = true
    recorderProc.kill()
    recorderProc = null
    setTrayIdle()
    onStatusChange?.('ready')
    if (appConfig.getSoundEffectsEnabled()) playCancelSound()
    return true
  }

  /** The claim of a Batch Dictation run by this instance. */
  const batchClaim = (
    startedBy: DictationStartedBy,
    transcription?: AbortController
  ): DictationClaim => ({
    owner: instance,
    startedBy,
    stop: () => {
      if (sessionStarting) {
        pendingStopWhileStarting = true
        return true
      }
      if (recorderProc === null) return false
      if (!sessionStopping) {
        resetHoldGate()
        void tryStop()
      }
      return true
    },
    // Whatever stage it is at, a cancelled Dictation is never transcribed, pasted or saved:
    // the transcription signal is aborted on every path, and `handleCaptureFinished` checks
    // it before it starts and again before it delivers.
    cancel: () => {
      const abortTranscription = (): boolean => {
        if (transcription === undefined || transcription.signal.aborted) {
          return false
        }
        transcription.abort()
        return true
      }
      if (sessionStarting) {
        pendingCancelWhileStarting = true
        abortTranscription()
        return
      }
      if (discardRecording()) {
        abortTranscription()
        return
      }
      if (abortTranscription() && appConfig.getSoundEffectsEnabled()) {
        playCancelSound()
      }
    },
  })

  /** The claim of a Live Transcription run by this instance. */
  const streamClaim = (startedBy: DictationStartedBy): DictationClaim => ({
    owner: instance,
    startedBy,
    stop: () => {
      if (streamStarting) {
        pendingStreamHoldReleaseWhileStarting = true
        return true
      }
      if (streamSession === null) return false
      void tryStopStream()
      return true
    },
    // As Escape does: the helper has already written its text into the field, so there is
    // nothing left to discard. The stream just ends.
    cancel: () => {
      if (appConfig.getSoundEffectsEnabled()) playCancelSound()
      if (streamStarting) {
        pendingStreamHoldReleaseWhileStarting = true
        return
      }
      void tryStopStream()
    },
  })

  const routeShortcutAction = async (
    mode: 'hybrid' | 'holdOnly',
    keyEvent: KeyEvent,
    reason: string
  ) => {
    const plan = appConfig.getDictationPlan()

    if (plan.status === 'blocked') {
      // A running stream still has to be stoppable: its weights can vanish mid-session, and
      // the press that notices must not leave the helper running.
      if (streamSession !== null) {
        logShortcutDecision(reason, mode, 'stop', keyEvent, plan.mode)
        await tryStopStream()
      }
      logShortcutDecision(reason, mode, 'blocked', keyEvent, plan.mode)
      await reportBlockedDictation(plan)
      return
    }

    await onDictationPlan?.(plan)

    if (plan.mode !== 'live' && streamSession !== null) {
      log('shortcut', 'stopping orphan Parakeet stream (stream mode off)')
      await tryStopStream()
    }
    if (plan.mode === 'live') {
      logShortcutDecision(
        reason,
        mode,
        streamSession !== null ? 'stop' : 'start',
        keyEvent,
        plan.mode
      )
      if (streamSession !== null) await tryStopStream()
      else await tryStartStream(plan, mode)
      return
    }

    logShortcutDecision(reason, mode, 'start', keyEvent, plan.mode)
    await tryStart(plan, mode)
  }

  const tryStartStream = async (
    plan: RunnableDictationPlan,
    shortcutMode: 'hybrid' | 'holdOnly'
  ) => {
    if (isBusy()) return
    const claim = streamClaim('shortcut')
    claimDictation(claim)
    await startStream(plan, shortcutMode, true, claim)
  }

  /**
   * One Live Transcription session. The caller has claimed the Dictation; every way out of
   * here ends that claim exactly once, through `end`.
   */
  const startStream = async (
    plan: RunnableDictationPlan,
    shortcutMode: 'hybrid' | 'holdOnly',
    /** Shortcut presses arm the hold gate; a command-line start has no key held down. */
    armHoldGate: boolean,
    claim: DictationClaim,
    hooks: {
      onStarted?(): void
      onEnded?(end: StreamEnd): void
    } = {}
  ) => {
    streamStarting = true
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = Date.now()
    const streamDebugId = ++streamDebugSeq
    activeStreamShortcutMode = shortcutMode
    let ended = false
    const end = (how: StreamEnd) => {
      if (ended) return
      ended = true
      if (streamEnd === end) streamEnd = null
      releaseDictation(claim)
      hooks.onEnded?.(how)
    }
    try {
      const streamDeviceRef = await resolveStreamDeviceRef()
      log('stream', 'starting Parakeet stream session', {
        streamTranscriptionMode: appConfig.getStreamTranscriptionMode(),
        speechModelId: plan.speechModelId,
        shortcutMode,
        startedBy: claim.startedBy,
        streamDebugId,
        deviceRef: streamDeviceRef,
      })
      if (appConfig.getSoundEffectsEnabled())
        playStartSound(appConfig.getFunModeEnabled())
      setTrayStreaming()
      onStatusChange?.('streaming')
      const started = await startParakeetStream(
        plan,
        appConfig.getStreamTranscriptionMode(),
        {
          onStopped: () => {
            log('stream', 'stream session onStopped (process exit)', {
              streamDebugId,
            })
            streamSession = null
            activeStreamShortcutMode = null
            setTrayIdle()
            onStatusChange?.('ready')
            end({ status: 'stopped' })
          },
        },
        {
          streamDebugId,
          startAudioDucking: () => startAudioDucking(appConfig),
          deviceRef: streamDeviceRef,
        }
      )
      // The pre-spawn race check lost: the helper or the weights went away between building
      // the plan and spawning. Same four surfaces as any other blocked Dictation.
      if (started.status === 'blocked') {
        streamSession = null
        activeStreamShortcutMode = null
        resetHoldGate()
        setTrayIdle()
        onStatusChange?.('ready')
        end({ status: 'blocked', plan: started.plan })
        await reportBlockedDictation(started.plan)
        return
      }
      streamSession = started.session
      streamEnd = end
      hooks.onStarted?.()
      if (pendingStreamHoldReleaseWhileStarting && streamSession !== null) {
        resetHoldGate()
        await tryStopStream()
      } else if (streamSession !== null) {
        if (shortcutMode === 'hybrid' && armHoldGate) armHoldGateAfterStart()
        else resetHoldGate()
      }
    } catch (err) {
      log('stream', 'failed to start stream session', {
        err: String(err),
        streamDebugId,
      })
      streamSession = null
      activeStreamShortcutMode = null
      resetHoldGate()
      setTrayIdle()
      onStatusChange?.('ready')
      end({ status: 'error', message: 'Live transcription could not start' })
    } finally {
      streamStarting = false
      if (streamSession === null) {
        activeStreamShortcutMode = null
        pendingStreamHoldReleaseWhileStarting = false
        pendingStreamHoldReleaseStartedAtMs = 0
      }
    }
  }

  const tryStopStream = async () => {
    if (streamSession === null) return
    const streamDebugId = streamSession.streamDebugId
    log('stream', 'stopping stream session', { streamDebugId })
    const session = streamSession
    const end = streamEnd
    streamSession = null
    streamEnd = null
    activeStreamShortcutMode = null
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = 0
    resetHoldGate()
    try {
      await stopParakeetStream(session)
    } finally {
      setTrayIdle()
      onStatusChange?.('ready')
      end?.({ status: 'stopped' })
    }
  }

  const tryStop = async () => {
    if (!recorderProc || sessionStopping) return
    sessionStopping = true
    resetHoldGate()
    try {
      log('shortcut', 'stopping recorder session', {
        activeRecordingMode: activeRecordingMode ?? undefined,
      })
      const proc = recorderProc
      await stopRecording(proc)
      recorderProc = null
    } finally {
      sessionStopping = false
      activeRecordingMode = null
    }
  }

  const tryStart = async (
    plan: RunnableDictationPlan,
    mode: 'hybrid' | 'holdOnly'
  ) => {
    if (isBusy()) return
    const claim = batchClaim('shortcut')
    claimDictation(claim)
    await startBatch(plan, mode, true, shortcutDelivery(claim))
  }

  /**
   * One Batch Dictation's recording. The caller has claimed the Dictation; the claim is
   * released when the capture is handled (`handleCaptureFinished`), or here when the
   * recorder could not be started at all.
   */
  const startBatch = async (
    plan: RunnableDictationPlan,
    mode: 'hybrid' | 'holdOnly',
    /** Shortcut presses arm the hold gate; a command-line start has no key held down. */
    armHoldGate: boolean,
    delivery: DictationDelivery
  ) => {
    sessionStarting = true
    pendingHoldReleaseWhileStarting = false
    pendingStopWhileStarting = false
    pendingCancelWhileStarting = false
    pendingHoldReleaseStartedAtMs = Date.now()
    activeRecordingMode = mode
    try {
      log('shortcut', 'starting recorder session', {
        mode,
        planMode: plan.mode,
        speechModelId: plan.speechModelId,
        startedBy: delivery.claim.startedBy,
      })
      if (appConfig.getSoundEffectsEnabled())
        playStartSound(appConfig.getFunModeEnabled())
      setTrayRecording()
      onStatusChange?.('recording')
      const session: RecordingSession = {
        discard: false,
        startedAtMs: Date.now(),
      }
      recordingSession = session
      let languageCheck: LanguageWhileRecording | null = null
      recorderProc = await startRecording(
        appConfig,
        plan,
        session,
        (capture) =>
          handleCaptureFinished(
            plan,
            session,
            capture,
            delivery,
            languageCheck
          ),
        getAudioDevices
      )

      const discardNow =
        pendingHoldReleaseWhileStarting || pendingCancelWhileStarting
      if (discardNow && recordingSession && recorderProc) {
        resetHoldGate()
        activeRecordingMode = null
        recordingSession.discard = true
        const p = recorderProc
        recorderProc = null
        setTrayIdle()
        onStatusChange?.('ready')
        if (pendingCancelWhileStarting && appConfig.getSoundEffectsEnabled())
          playCancelSound()
        p.kill('SIGINT')
        await p.exited
      } else if (recorderProc) {
        languageCheck = startLanguageWhileRecording(plan, {
          recordingPath: RECORDING_PATH,
          startedAtMs: session.startedAtMs,
          ignoreLeadingMs: startChimeMs() + 150,
          modelPath: modelManager.getModelPath(plan.speechModelId),
        })
        if (mode === 'hybrid' && armHoldGate) armHoldGateAfterStart()
        else resetHoldGate()
        delivery.onRecording?.(session)
        if (pendingStopWhileStarting) await tryStop()
      }
    } catch (err) {
      // No recorder, so no capture will ever arrive to release the claim.
      log('mic', 'failed to start recording', { err: String(err) })
      recorderProc = null
      recordingSession = null
      resetHoldGate()
      releaseDictation(delivery.claim)
      setTrayIdle()
      onStatusChange?.('ready')
      delivery.onFinished?.({
        status: 'error',
        message: 'The microphone recording could not start',
      })
    } finally {
      sessionStarting = false
      pendingStopWhileStarting = false
      pendingCancelWhileStarting = false
      if (recorderProc === null) activeRecordingMode = null
    }
  }

  const handleKeyEvent = async (keyEvent: KeyEvent) => {
    if (
      isWindowsComboTriggerReleaseEvent(appConfig.getShortcutId(), keyEvent)
    ) {
      return
    }
    if (
      appConfig.getShortcutHoldOnlyId() !== null &&
      isWindowsComboTriggerReleaseEvent(
        appConfig.getShortcutHoldOnlyId()!,
        keyEvent
      )
    ) {
      return
    }

    if (
      keyEvent.keyDown &&
      keyEvent.keycode === Key.enter &&
      !keyEvent.isRepeat
    ) {
      finishObservedCorrection()
    }

    const hybrid = getHybridShortcut()
    const holdOnly = getHoldOnlyShortcut()

    // A Dictation started by an instance `index.ts` has since replaced (settings change,
    // permission refresh) is still the user's: a press of the shortcut stops it and Escape
    // cancels it, as they would have in the instance that started it.
    const foreign = currentDictation()
    if (foreign !== null && foreign.owner !== instance) {
      if (keyEvent.keyDown && !keyEvent.isRepeat) {
        if (keyEvent.keycode === Key.escape) {
          foreign.cancel()
        } else if (
          hybrid.matchesToggleDown(keyEvent) ||
          holdOnly?.matchesToggleDown(keyEvent) === true
        ) {
          foreign.stop()
        }
      }
      return
    }

    if (streamSession !== null) {
      const activeStreamShortcut =
        activeStreamShortcutMode === 'holdOnly' && holdOnly !== null
          ? holdOnly
          : hybrid
      if (activeStreamShortcut.matchesHoldUp(keyEvent)) {
        if (holdArmTimer !== null) clearHoldArmTimer()
        const releaseStops =
          activeStreamShortcutMode === 'holdOnly' || holdQualified
        if (releaseStops && activeStreamShortcutMode !== null) {
          logShortcutDecision(
            'hold release (stream)',
            activeStreamShortcutMode,
            'stop',
            keyEvent
          )
          await tryStopStream()
        }
        return
      }
    }

    if (keyEvent.keycode === Key.escape && keyEvent.keyDown) {
      if (streamSession !== null) {
        log('shortcut', 'escape stopping active stream session')
        if (appConfig.getSoundEffectsEnabled()) playCancelSound()
        void tryStopStream()
        return
      }
      if (discardRecording()) return
    }

    if (recorderProc !== null) {
      const def =
        activeRecordingMode === 'holdOnly' && holdOnly !== null
          ? holdOnly
          : hybrid

      if (def.matchesHoldUp(keyEvent)) {
        if (
          activeRecordingMode === 'hybrid' &&
          !isWindowsModifierReleaseEvent(appConfig.getShortcutId(), keyEvent)
        ) {
          return
        }
        if (sessionStarting) {
          pendingHoldReleaseWhileStarting =
            activeRecordingMode === 'holdOnly' ||
            Date.now() - pendingHoldReleaseStartedAtMs >=
              DICTATION_HOLD_QUALIFY_MS
        }
        if (holdArmTimer !== null) clearHoldArmTimer()
        const releaseStops = activeRecordingMode === 'holdOnly' || holdQualified
        if (releaseStops) await tryStop()
        return
      }
      if (
        activeRecordingMode === 'hybrid' &&
        hybrid.matchesToggleDown(keyEvent) &&
        !keyEvent.isRepeat
      ) {
        resetHoldGate()
        await tryStop()
      }
      return
    }

    if (transcriptionPipelineActive || sessionStarting) return

    if (streamStarting) {
      if (
        activeStreamShortcutMode === 'hybrid' &&
        hybrid.matchesHoldUp(keyEvent)
      ) {
        if (
          !isWindowsModifierReleaseEvent(appConfig.getShortcutId(), keyEvent)
        ) {
          return
        }
        if (holdArmTimer !== null) clearHoldArmTimer()
        if (
          holdQualified ||
          Date.now() - pendingStreamHoldReleaseStartedAtMs >=
            DICTATION_HOLD_QUALIFY_MS
        ) {
          pendingStreamHoldReleaseWhileStarting = true
        }
        return
      }
      if (
        activeStreamShortcutMode === 'holdOnly' &&
        holdOnly !== null &&
        holdOnly.matchesHoldUp(keyEvent)
      ) {
        pendingStreamHoldReleaseWhileStarting = true
        return
      }
      return
    }

    const hybridId = appConfig.getShortcutId()
    const holdId = appConfig.getShortcutHoldOnlyId()

    const fnGlobeDef = getShortcutDefinition('fn-globe')
    const deferFnGlobeForFnChord =
      holdOnly !== null && holdFnChordConflictsWithFnGlobeMain(hybridId, holdId)

    if (deferFnGlobeForFnChord) {
      if (pendingFnGlobeHybridDefer) {
        if (holdOnly.matchesToggleDown(keyEvent) && !keyEvent.isRepeat) {
          pendingFnGlobeHybridDefer = false
          await routeShortcutAction(
            'holdOnly',
            keyEvent,
            'fn-globe deferred hold-only'
          )
          return
        }
        if (fnGlobeDef.matchesHoldUp(keyEvent)) {
          pendingFnGlobeHybridDefer = false
          await routeShortcutAction(
            'hybrid',
            keyEvent,
            'fn-globe deferred hybrid'
          )
          return
        }
        if (
          keyEvent.keyDown &&
          !keyEvent.isRepeat &&
          !FN_GLOBE_DEFER_CANCEL_SUPPRESS.has(keyEvent.keycode)
        ) {
          pendingFnGlobeHybridDefer = false
          // Fall through: e.g. unrelated key — may match nothing.
        } else {
          return
        }
      } else if (
        hybrid.matchesToggleDown(keyEvent) &&
        !keyEvent.isRepeat &&
        FN_PHYSICAL_KEYCODES.includes(
          keyEvent.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
        )
      ) {
        pendingFnGlobeHybridDefer = true
        return
      }
    } else {
      pendingFnGlobeHybridDefer = false
    }

    if (
      holdOnly !== null &&
      holdOnly.matchesToggleDown(keyEvent) &&
      !keyEvent.isRepeat
    ) {
      await routeShortcutAction('holdOnly', keyEvent, 'direct hold-only')
      return
    }
    if (hybrid.matchesToggleDown(keyEvent) && !keyEvent.isRepeat) {
      await routeShortcutAction('hybrid', keyEvent, 'direct hybrid')
    }
  }

  const relayPermissions = onPermissions
    ? (status: PermissionStatus) => {
        void (async () => {
          let microphone = status.microphone
          try {
            microphone = await checkMicrophoneAuthorization()
          } catch {
            /* MicRecorder missing in some dev setups — keep KeyListener value */
          }
          onPermissions({ ...status, microphone })
        })()
      }
    : undefined

  startObserverHelper(
    async ({ original, corrected }) => {
      const outcome = await appConfig.stageAutoLearnCorrection(
        original,
        corrected
      )
      log('observer', 'processed auto-learn candidate', {
        original,
        corrected,
        outcome,
      })
      if (outcome === 'committed') {
        onAutoLearnedEntry?.()
      }
    },
    async ({ currentText, candidatesFound }) => {
      if (candidatesFound > 0) return
      const removed =
        await appConfig.invalidateDictionaryCandidatesForText(currentText)
      if (removed.length === 0) return
      log('observer', 'discarded pending auto-learn candidates', {
        currentText,
        removed: removed.map((candidate) => ({
          from: candidate.from,
          to: candidate.to,
          corrections: candidate.corrections,
        })),
      })
    },
    () => appConfig.getDictionaryAutoLearn(),
    () => appConfig.getDictionaryEntries()
  )

  const keyboard = startKeyboardListener(
    (keyEvent) => {
      void handleKeyEvent(keyEvent)
    },
    getMergedSwallowRules(),
    relayPermissions
  )

  const stopActiveParakeetStream = async () => {
    await tryStopStream()
  }

  /** How long the start chime plays into the microphone as the recording opens. */
  const startChimeMs = () =>
    appConfig.getSoundEffectsEnabled()
      ? duckDelayAfterStartChimeMs(appConfig.getFunModeEnabled())
      : 0

  /**
   * Follows the recording as it is written and calls `onEnd` once the user has spoken and
   * then paused (`dictation/end-of-speech.ts`). The start chime is skipped, since it plays
   * into the microphone as the recording opens.
   */
  const watchForEndOfSpeech = (
    startedAtMs: number,
    onEnd: () => void
  ): GrowingWavWatcher => {
    const detector = createEndOfSpeechDetector({
      ignoreLeadingMs: startChimeMs() + 150,
    })
    let meter: ((samples: Int16Array) => void) | null = null
    let ended = false
    return watchGrowingWav({
      path: RECORDING_PATH,
      startedAtMs,
      onSamples: (samples, sampleRate) => {
        meter ??= createLevelMeter(
          Math.round(
            (sampleRate * DEFAULT_END_OF_SPEECH_OPTIONS.frameMs) / 1000
          ),
          (levelDb) => {
            if (ended || !detector.push(levelDb)) return
            ended = true
            log('mic', 'end of speech heard (--until silence)')
            onEnd()
          }
        )
        meter(samples)
      },
    })
  }

  /**
   * A Dictation from `codictate dictate`. The same Dictation the shortcut runs: the plan
   * comes from the one resolver, and the sounds, tray, indicator, History and Stats are the
   * shortcut's. While it records, the Dictation Shortcut stops it and Escape cancels it, as
   * for a tapped Dictation.
   *
   * What differs: `output: 'stdout'` hands the Outcome back without pasting and is always a
   * Batch Dictation, because a Live Transcription has no Outcome to hand back. `'cursor'`
   * pastes like the shortcut and honours the Live Transcription setting. Overrides apply to
   * this plan only and never write settings.
   */
  const startCommandLineDictation = async (
    options: CommandLineDictationOptions
  ): Promise<CommandLineDictationStart> => {
    if (isBusy()) return { status: 'busy' }

    const fromOverrides =
      options.speechModelId !== null || options.transcriptionLanguageId !== null
    const plan = appConfig.getDictationPlanFor({
      speechModelId: options.speechModelId,
      transcriptionLanguageId: options.transcriptionLanguageId,
      forceBatch: options.output === 'stdout',
    })
    if (plan.status === 'blocked') {
      log('command-line', 'dictation blocked', {
        reason: plan.reason,
        fromOverrides,
      })
      // From the settings alone, a blocked plan means the world changed under them: the
      // shortcut's surfaces and heal pass, so the next Dictation works. A blocked override
      // usually says nothing about the settings, and the caller already has the reason; Add
      // punctuation with its Punctuation Model gone is the exception, healed whatever the
      // selection. Awaited, so the heal has run before the caller is told it has.
      if (blockedPlanHealsSettings(plan.reason, { fromOverrides })) {
        await reportBlockedDictation(plan)
      }
      return { status: 'blocked', plan, fromOverrides }
    }
    if (plan.mode === 'live' && options.until === 'silence') {
      return { status: 'unsupported', message: SILENCE_WITH_LIVE_MESSAGE }
    }

    let settle: (result: CommandLineDictationResult) => void = () => {}
    const result = new Promise<CommandLineDictationResult>((resolve) => {
      settle = resolve
    })
    const appMaxSeconds = appConfig.getMaxRecordingDurationSeconds()
    let maxTimer: ReturnType<typeof setTimeout> | null = null
    let silenceWatcher: GrowingWavWatcher | null = null
    const stopEndings = () => {
      if (maxTimer !== null) clearTimeout(maxTimer)
      maxTimer = null
      silenceWatcher?.stop()
      silenceWatcher = null
    }
    const audioSeconds = (ms: number) => Math.round(ms / 100) / 10

    if (plan.mode === 'live') {
      const claim = streamClaim('command-line')
      claimDictation(claim)
      void onDictationPlan?.(plan)
      let startedAtMs = 0
      let cancelled = false
      // The Parakeet helper has no maximum of its own, so both limits are timed here.
      const limitSeconds = Math.min(
        options.maxSeconds ?? appMaxSeconds,
        appMaxSeconds
      )
      void startStream(plan, 'hybrid', false, claim, {
        onStarted: () => {
          startedAtMs = Date.now()
          options.onEvent({ type: 'recording' })
          maxTimer = setTimeout(() => claim.stop(), limitSeconds * 1000)
        },
        onEnded: (end) => {
          stopEndings()
          if (end.status === 'blocked') {
            settle({ status: 'blocked', plan: end.plan })
          } else if (end.status === 'error') {
            settle({ status: 'error', message: end.message })
          } else if (cancelled || startedAtMs === 0) {
            settle({ status: 'cancelled' })
          } else {
            options.onEvent({ type: 'transcribing' })
            settle({
              status: 'ok',
              text: '',
              rawText: '',
              formattingModeId: null,
              pasted: true,
              live: true,
              plan,
              audioSeconds: audioSeconds(Date.now() - startedAtMs),
            })
          }
        },
      })
      return {
        status: 'started',
        stop: () => {
          claim.stop()
        },
        cancel: () => {
          cancelled = true
          claim.cancel()
        },
        result,
      }
    }

    const transcription = new AbortController()
    const claim = batchClaim('command-line', transcription)
    claimDictation(claim)
    void onDictationPlan?.(plan)
    void startBatch(plan, 'hybrid', false, {
      claim,
      paste: options.output === 'cursor',
      raw: options.raw,
      formattingModeId: options.formattingModeId,
      signal: transcription.signal,
      onRecording: (session) => {
        options.onEvent({ type: 'recording' })
        // Codictate's own maximum is enforced by the recorder; a shorter one is timed here.
        if (options.maxSeconds !== null && options.maxSeconds < appMaxSeconds) {
          maxTimer = setTimeout(() => claim.stop(), options.maxSeconds * 1000)
        }
        if (options.until === 'silence') {
          silenceWatcher = watchForEndOfSpeech(session.startedAtMs, () =>
            claim.stop()
          )
        }
      },
      onTranscribing: () => {
        stopEndings()
        options.onEvent({ type: 'transcribing' })
      },
      onFinished: (finish) => {
        stopEndings()
        switch (finish.status) {
          case 'cancelled':
          case 'error':
            settle(finish)
            return
          case 'failed':
            settle({ status: 'failed', failure: finish.failure, plan })
            return
          case 'empty':
            settle({
              status: 'ok',
              text: '',
              rawText: '',
              formattingModeId: null,
              pasted: false,
              live: false,
              plan,
              audioSeconds: audioSeconds(finish.durationMs),
            })
            return
          case 'ok':
            settle({
              status: 'ok',
              text: finish.outcome.output,
              rawText: finish.outcome.rawTranscript,
              formattingModeId: finish.outcome.formattingModeId,
              pasted: finish.pasted,
              live: false,
              plan,
              audioSeconds: audioSeconds(finish.outcome.durationMs),
            })
        }
      },
    })
    return {
      status: 'started',
      stop: () => {
        claim.stop()
      },
      cancel: () => claim.cancel(),
      result,
    }
  }

  const commandLine: CommandLineDictationControl = {
    startCommandLineDictation,
    stopAnyDictation,
    getActiveDictation: activeDictationStatus,
  }

  return {
    ...keyboard,
    stopActiveParakeetStream,
    ...commandLine,
  }
}
