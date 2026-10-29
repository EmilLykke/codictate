import { requireRuntimeBinary } from '../../platform/binaries'
// Parakeet stream mode: spawn the platform Parakeet helper. The helper captures mic,
// runs the model, and pastes — nothing is read from stdout.
//
// Live-mode tracing: set CODICTATE_LIVE_DEBUG=1 in the environment before starting
// Codictate; stderr lines tagged stream [live][debug] are forwarded below as parakeet stderr.

import type { StreamTranscriptionMode } from '../../../shared/types'
import {
  blockedDictationPlan,
  type BlockedDictationPlan,
  type RunnableDictationPlan,
} from '../../../shared/dictation-plan'
import { modelManager } from './model-manager'
import { log } from '../logger'
import type { AudioDucking } from '../audio/audio-ducking'

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
  /**
   * Audio Ducking for the length of the stream: started just before the helper is spawned and
   * stopped when it exits.
   */
  startAudioDucking?: () => Promise<AudioDucking>
  /**
   * The Microphone for the helper to record from: its stable id (CoreAudio device UID on
   * macOS, endpoint ID on Windows), or the `--list-devices` index when it has none.
   */
  deviceRef?: string
}

/**
 * Either the stream started, or it did not and here is why in Dictation Plan shape.
 *
 * The blocked arm is what `assertParakeetStreamRuntimeReady` used to throw. ADR-0005 keeps
 * the check - the gap between building a plan and spawning the helper is where a race lands,
 * so the last check before the spawn stays - but a thrown `Error` was the worst of the three
 * old failure modes: the caller caught it, discarded it, and the shortcut press did nothing
 * at all. A blocked plan has to be carried, not raised.
 */
export type ParakeetStreamStartResult =
  | { status: 'started'; session: StreamSession }
  | { status: 'blocked'; plan: BlockedDictationPlan }

/**
 * The pre-spawn race check, in plan shape.
 *
 * Not a competing definition of readiness: it re-asks only the two questions that a race can
 * change between the plan and the spawn - the Native Helper is still on disk, and so are the
 * weights - and it answers with the same closed reason union the plan builder uses.
 */
function checkParakeetStreamRuntimeReady(
  plan: RunnableDictationPlan
): BlockedDictationPlan | null {
  try {
    requireRuntimeBinary('parakeet')
  } catch {
    return blockedDictationPlan(
      'live',
      'parakeet_helper_missing',
      plan.speechModelId
    )
  }
  if (!modelManager.isModelAvailable(plan.speechModelId)) {
    return blockedDictationPlan(
      'live',
      'parakeet_not_installed',
      plan.speechModelId
    )
  }
  return null
}

export async function startParakeetStream(
  /** The run to start. The Speech Model comes from here, not from a constant in this file. */
  plan: RunnableDictationPlan,
  streamTranscriptionMode: StreamTranscriptionMode,
  handlers: StreamHandlers,
  options?: ParakeetStreamStartOptions
): Promise<ParakeetStreamStartResult> {
  const blocked = checkParakeetStreamRuntimeReady(plan)
  if (blocked !== null) return { status: 'blocked', plan: blocked }

  // No `awaitParakeetWarmup()` here, unlike a Batch Dictation. This helper opens the
  // microphone itself, before it loads the model, so waiting on the background load would
  // lose everything said during it - up to a whole Parakeet Preparation. Spawning beside the
  // background load is safe: two helpers preparing the same weights at once both finish
  // (measured: both exit 0, just slower), and the next load is fast.

  const binary = requireRuntimeBinary('parakeet')
  const modelDir = modelManager.getParakeetInstallDir(plan.speechModelId)
  const modeArg = streamTranscriptionMode === 'vad' ? 'vad' : 'live'
  const args = [binary, 'stream', modeArg, modelDir]
  if (options?.deviceRef) args.push(options.deviceRef)
  const streamDebugId = options?.streamDebugId

  log('stream', 'spawning Parakeet helper (helper handles capture + paste)', {
    binary,
    streamArgs: args.slice(1),
    streamTranscriptionMode,
    speechModelId: plan.speechModelId,
    modelDir,
    deviceRef: options?.deviceRef,
    streamDebugId,
  })

  const ducking = await options?.startAudioDucking?.()
  let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'>
  try {
    proc = Bun.spawn(args, {
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
      env: {
        ...process.env,
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
        ...(streamDebugId != null
          ? { CODICTATE_STREAM_DEBUG_ID: String(streamDebugId) }
          : {}),
      },
    })
  } catch (err) {
    await ducking?.stop()
    throw err
  }

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

  void proc.exited.then(async () => {
    await ducking?.stop()
    log('stream', 'parakeet stream process exited', {
      exitCode: proc.exitCode,
      streamDebugId,
    })
    handlers.onStopped()
  })

  return { status: 'started', session: { proc, streamDebugId } }
}

export async function stopParakeetStream(
  session: StreamSession
): Promise<void> {
  session.proc.kill('SIGINT')
  await session.proc.exited
}
