/**
 * The ekko Speech Engine Adapter: RyeAI's ekko-v1-tiny on the `parakeet-cli` ASR Harness.
 *
 * Decided in #76: Codictate cuts the recording itself, with the same VAD slice planner the
 * crispasr `nt-vad` path uses at its defaults (30 s cap, 0.2 s padding, a pause over 1.5 s
 * always ends a slice; no Silero), and runs one `parakeet-cli` per slice, in order, one at a
 * time, for every length and for Dictation and File Transcription alike. Each slice is written
 * as a 16-bit PCM mono WAV into a per-run temp directory that is removed on every way out.
 *
 * One deadline covers the whole Request; each process is supervised with what is left of it.
 * One failed slice fails the whole run and nothing partial is returned (ADR-0005). The output
 * is read by `ekko-output.ts`, which is pure.
 *
 * The Raw Transcript is lowercase and unpunctuated, exactly what ekko said: Punctuation
 * Restoration happens after the adapter, and the benchmark scores this text (ADR-0006).
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
import { EKKO_ASR_HARNESS } from '../../../../shared/asr-harness'
import {
  joinTranscriptPieces,
  timedTranscriptFromPieces,
  type TimedPiece,
} from '../../../../shared/timed-transcript'
import { log } from '../../logger'
import { awaitEkkoWarmup, EKKO_WARMUP_TIMEOUT_MS } from '../ekko-warmup'
import { findAsrHarnessBinary } from '../find-asr-harness'
import { decodeEngineStderr, stderrTail } from './drain-stream'
import {
  ekkoTimedPiece,
  parseParakeetCliJson,
  type EkkoWord,
} from './ekko-output'
import { lowerProcessPriority } from './process-priority'
import {
  superviseProcess,
  type ProcessSupervisorClock,
} from './process-supervisor'
import {
  failedTranscription,
  type EkkoTranscriptionRequest,
  type SpeechEngineAdapter,
  type TranscriptionResult,
} from './transcription'
import {
  planVadSlices,
  readWavSamples,
  type AudioSlice,
  type VadSliceOptions,
} from './vad-slices'

/**
 * The argv of one ekko slice: `parakeet-cli transcribe --model <gguf> --input <wav> --json`.
 *
 * No other flags (`--vad`, `--timestamps`, `--threads`, `--lang`, `--decoder`, beam): the gate
 * (#78) measured the defaults. Exported because the benchmark's memory run, the long-audio
 * check and the warm-up run the same command, and a second copy is a copy that drifts.
 */
export function ekkoSliceArgv(
  binary: string,
  modelPath: string,
  slicePath: string
): string[] {
  return [
    binary,
    'transcribe',
    '--model',
    modelPath,
    '--input',
    slicePath,
    '--json',
  ]
}

/**
 * What ekko adds to the process env. `PARAKEET_ATT_CONTEXT=128` is the attention context the
 * gate (#78) ran with. Spread on top of `process.env` by every caller.
 */
export const EKKO_ENV: Readonly<Record<string, string>> = {
  PARAKEET_ATT_CONTEXT: '128',
}

/** What the adapter needs of a spawned `parakeet-cli`. `Bun.spawn` with two pipes satisfies it. */
export interface EkkoProcess {
  readonly pid?: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

/** The adapter's world. The app uses `realEkkoDeps`; a test passes a fake spawn. */
export interface EkkoDeps {
  /** The `parakeet-cli` path. Throws with its remediation when it is not installed. */
  resolveBinary: () => Promise<string>
  spawn: (
    argv: string[],
    options: { env: Record<string, string | undefined>; signal?: AbortSignal }
  ) => EkkoProcess
  /** Milliseconds, for the Request's one deadline. */
  now: () => number
  lowerPriority: (pid: number) => void
  /** The supervisor's timers. Absent: the real ones. */
  clock?: ProcessSupervisorClock
}

export const realEkkoDeps: EkkoDeps = {
  resolveBinary: () => findAsrHarnessBinary(EKKO_ASR_HARNESS),
  spawn: (argv, { env, signal }) =>
    Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env, signal }),
  now: () => performance.now(),
  lowerPriority: (pid) => {
    lowerProcessPriority(pid, 'ekko')
  },
}

