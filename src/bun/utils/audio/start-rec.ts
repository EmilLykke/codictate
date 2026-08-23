import { AppConfig } from '../../AppConfig/AppConfig'
import { duckDelayAfterStartChimeMs } from '../sound/play-sound'
import { findMicRecorderBinary } from './find-mic-recorder'
import { findDevices, type AudioDeviceSnapshot } from './devices'
import { log } from '../logger'
import { stat } from 'node:fs/promises'
import { RECORDING_PATH } from '../../platform/runtime'
import { getPlatformRuntime } from '../../platform/runtime'
import type { RunnableDictationPlan } from '../../../shared/dictation-plan'
import { estimateWavDurationMsFromBytes } from '../../../shared/wav-duration'

/** Set `discard: true` before killing the recorder so onExit reports a cancelled capture. */
export type RecordingSession = { discard: boolean; startedAtMs: number }

const MIN_VALID_RECORDING_MS = 180

/** Why a capture is not worth transcribing. Never a user-facing failure: see `CaptureResult`. */
export type CaptureSkipReason = 'missing-file' | 'stale-file' | 'too-short'

/**
 * What the recorder produced, handed to the caller the moment the mic process exits.
 *
 * The WAV inspection stays in this module because it reads WAV bytes; what moved out is the
 * decision, which is the caller's - it owns the chime, the pipeline and the tray. A skipped
 * capture is silence, not a failure: nothing is pasted, nothing is recorded, no error chime.
 * See docs/adr/0006-dictation-returns-an-outcome.md.
 */
export interface CaptureResult {
  /** The WAV the recorder wrote. A parameter from here on, never re-read from the global. */
  audioPath: string
  /** The capture's own length, or 0 when the WAV could not be measured. */
  durationMs: number
  /** The user cancelled, or the recorder was killed. There is no audio to look at. */
  discarded: boolean
  /** Why this capture is not worth transcribing, or `null` when it is. */
  skipReason: CaptureSkipReason | null
}

async function inspectCapture(
  session: RecordingSession
): Promise<CaptureResult> {
  const audioPath = RECORDING_PATH
  let fileStats: Awaited<ReturnType<typeof stat>>
  let durationMs: number
  try {
    fileStats = await stat(audioPath)
    durationMs =
      estimateWavDurationMsFromBytes(
        new Uint8Array(await Bun.file(audioPath).arrayBuffer())
      ) ?? 0
  } catch {
    log('mic', 'capture not worth transcribing', { reason: 'missing-file' })
    return {
      audioPath,
      durationMs: 0,
      discarded: false,
      skipReason: 'missing-file',
    }
  }

  const fileLooksFresh = fileStats.mtimeMs >= session.startedAtMs - 50
  const skipReason: CaptureSkipReason | null = !fileLooksFresh
    ? 'stale-file'
    : durationMs < MIN_VALID_RECORDING_MS
      ? 'too-short'
      : null

  if (skipReason !== null) {
    log('mic', 'capture not worth transcribing', {
      reason: skipReason,
      sizeBytes: fileStats.size,
      durationMs,
      minDurationMs: MIN_VALID_RECORDING_MS,
    })
  }

  return { audioPath, durationMs, discarded: false, skipReason }
}

/**
 * Capture one Dictation's audio. A recorder and nothing else.
 *
 * It used to run the whole pipeline inside the mic process's `onExit` - transcription,
 * formatting, paste, history and stats - which put every post-Dictation surface in the audio
 * module. What is left is the capture and one honest report of what it produced. See
 * docs/adr/0006-dictation-returns-an-outcome.md.
 */
export const startRecording = async (
  appConfig: AppConfig,
  /** The run this recording feeds, decided before the recorder was spawned. */
  plan: RunnableDictationPlan,
  session: RecordingSession,
  /**
   * The capture is over. A callback rather than a resolved promise, and awaited inside
   * `onExit` where it is called: `session.discard` can flip after the recorder is spawned and
   * before the mic process exits, so the answer only exists at this moment.
   */
  onCaptureFinished: (capture: CaptureResult) => Promise<void>,
  /** Live snapshot from the main process (refreshed at startup + on an interval). Avoids spawning `MicRecorder --list-devices` on every shortcut press. */
  getDeviceSnapshot?: () => AudioDeviceSnapshot
) => {
  if (plan.mode !== 'batch') {
    log(
      'stream',
      'unexpected fallback into MicRecorder while stream mode is enabled'
    )
  }

  const micPath = await findMicRecorderBinary()

  let currentSnapshot = getDeviceSnapshot?.() ?? { devices: {}, details: {} }
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

  if (!deviceExists) {
    console.warn(
      `[recording] device ${resolved} not available, falling back to device ${device} (${currentDevices[device.toString()] ?? 'unknown'})`
    )
  }

  const deviceLabel = currentDevices[device.toString()]?.trim() || 'default'
  const deviceId = currentDeviceDetails[device.toString()]?.id ?? null

  log('mic', 'resolved audio device', {
    index: device,
    name: deviceLabel,
    requestedIndex: resolved,
    endpointId: deviceId ?? undefined,
    deviceExists,
    binary: micPath,
  })

  const maxRecordSeconds = appConfig.getMaxRecordingDurationSeconds()
  const outputDuckDelayMs = appConfig.getSoundEffectsEnabled()
    ? duckDelayAfterStartChimeMs(appConfig.getFunModeEnabled())
    : 0
  const duckLevel = appConfig.getAudioDuckingLevel()
  const duckIncludeHeadphones = appConfig.getAudioDuckingIncludeHeadphones()
  const duckIncludeBuiltIn = appConfig.getAudioDuckingIncludeBuiltInSpeakers()

  const proc = Bun.spawn(
    [
      micPath,
      'record',
      RECORDING_PATH,
      deviceId ?? String(device),
      String(maxRecordSeconds),
      String(outputDuckDelayMs),
      String(duckLevel),
      duckIncludeHeadphones ? '1' : '0',
      duckIncludeBuiltIn ? '1' : '0',
    ],
    {
      stderr: 'pipe',
      stdin: getPlatformRuntime() === 'windows' ? 'pipe' : 'ignore',
      async onExit(proc, exitCode) {
        let stderrText = ''
        try {
          stderrText = await new Response(proc.stderr).text()
        } catch {
          // Ignore
        }

        log('mic', 'exited', {
          exitCode,
          stderr: stderrText.slice(0, 500) || undefined,
        })

        // A cancelled session is not inspected: the WAV is whatever the killed recorder left
        // behind, and the answer is the same either way.
        const forceCancelled =
          exitCode === 255 || exitCode === 143 || exitCode === 137
        const capture: CaptureResult =
          session.discard || forceCancelled
            ? {
                audioPath: RECORDING_PATH,
                durationMs: 0,
                discarded: true,
                skipReason: null,
              }
            : await inspectCapture(session)

        await onCaptureFinished(capture)
      },
    }
  )

  log('mic', 'spawned', {
    pid: proc.pid,
    outputDuckDelayMs,
  })

  return proc
}

export const stopRecording = async (recorder: ReturnType<typeof Bun.spawn>) => {
  if (getPlatformRuntime() === 'windows') {
    const stdin = recorder.stdin
    if (stdin && typeof stdin !== 'number') {
      try {
        stdin.write('stop\n')
        stdin.flush()
        await Promise.race([
          recorder.exited,
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ])
        if (recorder.exitCode !== null) return
      } catch {
        // fall through to kill
      }
    }
  }
  recorder.kill('SIGINT')
  await recorder.exited
}
