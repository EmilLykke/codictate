import {
  startRecording,
  stopRecording,
  type RecordingSession,
} from './utils/audio/start-rec'
import {
  startParakeetStream,
  stopParakeetStream,
  type StreamSession,
} from './utils/whisper/parakeet-stream-runner'
import {
  finishObservedCorrection,
  FN_PHYSICAL_KEYCODES,
  getShortcutDefinition,
  Key,
  KeyCode,
  SHORTCUTS,
  startKeyboardListener,
  type KeyEvent,
  type PermissionStatus,
} from './utils/keyboard/keyboard-events'
import { playCancelSound, playStartSound } from './utils/sound/play-sound'
import { AppConfig } from './AppConfig/AppConfig'
import type { TrayHandlers } from './setup-tray'
import { findDevices, type AudioDeviceSnapshot } from './utils/audio/devices'
import { DICTATION_HOLD_QUALIFY_MS } from '../shared/dictation-shortcut'
import type { AppStatus, ShortcutId } from '../shared/types'
import { windowsUsesModifierReleaseHold } from '../shared/shortcut-options'
import { checkMicrophoneAuthorization } from './utils/audio/check-mic-authorization'
import { log } from './utils/logger'
import { startObserverHelper } from './utils/keyboard/observer-helper'
import { getPlatformRuntime } from './platform/runtime'

/** Keycodes that should not cancel "wait for Fn chord" when main is fn-globe + hold is fn-* (non-globe). */
const FN_GLOBE_DEFER_CANCEL_SUPPRESS = new Set<number>([
  Key.shift,
  Key.rightShift,
  Key.command,
  Key.rightCommand,
  Key.option,
  Key.rightOption,
  Key.control,
  Key.rightControl,
  ...FN_PHYSICAL_KEYCODES,
])

function holdFnChordConflictsWithFnGlobeMain(
  hybridId: ShortcutId,
  holdId: ShortcutId | null
): holdId is ShortcutId {
  return (
    hybridId === 'fn-globe' &&
    holdId !== null &&
    holdId.startsWith('fn-') &&
    holdId !== 'fn-globe'
  )
}

