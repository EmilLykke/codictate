import { AppConfig } from '../../AppConfig/AppConfig'
import { speech2text, type Speech2TextResult } from '../whisper/speech2text'
import { duckDelayAfterStartChimeMs, playEndSound } from '../sound/play-sound'
import { findMicRecorderBinary } from './find-mic-recorder'
import { findDevices, type AudioDeviceSnapshot } from './devices'
import { log } from '../logger'
import { stat } from 'node:fs/promises'
import { RECORDING_PATH } from '../../platform/runtime'
import { getPlatformRuntime } from '../../platform/runtime'
import { getSpeechModel } from '../../../shared/speech-models'

/** Set `discard: true` before killing the recorder so onExit skips transcription and UI handoff. */
export type RecordingSession = { discard: boolean; startedAtMs: number }

const MIN_VALID_RECORDING_MS = 180

function readAscii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('ascii')
}

function estimateWavDurationMsFromBuffer(buf: Buffer): number | null {
  if (buf.length < 44) return null
  if (readAscii(buf, 0, 4) !== 'RIFF') return null
  if (readAscii(buf, 8, 12) !== 'WAVE') return null

  let off = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataSize = 0

  while (off + 8 <= buf.length) {
    const chunkId = readAscii(buf, off, off + 4)
    const chunkSize = buf.readUInt32LE(off + 4)
    const dataStart = off + 8
    off += 8 + chunkSize + (chunkSize % 2)
    if (chunkId === 'fmt ') {
      if (dataStart + 16 > buf.length) return null
      channels = buf.readUInt16LE(dataStart + 2)
      sampleRate = buf.readUInt32LE(dataStart + 4)
      bitsPerSample = buf.readUInt16LE(dataStart + 14)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return null
  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!bytesPerFrame || !Number.isInteger(bytesPerFrame)) return null
  return Math.floor((dataSize / bytesPerFrame / sampleRate) * 1000)
}

async function shouldSkipTranscriptionForShortCapture(
  session: RecordingSession
): Promise<{
  skip: boolean
  reason?: 'missing-file' | 'stale-file' | 'too-short'
  sizeBytes?: number
  durationMs?: number
}> {
  try {
    const fileStats = await stat(RECORDING_PATH)
    const wavFile = Bun.file(RECORDING_PATH)
    const durationMs = estimateWavDurationMsFromBuffer(
      Buffer.from(await wavFile.arrayBuffer())
    )
    const durationForResult = durationMs ?? undefined
    const fileLooksFresh = fileStats.mtimeMs >= session.startedAtMs - 50

    if (!fileLooksFresh) {
      return {
        skip: true,
        reason: 'stale-file',
        sizeBytes: fileStats.size,
        durationMs: durationForResult,
      }
    }

    if ((durationMs ?? 0) < MIN_VALID_RECORDING_MS) {
      return {
        skip: true,
        reason: 'too-short',
        sizeBytes: fileStats.size,
        durationMs: durationForResult,
      }
    }

    return {
      skip: false,
      sizeBytes: fileStats.size,
      durationMs: durationForResult,
    }
  } catch {
    return { skip: true, reason: 'missing-file' }
  }
}

export const startRecording = async (
  appConfig: AppConfig,
  onComplete: () => void,
  onDone: () => void,
  session: RecordingSession,
  /** Live snapshot from the main process (refreshed at startup + on an interval). Avoids spawning `MicRecorder --list-devices` on every shortcut press. */
  getDeviceSnapshot?: () => AudioDeviceSnapshot,
  onHistorySave?: (transcript: string) => Promise<void>,
  onStatsSave?: (result: Speech2TextResult, durationMs: number) => Promise<void>
) => {
  if (appConfig.getStreamMode()) {
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

        const forceCancelled =
          exitCode === 255 || exitCode === 143 || exitCode === 137
        const recordingCheck =
          session.discard || forceCancelled
            ? { skip: false as const }
            : await shouldSkipTranscriptionForShortCapture(session)
        const skipPipeline =
          session.discard || forceCancelled || recordingCheck.skip

        if (recordingCheck.skip) {
          log('mic', 'skipping transcription for invalid capture', {
            reason: recordingCheck.reason,
            sizeBytes: recordingCheck.sizeBytes,
            durationMs: recordingCheck.durationMs,
            minDurationMs: MIN_VALID_RECORDING_MS,
          })
        }

        // onDone() releases the transcription pipeline. It has to run on the failure path
        // too: the caller treats it as the only signal that the pipeline is free again, so
        // an escaping throw here used to leave `transcriptionPipelineActive` true for the
        // rest of the process and every later Dictation was refused until restart. A failed
        // Dictation must cost one Dictation, not all of them.
        try {
          if (!skipPipeline) {
            onComplete()
            if (appConfig.getSoundEffectsEnabled())
              playEndSound(appConfig.getFunModeEnabled())
            const result = await speech2text(
              appConfig.getRuntimeTranscriptionWhisperCode(),
              appConfig.getWhisperModelId(),
              appConfig.getTranslateToEnglish(),
              appConfig.getFormattingRuntimeSettings(),
              appConfig.getDictionaryEntries(),
              () => appConfig.acceptPreviouslyAppliedEntries(),
              (entries) => appConfig.notifyAppliedEntries(entries)
            )
            if (onHistorySave) {
              try {
                await onHistorySave(result.output)
              } catch (err) {
                log('history', 'failed to save entry', { err: String(err) })
              }
            }
            if (onStatsSave) {
              try {
                await onStatsSave(result, recordingCheck.durationMs ?? 0)
              } catch (err) {
                log('stats', 'failed to save session', { err: String(err) })
              }
            }
            if (
              getSpeechModel(appConfig.getWhisperModelId())?.engine ===
                'whisperkit' &&
              !appConfig.isParakeetCoreMlReady()
            ) {
              await appConfig.markParakeetCoreMlReady()
            }
          }
        } catch (err) {
          log('whisper', 'transcription pipeline failed', {
            err: err instanceof Error ? err.message : String(err),
          })
        } finally {
          onDone()
        }
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
