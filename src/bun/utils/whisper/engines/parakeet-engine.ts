/**
 * The Parakeet Speech Engine Adapter: one batch transcription on the Parakeet Native Helper.
 *
 * Batch only. Live Transcription stays outside this interface - the helper captures the mic
 * and pastes for itself, so there is nothing to return - and lives in
 * `parakeet-stream-runner.ts`. See docs/adr/0006-dictation-returns-an-outcome.md.
 */

import { existsSync } from 'node:fs'
import { getPlatform } from '../../../platform'
import { log } from '../../logger'
import { awaitParakeetWarmup } from '../parakeet-warmup'
import {
  decodeEngineStderr,
  decodeEngineStdout,
  drainReadableStream,
} from './drain-stream'
import { parseParakeetFinalText } from './parakeet-output'
import {
  failedTranscription,
  type ParakeetTranscriptionRequest,
  type SpeechEngineAdapter,
} from './transcription'

export const transcribeWithParakeet: SpeechEngineAdapter<
  ParakeetTranscriptionRequest
> = async (request) => {
  // Serialise behind an in-flight preparation rather than racing it. Recording is already
  // over by the time this runs and the indicator says "transcribing", so the wait is visible
  // and it is the same compile this spawn would otherwise have paid for itself.
  await awaitParakeetWarmup()

  // The pre-spawn race check, both halves: the Native Helper is still in the installation,
  // and the weights are still on disk. Whether that directory is *complete* was answered
  // when the plan was built; what a race can change is whether it is there at all.
  let helper: string
  try {
    helper = getPlatform().findParakeetHelperBinary()
  } catch (err) {
    log('parakeet', 'helper binary missing at spawn time', {
      err: err instanceof Error ? err.message : String(err),
    })
    return failedTranscription('engine_runtime_missing', request.speechModelId)
  }
  if (!existsSync(request.modelDir)) {
    log('parakeet', 'weights missing at spawn time', {
      modelId: request.speechModelId,
      modelDir: request.modelDir,
    })
    return failedTranscription('engine_runtime_missing', request.speechModelId)
  }

  log('parakeet', 'spawning CodictateParakeetHelper transcribe', {
    helper,
    modelDir: request.modelDir,
  })

  const proc = Bun.spawn(
    [helper, 'transcribe', request.audioPath, request.modelDir],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
      },
    }
  )

  const stderrPromise = drainReadableStream(proc.stderr)
  const stdoutPromise = drainReadableStream(proc.stdout)
  await proc.exited
  const stderrText = decodeEngineStderr(await stderrPromise)
  const stdoutBytes = await stdoutPromise

  if (stderrText.trim()) {
    log('parakeet', 'helper stderr', { text: stderrText.slice(0, 4000) })
  }

  if (proc.exitCode !== 0) {
    log('parakeet', 'helper exited non-zero', { exitCode: proc.exitCode })
    return failedTranscription('engine_exited_nonzero', request.speechModelId)
  }

  const stdoutText = decodeEngineStdout(stdoutBytes)
  if (stdoutText === null) {
    log('parakeet', 'helper stdout was not UTF-8', {
      byteLength: stdoutBytes.length,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId
    )
  }

  // `null` is no `final` line at all, which means the helper died or changed protocol.
  // A `final` line carrying an empty string is a silent Dictation and a success.
  const text = parseParakeetFinalText(stdoutText)
  if (text === null) {
    log('parakeet', 'helper emitted no final line', {
      stdoutLength: stdoutText.length,
    })
    return failedTranscription('parakeet_no_final_line', request.speechModelId)
  }

  const rawTranscript = text.trim()

  log('parakeet', 'transcription complete', {
    exitCode: proc.exitCode,
    transcriptLength: rawTranscript.length,
  })

  return { status: 'ok', rawTranscript }
}
