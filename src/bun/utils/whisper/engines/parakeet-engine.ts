/**
 * The Parakeet Speech Engine Adapter: one batch transcription on the Parakeet Native Helper.
 *
 * Two ways to reach the helper, one Result. A Batch Dictation hands in the session it spawned
 * when recording started (`parakeet-session.ts`), so the model has been loading while the
 * user spoke. File Transcription, the `codictate transcribe` command line and the benchmark
 * have no recording phase and spawn the one-shot `transcribe` here.
 *
 * Batch only. Live Transcription stays outside this interface - the helper captures the mic
 * and pastes for itself, so there is nothing to return - and lives in
 * `parakeet-stream-runner.ts`. See docs/adr/0006-dictation-returns-an-outcome.md.
 */

import { log } from '../../logger'
import {
  decodeEngineStderr,
  decodeEngineStdout,
  stderrTail,
} from './drain-stream'
import { parseParakeetFinal } from './parakeet-output'
import {
  checkParakeetRuntime,
  type ParakeetSessionRun,
} from './parakeet-session'
import { parakeetTimedTranscript } from './parakeet-timings'
import { lowerProcessPriority } from './process-priority'
import { superviseProcess } from './process-supervisor'
import {
  failedTranscription,
  type ParakeetTranscriptionRequest,
  type SpeechEngineAdapter,
} from './transcription'

/**
 * The Parakeet Native Helper's batch argv.
 *
 * Exported because the benchmark measures peak RSS by running the same command under
 * `/usr/bin/time` rather than through the adapter, and a second copy of the subcommand and
 * its argument order is a copy that drifts. It is the only piece of this module a caller
 * outside the adapter needs.
 */
export function parakeetTranscribeArgv(
  helperBinary: string,
  audioPath: string,
  modelDir: string
): string[] {
  return [helperBinary, 'transcribe', audioPath, modelDir]
}

export const transcribeWithParakeet: SpeechEngineAdapter<
  ParakeetTranscriptionRequest
> = async (request) => {
  const run = request.session
    ? await request.session.transcribe(request)
    : await transcribeOnce(request)
  if (run.status === 'failed') return run
  const { final } = run

  const rawTranscript = final.text.trim()
  // Timings that do not line up with the transcript leave it untimed, never wrong.
  const timedTranscript = parakeetTimedTranscript(rawTranscript, final.timing)
  if (
    final.timing !== null &&
    rawTranscript !== '' &&
    timedTranscript === null
  ) {
    log('parakeet', 'timing did not line up with the transcript', {
      unit: final.timing.unit,
      items: final.timing.items.length,
    })
  }

  log('parakeet', 'transcription complete', {
    viaSession: request.session !== undefined,
    transcriptLength: rawTranscript.length,
    timedParts: timedTranscript?.parts.length ?? 0,
  })

  return { status: 'ok', rawTranscript, timedTranscript }
}

/** The one-shot `transcribe`: spawn, load, transcribe, exit, under one deadline. */
async function transcribeOnce(
  request: ParakeetTranscriptionRequest
): Promise<ParakeetSessionRun> {
  const checked = checkParakeetRuntime(request.speechModelId, request.modelDir)
  if ('status' in checked) return checked
  const { helper } = checked

  if (request.signal?.aborted) {
    return failedTranscription('cancelled', request.speechModelId)
  }

  log('parakeet', 'spawning CodictateParakeetHelper transcribe', {
    helper,
    modelDir: request.modelDir,
    lowPriority: request.lowPriority === true,
  })

  const proc = Bun.spawn(
    parakeetTranscribeArgv(helper, request.audioPath, request.modelDir),
    {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: request.signal,
      env: {
        ...process.env,
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
      },
    }
  )

  if (request.lowPriority) lowerProcessPriority(proc.pid, 'parakeet')

  const supervised = await superviseProcess(proc, {
    stdout: proc.stdout,
    stderr: proc.stderr,
    timeoutMs: request.timeoutMs,
  })
  const stderrText = decodeEngineStderr(supervised.stderr)
  // Aborting the signal kills the helper, which then looks like any other non-zero exit.
  // The caller asked for that, so it is a cancellation and not an engine failure.
  if (request.signal?.aborted) {
    log('parakeet', 'helper cancelled', { modelId: request.speechModelId })
    return failedTranscription('cancelled', request.speechModelId)
  }

  if (supervised.status === 'timed_out') {
    log('parakeet', 'helper timed out', { timeoutMs: request.timeoutMs })
    return failedTranscription(
      'engine_timed_out',
      request.speechModelId,
      `deadline ${request.timeoutMs} ms: ${stderrTail(stderrText)}`
    )
  }
  if (!supervised.outputComplete) {
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      'process exited but its output pipes did not close'
    )
  }
  const stdoutBytes = supervised.stdout

  if (stderrText.trim()) {
    log('parakeet', 'helper stderr', { text: stderrText.slice(0, 4000) })
  }

  if (supervised.exitCode !== 0) {
    log('parakeet', 'helper exited non-zero', {
      exitCode: supervised.exitCode,
    })
    return failedTranscription(
      'engine_exited_nonzero',
      request.speechModelId,
      `exit ${supervised.exitCode}: ${stderrTail(stderrText)}`
    )
  }

  const stdoutText = decodeEngineStdout(stdoutBytes)
  if (stdoutText === null) {
    log('parakeet', 'helper stdout was not UTF-8', {
      byteLength: stdoutBytes.length,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      `${stdoutBytes.length} bytes of stdout were not UTF-8`
    )
  }

  // `null` is no `final` line at all, which means the helper died or changed protocol.
  // A `final` line carrying an empty string is a silent Dictation and a success.
  const final = parseParakeetFinal(stdoutText)
  if (final === null) {
    log('parakeet', 'helper emitted no final line', {
      stdoutLength: stdoutText.length,
    })
    return failedTranscription(
      'parakeet_no_final_line',
      request.speechModelId,
      stderrTail(stderrText) ||
        `${stdoutText.length} chars of stdout, no final line`
    )
  }

  return { status: 'final', final }
}
