/**
 * The crispasr Speech Engine Adapter: one Whisper or hviske transcription, spawned.
 *
 * ADR-0002's Harness seam does not move. This adapter does not assemble argv - it calls
 * `buildWhisperHarnessCommand`, which owns the flag set and the backend-and-translate
 * invariant - and it makes no decision the Dictation Plan already made. What it adds is the
 * spawn, the drain, and turning what came back into a Transcription Result.
 *
 * The transcript comes from the JSON file crispasr writes into a directory made for this one
 * run (ADR-0010), never from stdout, which is drained and ignored. On the `nt-vad` path the
 * same directory holds the slices Codictate cut the recording into (`slices.json`, read by
 * `--vad-import`). The directory is removed on every way out.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '../../logger'
import { buildWhisperHarnessCommand } from '../whisper-harness-command'
import { crispasrTranscript, parseCrispasrJson } from './crispasr-json'
import { decodeEngineStderr, stderrTail } from './drain-stream'
import { lowerProcessPriority } from './process-priority'
import { superviseProcess } from './process-supervisor'
import {
  failedTranscription,
  type HarnessTranscriptionRequest,
  type SpeechEngineAdapter,
} from './transcription'
import {
  planVadSlices,
  readWavSamples,
  vadImportJson,
  type VadSliceOptions,
} from './vad-slices'

/**
 * crispasr's own words when a `--backend` run (`nt-vad`) has no speech to decode: it exits 0
 * and writes no JSON file (upstream #311, `crispasr_run.cpp`). A silent recording is a
 * success with an empty transcript, so this one missing file is not a failure. Codictate
 * does not spawn for a recording it cut into no slices, so on `nt-vad` this is only reached
 * if crispasr dropped every imported slice as out of range. The `timestamps` path writes
 * `"transcription": []` instead.
 */
const NO_SPEECH_DETECTED = 'no speech detected'

/** What cutting a recording for an `nt-vad` decode came to. */
export type NtVadSlicing =
  | { status: 'written'; slices: number }
  /** Nothing loud enough to be speech: an empty transcript, and nothing to spawn. */
  | { status: 'no_speech' }
  | { status: 'failed'; detail: string }

/**
 * Cuts the recording at pauses into slices of 30 s or less (`planVadSlices`, issue #83) and
 * writes them where the `nt-vad` argv reads them with `--vad-import`.
 *
 * Every recording that reaches the adapter is a WAV Codictate wrote or chose: MicRecorder and
 * the Windows Helper's `record` write 16 kHz mono 16-bit, the Media Helper and the Windows
 * Helper's `extract-audio` decode every File Transcription (the command line's too) to the
 * same, and the benchmark and the long-audio check read their datasets' WAVs. So a recording
 * that does not read as a WAV is a failure, not a format to hand to crispasr's own reader
 * without cuts: that is the decode that loses speech (ADR-0005, no fallbacks).
 */
export function writeNtVadSlices(
  audioPath: string,
  slicesPath: string,
  options?: Partial<VadSliceOptions>
): NtVadSlicing {
  let audio: ReturnType<typeof readWavSamples>
  try {
    audio = readWavSamples(new Uint8Array(readFileSync(audioPath)))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      detail: `audio is not a readable WAV: ${detail}`,
    }
  }
  const slices = planVadSlices(audio.samples, audio.sampleRate, options)
  if (slices.length === 0) return { status: 'no_speech' }
  try {
    writeFileSync(slicesPath, vadImportJson(slices, audio.sampleRate))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { status: 'failed', detail: `no slices file: ${detail}` }
  }
  return { status: 'written', slices: slices.length }
}

/**
 * Knobs the long-audio check measures with (issue #83): the slice cap, beam search and the
 * dictation prompt on `nt-vad`. The app never passes any, so it runs the defaults.
 */
export interface NtVadTuning {
  sliceOptions?: Partial<VadSliceOptions>
  beamSearch?: boolean
  /** `false` drops the prompt; unset, the Speech Model's own (`ntVadPromptForModel`). */
  prompt?: boolean
}

export const transcribeWithCrispasr: SpeechEngineAdapter<
  HarnessTranscriptionRequest
> = (request) => transcribeWithCrispasrTuned(request, {})