/** Slice options for the long-audio check's slice-length override. The app never passes any. */
export interface EkkoTuning {
  sliceOptions?: Partial<VadSliceOptions>
}

/** A 16-bit PCM mono WAV of `samples[start, end)`, at `sampleRate`. */
export function pcm16MonoWav(
  samples: Float32Array,
  sampleRate: number,
  slice: AudioSlice = { startSample: 0, endSample: samples.length }
): Uint8Array {
  const count = Math.max(0, slice.endSample - slice.startSample)
  const dataBytes = count * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, samples[slice.startSample + i]))
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return bytes
}

/** A recording read and cut the way the adapter cuts it. */
export type EkkoSlicing =
  | {
      ok: true
      samples: Float32Array
      sampleRate: number
      /** Empty for a silent recording. */
      slices: AudioSlice[]
    }
  | { ok: false; detail: string }

/**
 * Reads a WAV and plans its slices exactly as the adapter does. Exported for the benchmark's
 * memory run and the long-audio check, which run `ekkoSliceArgv` on one of these slices.
 */
export function ekkoSlices(
  audioPath: string,
  sliceOptions?: Partial<VadSliceOptions>
): EkkoSlicing {
  let audio: ReturnType<typeof readWavSamples>
  try {
    audio = readWavSamples(new Uint8Array(readFileSync(audioPath)))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `audio is not a readable WAV: ${detail}` }
  }
  return {
    ok: true,
    samples: audio.samples,
    sampleRate: audio.sampleRate,
    slices: planVadSlices(audio.samples, audio.sampleRate, sliceOptions),
  }
}

/**
 * The app adapter. It first waits, bounded, for a warm-up in flight (`ekko-warmup.ts`): that
 * run is paying the setup this one would otherwise pay beside it.
 */
export const transcribeWithEkko: SpeechEngineAdapter<
  EkkoTranscriptionRequest
> = async (request) => {
  await awaitEkkoWarmup()
  return transcribeWithEkkoTuned(request, {})
}

/** The warm-up's audio: half a second of 16 kHz silence. */
const WARMUP_SAMPLE_RATE = 16_000
const WARMUP_SAMPLES = WARMUP_SAMPLE_RATE / 2

/**
 * One warm-up: the slice command, with `EKKO_ENV`, on half a second of silence in its own temp
 * directory, supervised for `EKKO_WARMUP_TIMEOUT_MS`. What it pays for is `parakeet-cli`'s
 * setup (on the Mac the Metal compile, cached by macOS afterwards), not the transcript, which
 * is ignored. Rejects on any failure; `ekko-warmup.ts` logs it.
 */
