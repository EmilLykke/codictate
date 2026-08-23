/**
 * The crispasr Speech Engine Adapter: one Whisper or hviske transcription, spawned.
 *
 * ADR-0002's Harness seam does not move. This adapter does not assemble argv - it calls
 * `buildWhisperHarnessCommand`, which owns the flag set and the backend-and-translate
 * invariant - and it makes no decision the Dictation Plan already made. What it adds is the
 * spawn, the drain, and turning what came back into a Transcription Result.
 */

import { existsSync } from 'node:fs'
import { log } from '../../logger'
import { buildWhisperHarnessCommand } from '../whisper-harness-command'
import {
  decodeEngineStderr,
  decodeEngineStdout,
  drainReadableStream,
  stderrTail,
} from './drain-stream'
import {
  failedTranscription,
  type HarnessTranscriptionRequest,
  type SpeechEngineAdapter,
} from './transcription'

export const transcribeWithCrispasr: SpeechEngineAdapter<
  HarnessTranscriptionRequest
> = async (request) => {
  // The pre-spawn race check, weights half. The plan said these were installed; a Finder
  // delete, a failed disk or a cloud-storage eviction between then and now is exactly the
  // gap ADR-0005 keeps a last check for.
  if (!existsSync(request.modelPath)) {
    log('whisper', 'weights missing at spawn time', {
      modelId: request.speechModelId,
      modelPath: request.modelPath,
    })
    return failedTranscription(
      'engine_runtime_missing',
      request.speechModelId,
      `weights not on disk: ${request.modelPath}`
    )
  }

  let command
  try {
    // The binary half of the same check: `findAsrHarnessBinary` throws with its remediation
    // when crispasr is not in the bundle. The other throw in here - translate on a pinned
    // backend - is a last-resort invariant that settings-heal and the plan builder make
    // unreachable, so it lands on the same reason rather than earning a fifth one.
    command = await buildWhisperHarnessCommand({
      crispasrBackend: request.crispasrBackend ?? undefined,
      modelPath: request.modelPath,
      language: request.languageCode,
      audioPath: request.audioPath,
      translateToEnglish: request.translateToEnglish,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log('whisper', 'ASR harness command unavailable', {
      modelId: request.speechModelId,
      err: detail,
    })
    return failedTranscription(
      'engine_runtime_missing',
      request.speechModelId,
      detail
    )
  }

  log('whisper', 'spawning ASR harness', {
    harness: command.harness,
    backend: command.crispasrBackend,
    binary: command.binary,
    model: request.modelPath,
    whisperLanguageCode: command.languageArg,
    languageMode: command.languageArg === 'auto' ? 'auto-detect' : 'fixed',
    modelId: request.speechModelId,
    translateToEnglish: request.translateToEnglish,
  })

  const proc = Bun.spawn(command.argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Avoid C locale / missing UTF-8 so the ASR Harness prints a UTF-8 transcript
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    },
  })

  const stderrPromise = drainReadableStream(proc.stderr)
  const stdoutPromise = drainReadableStream(proc.stdout)
  await proc.exited
  const stderrText = decodeEngineStderr(await stderrPromise)
  const stdoutBytes = await stdoutPromise

  if (proc.exitCode !== 0) {
    log('whisper', 'ASR harness exited non-zero', {
      harness: command.harness,
      exitCode: proc.exitCode,
      stderr: stderrText.slice(0, 500) || undefined,
    })
    return failedTranscription(
      'engine_exited_nonzero',
      request.speechModelId,
      `exit ${proc.exitCode}: ${stderrTail(stderrText)}`
    )
  }

  const stdoutText = decodeEngineStdout(stdoutBytes)
  if (stdoutText === null) {
    log('whisper', 'ASR harness stdout was not UTF-8', {
      harness: command.harness,
      byteLength: stdoutBytes.length,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      `${stdoutBytes.length} bytes of stdout were not UTF-8`
    )
  }

  const rawTranscript = stdoutText.trim()

  log('whisper', 'transcription complete', {
    harness: command.harness,
    exitCode: proc.exitCode,
    transcriptLength: rawTranscript.length,
    stderr: stderrText.slice(0, 500) || undefined,
  })

  return { status: 'ok', rawTranscript }
}
