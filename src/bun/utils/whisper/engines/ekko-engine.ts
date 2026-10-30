/**
 * The ekko Speech Engine Adapter: RyeAI's ekko-v1-tiny on the `parakeet-cli` ASR Harness.
 *
 * Decided in #76: Codictate cuts the recording itself, with the same VAD slice planner the
 * crispasr `nt-vad` path uses at its defaults (30 s cap, 0.2 s padding, a pause over 1.5 s
 * always ends a slice; no Silero) plus one ekko-only option, `EKKO_VAD_SLICE_OPTIONS` (room
 * noise far under the speech is a pause, #108), and runs one `parakeet-cli` per slice, in
 * order, one at a time, for every length and for Dictation and File Transcription alike. Each slice is written
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
 * (#78) measured the defaults. Every caller reaches it through `ekkoSliceInvocation`.
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
 * gate (#78) ran with. Spread on top of `process.env` by `ekkoSliceInvocation`.
 */
export const EKKO_ENV: Readonly<Record<string, string>> = {
  PARAKEET_ATT_CONTEXT: '128',
}

/** One `parakeet-cli` run on one slice: what to spawn and with which env. */
export interface EkkoSliceInvocation {
  argv: string[]
  env: Record<string, string | undefined>
}

/**
 * One ekko slice, ready to spawn: writes `samples[slice]` as a 16-bit PCM mono WAV at
 * `slicePath`, and returns `ekkoSliceArgv` on it with `EKKO_ENV` over `process.env`. The
 * adapter, the warm-up, the benchmark's memory run and the long-audio check all start
 * `parakeet-cli` through this, so none of them can drift from what the benchmark measured.
 * Throws when the WAV cannot be written.
 */
export function ekkoSliceInvocation(args: {
  binary: string
  modelPath: string
  slicePath: string
  samples: Float32Array
  sampleRate: number
  /** Absent: all of `samples`. */
  slice?: AudioSlice
}): EkkoSliceInvocation {
  writeFileSync(
    args.slicePath,
    pcm16MonoWav(args.samples, args.sampleRate, args.slice)
  )
  return {
    argv: ekkoSliceArgv(args.binary, args.modelPath, args.slicePath),
    env: { ...process.env, ...EKKO_ENV },
  }
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

/**
 * What ekko's slicing adds to the planner's defaults: room noise 35 dB or more under the
 * speech is a pause (`pauseBelowSpeechDb`), so a long noisy pause between sentences ends a
 * slice. ekko-v1-tiny drops the first words of a sentence that follows a long pause inside
 * one slice (#108: "du skal se skiruten" in the long-audio check, after about 7 s of room
 * noise that the recording-wide noise floor read as speech). Only ekko: Edda's and the other
 * crispasr `nt-vad` slices stay on the defaults.
 */
export const EKKO_VAD_SLICE_OPTIONS: Readonly<Partial<VadSliceOptions>> = {
  pauseBelowSpeechDb: 35,
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
 * Reads a WAV and plans its slices exactly as the adapter does: the planner's defaults with
 * `EKKO_VAD_SLICE_OPTIONS`, then `sliceOptions` on top. Exported for the benchmark's memory
 * run and the long-audio check, which run `ekkoSliceArgv` on one of these slices.
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
    slices: planVadSlices(audio.samples, audio.sampleRate, {
      ...EKKO_VAD_SLICE_OPTIONS,
      ...sliceOptions,
    }),
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
 * is ignored. Rejects on any failure; `ekko-warmup.ts` logs it. Aborting `signal` kills the
 * run (app quit) and rejects with the signal's `AbortError`.
 */
export async function warmUpEkko(
  modelPath: string,
  options: { signal?: AbortSignal; deps?: EkkoDeps } = {}
): Promise<void> {
  const { signal, deps = realEkkoDeps } = options
  signal?.throwIfAborted()
  if (!existsSync(modelPath)) {
    throw new Error(`ekko GGUF not on disk: ${modelPath}`)
  }
  const binary = await deps.resolveBinary()
  signal?.throwIfAborted()
  const runDir = mkdtempSync(join(tmpdir(), 'codictate-ekko-warmup-'))
  try {
    const { argv, env } = ekkoSliceInvocation({
      binary,
      modelPath,
      slicePath: join(runDir, 'silence.wav'),
      samples: new Float32Array(WARMUP_SAMPLES),
      sampleRate: WARMUP_SAMPLE_RATE,
    })
    log('ekko', 'warming up parakeet-cli', { binary, model: modelPath })
    const proc = deps.spawn(argv, { env, signal })
    const supervised = await superviseProcess(proc, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      timeoutMs: EKKO_WARMUP_TIMEOUT_MS,
      clock: deps.clock,
    })
    signal?.throwIfAborted()
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
    const result = await transcribeSlices(slicing, {
      runDir,
      binary,
      request,
      deps,
      deadline,
    })
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

/** What every slice of one Request shares. */
interface EkkoRun {
  /** The per-run temp directory the slice WAVs go in. */
  runDir: string
  binary: string
  request: EkkoTranscriptionRequest
  deps: EkkoDeps
  /** The Request's one deadline, on `deps.now()`. */
  deadline: number
}

async function transcribeSlices(
  slicing: Extract<EkkoSlicing, { ok: true }>,
  run: EkkoRun
): Promise<TranscriptionResult> {
  const { request, deps, deadline, binary } = run
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
    const sliceRun = await runSlice(run, {
      where,
      index,
      slice,
      samples,
      sampleRate,
    })
    if (!sliceRun.ok) return sliceRun.failure
    texts.push(sliceRun.text)
    const piece = ekkoTimedPiece(sliceRun, {
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

/** One slice of the recording, and how to name it in a failure. */
interface EkkoSliceInput {
  /** "slice 2 of 3". */
  where: string
  index: number
  slice: AudioSlice
  samples: Float32Array
  sampleRate: number
}

/** One slice: written, spawned, supervised to what is left of the deadline, and read. */
async function runSlice(
  run: EkkoRun,
  { where, index, slice, samples, sampleRate }: EkkoSliceInput
): Promise<SliceRun> {
  const { runDir, binary, request, deps, deadline } = run
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

  let invocation: EkkoSliceInvocation
  try {
    invocation = ekkoSliceInvocation({
      binary,
      modelPath: request.modelPath,
      slicePath: join(runDir, `slice-${index}.wav`),
      samples,
      sampleRate,
      slice,
    })
  } catch (err) {
    return fail(
      'engine_output_unreadable',
      `slice WAV not written: ${String(err)}`
    )
  }

  let proc: EkkoProcess
  try {
    proc = deps.spawn(invocation.argv, {
      env: invocation.env,
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

  let supervised: Awaited<ReturnType<typeof superviseProcess>>
  try {
    supervised = await superviseProcess(proc, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      timeoutMs: Math.max(1, Math.round(deadline - deps.now())),
      clock: deps.clock,
    })
  } catch (err) {
    // The process's exit could not be read. Kill it in case it still runs, and fail the run
    // with a reason rather than rejecting out of the adapter.
    try {
      proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    log('ekko', 'parakeet-cli could not be supervised', {
      slice: where,
      err: String(err),
    })
    return fail(
      'engine_exited_nonzero',
      `parakeet-cli exit unreadable: ${String(err)}`
    )
  }
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