export async function warmUpEkko(
  modelPath: string,
  deps: EkkoDeps = realEkkoDeps
): Promise<void> {
  if (!existsSync(modelPath)) {
    throw new Error(`ekko GGUF not on disk: ${modelPath}`)
  }
  const binary = await deps.resolveBinary()
  const runDir = mkdtempSync(join(tmpdir(), 'codictate-ekko-warmup-'))
  try {
    const wavPath = join(runDir, 'silence.wav')
    writeFileSync(
      wavPath,
      pcm16MonoWav(new Float32Array(WARMUP_SAMPLES), WARMUP_SAMPLE_RATE)
    )
    log('ekko', 'warming up parakeet-cli', { binary, model: modelPath })
    const proc = deps.spawn(ekkoSliceArgv(binary, modelPath, wavPath), {
      env: { ...process.env, ...EKKO_ENV },
    })
    const supervised = await superviseProcess(proc, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      timeoutMs: EKKO_WARMUP_TIMEOUT_MS,
      clock: deps.clock,
    })
    const stderr = stderrTail(decodeEngineStderr(supervised.stderr))
    if (supervised.status === 'timed_out') {
      throw new Error(`timed out after ${EKKO_WARMUP_TIMEOUT_MS} ms: ${stderr}`)
    }
    if (!supervised.outputComplete) {
      throw new Error(`output pipes did not close: ${stderr}`)
    }
    if (supervised.exitCode !== 0) {
      throw new Error(`exit ${supervised.exitCode}: ${stderr}`)
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
}

/** `transcribeWithEkko` with slice options. Only the long-audio check passes any. */
export async function transcribeWithEkkoTuned(
  request: EkkoTranscriptionRequest,
  tuning: EkkoTuning,
  deps: EkkoDeps = realEkkoDeps
): Promise<TranscriptionResult> {
  const startedAt = deps.now()
  const deadline = startedAt + request.timeoutMs

  if (!existsSync(request.modelPath)) {
    log('ekko', 'GGUF missing at spawn time', {
      modelId: request.speechModelId,
      modelPath: request.modelPath,
    })
    return failedTranscription(
      'engine_runtime_missing',
      request.speechModelId,
      `ekko GGUF not on disk: ${request.modelPath}`
    )
  }
  let binary: string
  try {
    binary = await deps.resolveBinary()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log('ekko', 'parakeet-cli missing at spawn time', { err: detail })
    return failedTranscription(
      'engine_runtime_missing',
      request.speechModelId,
      detail
    )
  }

  const slicing = ekkoSlices(request.audioPath, tuning.sliceOptions)
  if (!slicing.ok) {
    log('ekko', 'recording unreadable', {
      audioPath: request.audioPath,
      err: slicing.detail,
    })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      slicing.detail
    )
  }
  if (slicing.slices.length === 0) {
    log('ekko', 'transcription complete: no speech detected', { slices: 0 })
    return { status: 'ok', rawTranscript: '', timedTranscript: null }
  }

  let runDir: string
  try {
    runDir = mkdtempSync(join(tmpdir(), 'codictate-ekko-'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log('ekko', 'no temp directory for the slices', { err: detail })
    return failedTranscription(
      'engine_output_unreadable',
      request.speechModelId,
      `no temp directory for the slices: ${detail}`
    )
  }
  try {
    const result = await transcribeSlices(
      runDir,
      binary,
      slicing,
      request,
      deps,
      deadline
    )
    if (result.status === 'ok') {
      log('ekko', 'transcription complete', {
        modelId: request.speechModelId,
        slices: slicing.slices.length,
        wallMs: Math.round(deps.now() - startedAt),
        transcriptLength: result.rawTranscript.length,
        timedParts: result.timedTranscript?.parts.length ?? 0,
      })
    }
    return result
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
}

async function transcribeSlices(
  runDir: string,
  binary: string,
  slicing: Extract<EkkoSlicing, { ok: true }>,
  request: EkkoTranscriptionRequest,
  deps: EkkoDeps,
  deadline: number
): Promise<TranscriptionResult> {
  const { samples, sampleRate, slices } = slicing
  log('ekko', 'spawning parakeet-cli', {
    binary,
    model: request.modelPath,
    modelId: request.speechModelId,
    slices: slices.length,
    lowPriority: request.lowPriority === true,
  })

  const texts: string[] = []
  const pieces: TimedPiece[] = []
  for (const [index, slice] of slices.entries()) {
    const where = `slice ${index + 1} of ${slices.length}`
    if (request.signal?.aborted) {
      log('ekko', 'cancelled before a slice', { slice: where })
      return failedTranscription('cancelled', request.speechModelId)
    }
    if (deps.now() >= deadline) {
      log('ekko', 'deadline passed before a slice', {
        slice: where,
        timeoutMs: request.timeoutMs,
      })
      return failedTranscription(
        'engine_timed_out',
        request.speechModelId,
        `${where}: deadline ${request.timeoutMs} ms passed before it started`
      )
    }
    const run = await runSlice(
      runDir,
      binary,
      where,
      index,
      slice,
      samples,
      sampleRate,
      request,
      deps,
      deadline
    )
    if (!run.ok) return run.failure
    texts.push(run.text)
    const piece = ekkoTimedPiece(run, {
      startSeconds: slice.startSample / sampleRate,
      endSeconds: slice.endSample / sampleRate,
    })
    if (piece !== null) pieces.push(piece)
  }

  const rawTranscript = joinTranscriptPieces(texts, { separateDecodes: true })
  const timedTranscript = timedTranscriptFromPieces(rawTranscript, pieces)
  if (timedTranscript === null && rawTranscript !== '') {
    log('ekko', 'word times did not line up with the transcript', {
      slices: slices.length,
      pieces: pieces.length,
    })
  }
  return { status: 'ok', rawTranscript, timedTranscript }
}

type SliceRun =
  | { ok: true; text: string; words: EkkoWord[] }
  | { ok: false; failure: TranscriptionResult }

/** One slice: written, spawned, supervised to what is left of the deadline, and read. */
async function runSlice(
  runDir: string,
  binary: string,
  where: string,
  index: number,
  slice: AudioSlice,
  samples: Float32Array,
  sampleRate: number,
  request: EkkoTranscriptionRequest,
  deps: EkkoDeps,
  deadline: number
): Promise<SliceRun> {
  const fail = (
    reason: Parameters<typeof failedTranscription>[0],
    detail?: string
  ): SliceRun => ({
    ok: false,
    failure: failedTranscription(
      reason,
      request.speechModelId,
      detail === undefined ? undefined : `${where}: ${detail}`
    ),
  })

  const slicePath = join(runDir, `slice-${index}.wav`)
  try {
    writeFileSync(slicePath, pcm16MonoWav(samples, sampleRate, slice))
  } catch (err) {
    return fail(
      'engine_output_unreadable',
      `slice WAV not written: ${String(err)}`
    )
  }

  let proc: EkkoProcess
  try {
    proc = deps.spawn(ekkoSliceArgv(binary, request.modelPath, slicePath), {
      env: { ...process.env, ...EKKO_ENV },
      signal: request.signal,
    })
  } catch (err) {
    // Bun.spawn throws when the binary cannot be started at all (gone, not executable).
    log('ekko', 'could not spawn parakeet-cli', {
      slice: where,
      err: String(err),
    })
    return fail(
      'engine_runtime_missing',
      `could not spawn ${binary}: ${String(err)}`
    )
  }
  if (request.lowPriority && proc.pid !== undefined)
    deps.lowerPriority(proc.pid)

  const supervised = await superviseProcess(proc, {
    stdout: proc.stdout,
    stderr: proc.stderr,
    timeoutMs: Math.max(1, Math.round(deadline - deps.now())),
    clock: deps.clock,
  })
  const stderrText = decodeEngineStderr(supervised.stderr)
  // Aborting the signal kills the process, which then looks like any other non-zero exit.
  // The caller asked for that, so it is a cancellation and not an engine failure.
  if (request.signal?.aborted) {
    log('ekko', 'parakeet-cli cancelled', { slice: where })
    return {
      ok: false,
      failure: failedTranscription('cancelled', request.speechModelId),
    }
  }
  if (supervised.status === 'timed_out') {
    log('ekko', 'parakeet-cli timed out', {
      slice: where,
      timeoutMs: request.timeoutMs,
      stderr: stderrTail(stderrText, 500) || undefined,
    })
    return fail(
      'engine_timed_out',
      `deadline ${request.timeoutMs} ms: ${stderrTail(stderrText)}`
    )
  }
  if (!supervised.outputComplete) {
    return fail(
      'engine_output_unreadable',
      `process exited but its output pipes did not close: ${stderrTail(stderrText)}`
    )
  }
  if (supervised.exitCode !== 0) {
    log('ekko', 'parakeet-cli exited non-zero', {
      slice: where,
      exitCode: supervised.exitCode,
      stderr: stderrTail(stderrText, 500) || undefined,
    })
    return fail(
      'engine_exited_nonzero',
      `exit ${supervised.exitCode}: ${stderrTail(stderrText)}`
    )
  }
  const parsed = parseParakeetCliJson(supervised.stdout)
  if (!parsed.ok) {
    log('ekko', 'parakeet-cli output unreadable', {
      slice: where,
      detail: parsed.detail,
    })
    return fail(
      'engine_output_unreadable',
      `${parsed.detail}: ${stderrTail(stderrText)}`
    )
  }
  return { ok: true, text: parsed.text, words: parsed.words }
}