/** `transcribeWithCrispasr` with `nt-vad` measurement knobs. Only the long-audio check. */
export async function transcribeWithCrispasrTuned(
  request: HarnessTranscriptionRequest,
  tuning: NtVadTuning
): ReturnType<SpeechEngineAdapter<HarnessTranscriptionRequest>> {
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

  let outputDir: string
  try {
    outputDir = mkdtempSync(join(tmpdir(), 'codictate-crispasr-'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log('whisper', 'no temp directory for the crispasr JSON', { err: detail })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      `no temp directory for the JSON output: ${detail}`
    )
  }
  try {
    return await transcribeInto(outputDir, request, tuning)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

async function transcribeInto(
  outputDir: string,
  request: HarnessTranscriptionRequest,
  tuning: NtVadTuning
): ReturnType<SpeechEngineAdapter<HarnessTranscriptionRequest>> {
  let command
  try {
    // The binary half of the same check: `findAsrHarnessBinary` throws with its remediation
    // when crispasr is not in the bundle, and so does the Silero VAD lookup (`timestamps`)
    // when the bundled weights are missing. The other throw in here - translate on a pinned
    // backend - is a last-resort invariant that settings-heal and the plan builder make
    // unreachable, so it lands on the same reason rather than earning a fifth one.
    command = await buildWhisperHarnessCommand({
      crispasrBackend: request.crispasrBackend ?? undefined,
      speechModelId: request.speechModelId,
      jsonOutputBase: join(outputDir, 'transcript'),
      vadImportPath: join(outputDir, 'slices.json'),
      ntVadBeamSearch: tuning.beamSearch,
      ntVadPrompt: tuning.prompt,
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

  if (request.signal?.aborted) {
    return failedTranscription('cancelled', request.speechModelId)
  }

  // `nt-vad` decodes Codictate's own cuts. A recording with nothing to cut is silent, and
  // gets the same empty transcript crispasr's `no speech detected` does, without a spawn. One
  // that cannot be read lands where the temp directory failure does: Codictate could not read
  // what this run needs, before crispasr ever started.
  let slices: number | undefined
  if (command.vadImportPath !== null) {
    const slicing = writeNtVadSlices(
      request.audioPath,
      command.vadImportPath,
      tuning.sliceOptions
    )
    if (slicing.status === 'no_speech') {
      log('whisper', 'transcription complete: no speech detected', {
        harness: command.harness,
        decoding: command.decoding,
        slices: 0,
      })
      return { status: 'ok', rawTranscript: '', timedTranscript: null }
    }
    if (slicing.status === 'failed') {
      log('whisper', 'no slices for the nt-vad decode', {
        modelId: request.speechModelId,
        audioPath: request.audioPath,
        err: slicing.detail,
      })
      return failedTranscription(
        'engine_output_unreadable',
        request.speechModelId,
        slicing.detail
      )
    }
    slices = slicing.slices
  }

  log('whisper', 'spawning ASR harness', {
    harness: command.harness,
    backend: command.crispasrBackend,
    decoding: command.decoding,
    binary: command.binary,
    model: request.modelPath,
    whisperLanguageCode: command.languageArg,
    languageMode: command.languageArg === 'auto' ? 'auto-detect' : 'fixed',
    modelId: request.speechModelId,
    translateToEnglish: request.translateToEnglish,
    lowPriority: request.lowPriority === true,
    slices,
  })

  const proc = Bun.spawn(command.argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: request.signal,
    env: {
      ...process.env,
      // Avoid C locale / missing UTF-8 so the ASR Harness prints a UTF-8 transcript
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    },
  })

  if (request.lowPriority) lowerProcessPriority(proc.pid, 'whisper')

  const supervised = await superviseProcess(proc, {
    stdout: proc.stdout,
    stderr: proc.stderr,
    timeoutMs: request.timeoutMs,
  })
  const stderrText = decodeEngineStderr(supervised.stderr)
  // Aborting the signal kills the process, which then looks like any other non-zero exit.
  // The caller asked for that, so it is a cancellation and not an engine failure.
  if (request.signal?.aborted) {
    log('whisper', 'ASR harness cancelled', { modelId: request.speechModelId })
    return failedTranscription('cancelled', request.speechModelId)
  }
  if (supervised.status === 'timed_out') {
    log('whisper', 'ASR harness timed out', {
      harness: command.harness,
      timeoutMs: request.timeoutMs,
      stderr: stderrText.slice(0, 500) || undefined,
    })
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
  if (supervised.exitCode !== 0) {
    log('whisper', 'ASR harness exited non-zero', {
      harness: command.harness,
      exitCode: supervised.exitCode,
      stderr: stderrText.slice(0, 500) || undefined,
    })
    return failedTranscription(
      'engine_exited_nonzero',
      request.speechModelId,
      `exit ${supervised.exitCode}: ${stderrTail(stderrText)}`
    )
  }

  // Stdout is crispasr's display output. It was drained so the pipe never fills; the
  // transcript is in the JSON file.
  let jsonBytes: Uint8Array
  try {
    jsonBytes = new Uint8Array(readFileSync(command.jsonPath))
  } catch {
    if (stderrText.includes(NO_SPEECH_DETECTED)) {
      log('whisper', 'transcription complete: no speech detected', {
        harness: command.harness,
        decoding: command.decoding,
      })
      return { status: 'ok', rawTranscript: '', timedTranscript: null }
    }
    log('whisper', 'ASR harness wrote no JSON', {
      harness: command.harness,
      decoding: command.decoding,
      stdoutBytes: supervised.stdout.length,
      stderr: stderrText.slice(0, 500) || undefined,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      `exit 0 but no ${command.jsonPath}: ${stderrTail(stderrText)}`
    )
  }

  const parsed = parseCrispasrJson(jsonBytes)
  if (!parsed.ok) {
    log('whisper', 'ASR harness JSON unreadable', {
      harness: command.harness,
      decoding: command.decoding,
      reason: parsed.reason,
      byteLength: jsonBytes.length,
      detail: parsed.detail,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      parsed.detail
    )
  }

  const { rawTranscript, timedTranscript } = crispasrTranscript(
    parsed,
    command.decoding
  )

  log('whisper', 'transcription complete', {
    harness: command.harness,
    decoding: command.decoding,
    exitCode: supervised.exitCode,
    transcriptLength: rawTranscript.length,
    segments: parsed.segments.length,
    timedParts: timedTranscript?.parts.length ?? 0,
    language: parsed.language,
    stderr: stderrText.slice(0, 500) || undefined,
  })

  return { status: 'ok', rawTranscript, timedTranscript }
}
