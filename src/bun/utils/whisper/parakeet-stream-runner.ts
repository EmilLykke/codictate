// Parakeet stream mode: spawn the platform Parakeet helper. The helper captures mic,
// runs the model, and pastes — nothing is read from stdout.
//
// Live-mode tracing: set CODICTATE_LIVE_DEBUG=1 in the environment before starting
// Codictate; stderr lines tagged stream [live][debug] are forwarded below as parakeet stderr.

import type { StreamTranscriptionMode } from '../../../shared/types'
import { getPlatform } from '../../platform'
import { modelManager } from './model-manager'
import { log } from '../logger'
import { duckDelayAfterStartChimeMs } from '../sound/play-sound'

export type StreamHandlers = {
  onStopped: () => void
}

export type StreamSession = {
  proc: ReturnType<typeof Bun.spawn>
  streamDebugId?: number
}

export type ParakeetStreamStartOptions = {
  /** Log correlation: forwarded to helper as `CODICTATE_STREAM_DEBUG_ID` (stderr prefix `[sN]`). */
  streamDebugId?: number
  /** When false, helper skips muting built-in output (default true). */
  outputDuckBuiltIn?: boolean
  /** When true, helper also ducks headphone / Bluetooth / USB output. */
  outputDuckHeadphones?: boolean
  /** Duck target for enabled outputs: 0 = fully mute, 100 = no change. */
  outputDuckLevel?: number
  /** Windows helper input device ref: stable endpoint ID preferred, numeric index fallback. */
  deviceRef?: string
}

const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v3'

export function assertParakeetStreamRuntimeReady(): void {
  getPlatform().findParakeetHelperBinary()
  if (!modelManager.isModelAvailable(PARAKEET_MODEL_ID)) {
    throw new Error(
      'Parakeet model is not installed. Download Parakeet TDT v3 in Settings to use stream mode.'
    )
  }
}

export async function startParakeetStream(
  streamTranscriptionMode: StreamTranscriptionMode,
  handlers: StreamHandlers,
  options?: ParakeetStreamStartOptions
): Promise<StreamSession> {
  assertParakeetStreamRuntimeReady()
  const binary = getPlatform().findParakeetHelperBinary()
  const modelDir = modelManager.getParakeetInstallDir(PARAKEET_MODEL_ID)
  const modeArg = streamTranscriptionMode === 'vad' ? 'vad' : 'live'
  const args = [binary, 'stream', modeArg, modelDir]
  if (options?.deviceRef) args.push(options.deviceRef)
  const streamDebugId = options?.streamDebugId
  const outputDuckDelayMs = duckDelayAfterStartChimeMs()
  const outputDuckBuiltIn = options?.outputDuckBuiltIn !== false
  const outputDuckHeadphones = options?.outputDuckHeadphones === true
  const outputDuckLevel = Math.max(
    0,
    Math.min(100, Math.round(options?.outputDuckLevel ?? 0))
  )

  log('stream', 'spawning Parakeet helper (helper handles capture + paste)', {
    binary,
    streamArgs: args.slice(1),
    streamTranscriptionMode,
    modelDir,
    deviceRef: options?.deviceRef,
    streamDebugId,
    outputDuckDelayMs,
    outputDuckBuiltIn,
    outputDuckHeadphones,
    outputDuckLevel,
  })

  const proc = Bun.spawn(args, {
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      ...process.env,
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
      CODICTATE_OUTPUT_DUCK_DELAY_MS: String(outputDuckDelayMs),
      CODICTATE_OUTPUT_DUCK_LEVEL: String(outputDuckLevel),
      CODICTATE_OUTPUT_DUCK_HEADPHONES: outputDuckHeadphones ? '1' : '0',
      ...(!outputDuckBuiltIn ? { CODICTATE_OUTPUT_DUCK_BUILT_IN: '0' } : {}),
      ...(streamDebugId != null
        ? { CODICTATE_STREAM_DEBUG_ID: String(streamDebugId) }
        : {}),
    },
  })

  log('stream', 'spawned Parakeet stream process', {
    pid: proc.pid,
    streamDebugId,
  })

  void (async () => {
    try {
      const reader = proc.stderr.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (t) log('stream', 'parakeet stderr', { text: t.slice(0, 500) })
        }
      }
    } catch (err) {
      log('stream', 'parakeet stderr read error', { err: String(err) })
    }
  })()

  void proc.exited.then(() => {
    log('stream', 'parakeet stream process exited', {
      exitCode: proc.exitCode,
      streamDebugId,
    })
    handlers.onStopped()
  })

  return { proc, streamDebugId }
}

export async function stopParakeetStream(
  session: StreamSession
): Promise<void> {
  session.proc.kill('SIGINT')
  await session.proc.exited
}