/** Main shortcuts that use ⌥ + a trigger key. */
const OPTION_CHORD_MAIN_IDS = new Set<ShortcutId>([
  'option-space',
  'option-enter',
])

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
  }: TrayHandlers,
  onStatusChange?: (status: AppStatus) => void,
  onPermissions?: (status: PermissionStatus) => void,
  getAudioDevices?: () => AudioDeviceSnapshot,
  onAutoLearnedEntry?: () => void
) => {
  let recorderProc: ReturnType<typeof Bun.spawn> | null = null
  let recordingSession: RecordingSession | null = null
  let sessionStarting = false
  let sessionStopping = false
  let transcriptionPipelineActive = false
  let pendingHoldReleaseWhileStarting = false
  let pendingHoldReleaseStartedAtMs = 0
  let pendingStreamHoldReleaseWhileStarting = false
  let pendingStreamHoldReleaseStartedAtMs = 0

  // Stream mode state
  let streamSession: StreamSession | null = null
  let streamStarting = false
  /** When stream was started via push-to-talk, release must stop (unlike hybrid tap-to-toggle). */
  let activeStreamShortcutMode: 'hybrid' | 'holdOnly' | null = null
  /** Monotonic id for log correlation with Parakeet helper stderr (`[sN]`). */
  let streamDebugSeq = 0

  const resolveStreamDeviceRef = async (): Promise<string | undefined> => {
    if (getPlatformRuntime() !== 'windows') return undefined

    let currentSnapshot = getAudioDevices?.() ?? { devices: {}, details: {} }
    if (Object.keys(currentSnapshot.devices).length === 0) {
      currentSnapshot = await findDevices()
    }

    const currentDevices = currentSnapshot.devices
    const currentDeviceDetails = currentSnapshot.details
    const resolved = appConfig.resolveAudioDevice(
      currentDevices,
      currentDeviceDetails
    )
    const deviceExists = resolved.toString() in currentDevices
    const device = deviceExists
      ? resolved
      : Number(Object.keys(currentDevices)[0] ?? '0')
    const deviceLabel = currentDevices[device.toString()]?.trim() || 'default'
    const deviceId = currentDeviceDetails[device.toString()]?.id ?? null
    const deviceRef = deviceId ?? String(device)

    log('stream', 'resolved stream audio device', {
      index: device,
      name: deviceLabel,
      requestedIndex: resolved,
      endpointId: deviceId ?? undefined,
      deviceRef,
      deviceExists,
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
    OPTION_CHORD_MAIN_IDS.has(appConfig.getShortcutId())

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
    switch (shortcutId) {
      case 'option-space':
      case 'option-enter':
        return (
          !keyEvent.keyDown &&
          (keyEvent.keycode === Key.option ||
            keyEvent.keycode === Key.rightOption)
        )
      case 'control-space':
      case 'control-enter':
        return (
          !keyEvent.keyDown &&
          (keyEvent.keycode === Key.control ||
            keyEvent.keycode === Key.rightControl)
        )
      default:
        return true
    }
  }

  const isWindowsComboTriggerReleaseEvent = (
    shortcutId: ShortcutId,
    keyEvent: KeyEvent
  ): boolean => {
    if (!usesWindowsModifierReleaseHold(shortcutId)) return false
    return (
      !keyEvent.keyDown &&
      (keyEvent.keycode === Key.space || keyEvent.keycode === Key.enter)
    )
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
    action: 'start' | 'stop',
    keyEvent?: KeyEvent
  ) => {
    log('shortcut', 'routing shortcut', {
      reason,
      mode,
      action,
      streamMode: appConfig.getStreamMode(),
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

  const routeShortcutAction = async (
    mode: 'hybrid' | 'holdOnly',
    keyEvent: KeyEvent,
    reason: string
  ) => {
    const streamMode = appConfig.getStreamMode()
    if (!streamMode && streamSession !== null) {
      log('shortcut', 'stopping orphan Parakeet stream (stream mode off)')
      await tryStopStream()
    }
    if (streamMode) {
      logShortcutDecision(
        reason,
        mode,
        streamSession !== null ? 'stop' : 'start',
        keyEvent
      )
      if (streamSession !== null) await tryStopStream()
      else await tryStartStream(mode)
      return
    }

    logShortcutDecision(reason, mode, 'start', keyEvent)
    await tryStart(mode)
  }

  const tryStartStream = async (shortcutMode: 'hybrid' | 'holdOnly') => {
    if (!appConfig.getStreamMode()) return
    if (
      streamSession !== null ||
      streamStarting ||
      recorderProc !== null ||
      transcriptionPipelineActive
    )
      return
    streamStarting = true
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = Date.now()
    const streamDebugId = ++streamDebugSeq
    activeStreamShortcutMode = shortcutMode
    try {
      const streamDeviceRef = await resolveStreamDeviceRef()
      log('stream', 'starting Parakeet stream session', {
        streamMode: appConfig.getStreamMode(),
        streamTranscriptionMode: appConfig.getStreamTranscriptionMode(),
        whisperModelId: appConfig.getWhisperModelId(),
        shortcutMode,
        streamDebugId,
        deviceRef: streamDeviceRef,
      })
      playStartSound(appConfig.getFunModeEnabled())
      setTrayStreaming()
      onStatusChange?.('streaming')
      streamSession = await startParakeetStream(
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
          },
        },
        {
          streamDebugId,
          outputDuckBuiltIn: appConfig.getAudioDuckingIncludeBuiltInSpeakers(),
          outputDuckHeadphones: appConfig.getAudioDuckingIncludeHeadphones(),
          outputDuckLevel: appConfig.getAudioDuckingLevel(),
          deviceRef: streamDeviceRef,
        }
      )
      if (pendingStreamHoldReleaseWhileStarting && streamSession !== null) {
        resetHoldGate()
        await tryStopStream()
      } else if (streamSession !== null) {
        if (shortcutMode === 'hybrid') armHoldGateAfterStart()
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
    streamSession = null
    activeStreamShortcutMode = null
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = 0
    resetHoldGate()
    await stopParakeetStream(session)
    setTrayIdle()
    onStatusChange?.('ready')
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

  const tryStart = async (mode: 'hybrid' | 'holdOnly') => {
    if (
      recorderProc !== null ||
      sessionStarting ||
      transcriptionPipelineActive
    ) {
      return
    }
    sessionStarting = true
    pendingHoldReleaseWhileStarting = false
    pendingHoldReleaseStartedAtMs = Date.now()
    activeRecordingMode = mode
    try {
      log('shortcut', 'starting recorder session', {
        mode,
        streamMode: appConfig.getStreamMode(),
      })
      playStartSound(appConfig.getFunModeEnabled())
      setTrayRecording()
      onStatusChange?.('recording')
      recordingSession = { discard: false, startedAtMs: Date.now() }
      recorderProc = await startRecording(
        appConfig,
        () => {
          recorderProc = null
          transcriptionPipelineActive = true
          activeRecordingMode = null
          setTrayTranscribing()
          onStatusChange?.('transcribing')
        },
        () => {
          transcriptionPipelineActive = false
          recordingSession = null
          setTrayIdle()
          onStatusChange?.('ready')
        },
        recordingSession,
        getAudioDevices
      )

      if (pendingHoldReleaseWhileStarting && recordingSession && recorderProc) {
        resetHoldGate()
        activeRecordingMode = null
        recordingSession.discard = true
        const p = recorderProc
        recorderProc = null
        setTrayIdle()
        onStatusChange?.('ready')
        p.kill('SIGINT')
        await p.exited
      } else if (recorderProc) {
        if (mode === 'hybrid') armHoldGateAfterStart()
        else resetHoldGate()
      }
    } finally {
      sessionStarting = false
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

    if (streamSession !== null && appConfig.getStreamMode()) {
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
        playCancelSound()
        void tryStopStream()
        return
      }
      if (recorderProc) {
        resetHoldGate()
        activeRecordingMode = null
        if (recordingSession) recordingSession.discard = true
        recorderProc.kill()
        recorderProc = null
        setTrayIdle()
        onStatusChange?.('ready')
        playCancelSound()
        return
      }
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

    if (streamStarting && appConfig.getStreamMode()) {
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

    const fnGlobeDef = SHORTCUTS['fn-globe']
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

  return {
    ...keyboard,
    stopActiveParakeetStream,
  }
}
