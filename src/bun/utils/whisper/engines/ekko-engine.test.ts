import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EKKO_ENGINE_ID } from '../../../../shared/speech-models'
import {
  EKKO_ENV,
  ekkoSliceArgv,
  ekkoSlices,
  transcribeWithEkkoTuned,
  warmUpEkko,
  type EkkoDeps,
  type EkkoProcess,
} from './ekko-engine'
import { readWavSamples } from './vad-slices'
import type { EkkoTranscriptionRequest } from './transcription'

const SR = 16_000
const BINARY = '/vendors/parakeet-cli/parakeet-cli'
const MODEL_ID = 'ekko-v1-tiny-q5_0'

const dir = mkdtempSync(join(tmpdir(), 'codictate-ekko-engine-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const GGUF = join(dir, 'ekko-v1-tiny-q5_0.gguf')
writeFileSync(GGUF, 'not really a GGUF')

/** Deterministic uniform noise in [-1, 1). */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
}

type Part =
  /** Stands in for speech: noise around -15 dBFS. */
  | ['speech', number]
  /** A quiet room: noise around -55 dBFS. */
  | ['room', number]
  /** A very quiet room: noise around -71 dBFS. */
  | ['hush', number]
  | ['zeros', number]

/** A 16 kHz mono 16-bit PCM WAV from parts given in seconds, written into the temp dir. */
let wavCount = 0
function wavFile(...parts: Part[]): string {
  const random = noise(7)
  const samples: number[] = []
  for (const [kind, seconds] of parts) {
    const count = Math.round(seconds * SR)
    for (let i = 0; i < count; i += 1) {
      if (kind === 'speech') samples.push(0.3 * random())
      else if (kind === 'room') samples.push(0.003 * random())
      else if (kind === 'hush') samples.push(0.0005 * random())
      else samples.push(0)
    }
  }
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SR, true)
  view.setUint32(28, SR * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) =>
    view.setInt16(44 + i * 2, Math.round(s * 32767), true)
  )
  const path = join(dir, `recording-${wavCount++}.wav`)
  writeFileSync(path, bytes)
  return path
}

/** Speech at 1-3 s and 6-8 s: two slices, starting at 0.8 s and 5.8 s (0.2 s padding). */
function twoUtterances(): string {
  return wavFile(
    ['room', 1],
    ['speech', 2],
    ['room', 3],
    ['speech', 2],
    ['room', 1]
  )
}

/** Speech at 1-3 s, 6-8 s and 11-12 s: three slices, at 0.8 s, 5.8 s and 10.8 s. */
function threeUtterances(): string {
  return wavFile(
    ['room', 1],
    ['speech', 2],
    ['room', 3],
    ['speech', 2],
    ['room', 3],
    ['speech', 1],
    ['room', 1]
  )
}

function request(
  audioPath: string,
  overrides: Partial<EkkoTranscriptionRequest> = {}
): EkkoTranscriptionRequest {
  return {
    engineId: EKKO_ENGINE_ID,
    speechModelId: MODEL_ID,
    audioPath,
    timeoutMs: 60_000,
    modelPath: GGUF,
    ...overrides,
  }
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** What one fake `parakeet-cli` run prints and how it exits. */
interface CannedRun {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** Runs when the process is spawned, before it exits. */
  onSpawn?: () => void
}

function exitedProcess(run: CannedRun): EkkoProcess {
  run.onSpawn?.()
  return {
    pid: 4242,
    stdout: stream(run.stdout ?? ''),
    stderr: stream(run.stderr ?? ''),
    exited: Promise.resolve(run.exitCode ?? 0),
    kill: () => {},
  }
}

/** `parakeet-cli transcribe --json` stdout for a slice. */
function cliJson(
  text: string,
  words: { w: string; start: number; end: number }[]
): string {
  return JSON.stringify({
    text,
    frame_sec: 0.08,
    words: words.map((word) => ({ ...word, conf: 0.9 })),
    tokens: [{ id: 2, t: 0, conf: 0.98 }],
  })
}

/**
 * Deps whose spawn answers each slice in order from `runs`. A spawn past the end throws, the
 * way `Bun.spawn` does for a binary it cannot start, so an unexpected one shows in the Result.
 */
function fakeDeps(
  runs: CannedRun[],
  overrides: Partial<EkkoDeps> = {}
): EkkoDeps {
  const queue = [...runs]
  return {
    resolveBinary: async () => BINARY,
    spawn: () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('spawn not expected')
      return exitedProcess(next)
    },
    now: () => performance.now(),
    lowerPriority: () => {},
    ...overrides,
  }
}

describe('the ekko adapter', () => {
  test('a silent recording is an empty success, and nothing is spawned', async () => {
    const result = await transcribeWithEkkoTuned(
      request(wavFile(['room', 3])),
      {},
      fakeDeps([])
    )
    expect(result).toEqual({
      status: 'ok',
      rawTranscript: '',
      timedTranscript: null,
    })
  })

  test('joins the slices, and times each word from the start of the recording', async () => {
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances()),
      {},
      fakeDeps([
        {
          stdout: cliJson('hej jeg', [
            { w: 'hej', start: 0.0, end: 0.16 },
            { w: 'jeg', start: 0.32, end: 0.56 },
          ]),
        },
        {
          stdout: cliJson('vi mødes', [
            { w: 'vi', start: 0.24, end: 0.48 },
            { w: 'mødes', start: 0.56, end: 0.96 },
          ]),
        },
      ])
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rawTranscript).toBe('hej jeg vi mødes')
    expect(rounded(result.timedTranscript)).toEqual({
      text: 'hej jeg vi mødes',
      parts: [
        {
          text: 'hej jeg',
          start: 0.8,
          end: 1.36,
          words: [
            { text: 'hej', start: 0.8, end: 0.96 },
            { text: 'jeg', start: 1.12, end: 1.36 },
          ],
        },
        {
          text: 'vi mødes',
          start: 6.04,
          end: 6.76,
          words: [
            { text: 'vi', start: 6.04, end: 6.28 },
            { text: 'mødes', start: 6.36, end: 6.76 },
          ],
        },
      ],
    })
  })

  test('a word lasts at most 0.8 s: a 3 s word starts 0.8 s before its end, a 0.3 s word keeps its start', async () => {
    // One slice, starting at 0.8 s.
    const audioPath = wavFile(['room', 1], ['speech', 4], ['room', 1])
    const result = await transcribeWithEkkoTuned(
      request(audioPath),
      {},
      fakeDeps([
        {
          stdout: cliJson('efter pausen', [
            { w: 'efter', start: 0.2, end: 3.2 },
            { w: 'pausen', start: 3.3, end: 3.6 },
          ]),
        },
      ])
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(rounded(result.timedTranscript?.parts)).toEqual([
      {
        text: 'efter pausen',
        start: 3.2,
        end: 4.4,
        words: [
          { text: 'efter', start: 3.2, end: 4.0 },
          { text: 'pausen', start: 4.1, end: 4.4 },
        ],
      },
    ])
  })

  test('a slice that heard nothing leaves no part in the Timed Transcript', async () => {
    const result = await transcribeWithEkkoTuned(
      request(threeUtterances()),
      {},
      fakeDeps([
        { stdout: cliJson('hej', [{ w: 'hej', start: 0.24, end: 0.48 }]) },
        // What parakeet-cli prints for a quiet slice: no text and one empty word.
        { stdout: cliJson('', [{ w: '', start: 0, end: 0.08 }]) },
        {
          stdout: cliJson('farvel', [{ w: 'farvel', start: 0.24, end: 0.64 }]),
        },
      ])
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rawTranscript).toBe('hej farvel')
    expect(rounded(result.timedTranscript)).toEqual({
      text: 'hej farvel',
      parts: [
        {
          text: 'hej',
          start: 1.04,
          end: 1.28,
          words: [{ text: 'hej', start: 1.04, end: 1.28 }],
        },
        {
          text: 'farvel',
          start: 11.04,
          end: 11.44,
          words: [{ text: 'farvel', start: 11.04, end: 11.44 }],
        },
      ],
    })
  })

  test('<unk> inside a word and an empty word are cleaned out of the words', async () => {
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances()),
      {},
      fakeDeps([
        {
          stdout: cliJson('nye tvskærme', [
            { w: 'nye', start: 0.0, end: 0.24 },
            { w: '', start: 0.24, end: 0.32 },
            { w: 'tv<unk>skærme', start: 0.32, end: 0.96 },
          ]),
        },
        { stdout: cliJson('', [{ w: '', start: 0, end: 0.08 }]) },
      ])
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rawTranscript).toBe('nye tvskærme')
    expect(rounded(result.timedTranscript)).toEqual({
      text: 'nye tvskærme',
      parts: [
        {
          text: 'nye tvskærme',
          start: 0.8,
          end: 1.76,
          words: [
            { text: 'nye', start: 0.8, end: 1.04 },
            { text: 'tvskærme', start: 1.12, end: 1.76 },
          ],
        },
      ],
    })
  })

  test('stdout that is not JSON, or JSON with no string text, is unreadable output', async () => {
    for (const stdout of [
      'ggml_metal_init: loaded',
      JSON.stringify({ words: [] }),
      JSON.stringify({ text: 42 }),
    ]) {
      const result = await transcribeWithEkkoTuned(
        request(twoUtterances()),
        {},
        fakeDeps([{ stdout }, { stdout: cliJson('', []) }])
      )
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'engine_output_unreadable',
      })
    }
  })

  test('a failure on the second slice fails the run, with that slice and its stderr named, and nothing partial', async () => {
    const result = await transcribeWithEkkoTuned(
      request(threeUtterances()),
      {},
      fakeDeps([
        { stdout: cliJson('hej', [{ w: 'hej', start: 0, end: 0.24 }]) },
        {
          exitCode: 3,
          stderr: 'ggml_metal_init: ok\nerror: failed to load model',
        },
        { stdout: cliJson('farvel', [{ w: 'farvel', start: 0, end: 0.4 }]) },
      ])
    )
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.reason).toBe('engine_exited_nonzero')
    expect(result.diagnostic).toContain('slice 2 of 3')
    expect(result.diagnostic).toContain('failed to load model')
    expect(result).not.toHaveProperty('rawTranscript')
  })

  test('cancelling between slices returns cancelled and runs no further slice', async () => {
    const abort = new AbortController()
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances(), { signal: abort.signal }),
      {},
      fakeDeps([
        {
          stdout: cliJson('hej', [{ w: 'hej', start: 0, end: 0.24 }]),
          onSpawn: () => abort.abort(),
        },
      ])
    )
    expect(result).toMatchObject({ status: 'failed', reason: 'cancelled' })
  })

  test('the deadline is one for the whole Request, not one per slice', async () => {
    let now = 0
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances(), { timeoutMs: 1_000 }),
      {},
      fakeDeps(
        [
          {
            stdout: cliJson('hej', [{ w: 'hej', start: 0, end: 0.24 }]),
            // The first slice alone takes longer than the whole Request may.
            onSpawn: () => {
              now += 1_500
            },
          },
        ],
        { now: () => now }
      )
    )
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'engine_timed_out',
    })
  })

  test('a slice still running at the deadline times the run out, naming the slice', async () => {
    let exit: (code: number) => void = () => {}
    const hung: EkkoProcess = {
      pid: 4242,
      stdout: new ReadableStream(),
      stderr: stream('ggml_metal_init: compiling pipelines'),
      exited: new Promise<number>((resolve) => {
        exit = resolve
      }),
      kill: () => exit(143),
    }
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances(), { timeoutMs: 30 }),
      {},
      fakeDeps([], { spawn: () => hung })
    )
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.reason).toBe('engine_timed_out')
    expect(result.diagnostic).toContain('slice 1 of 2')
  })

  test('a missing GGUF is engine_runtime_missing, and nothing is spawned', async () => {
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances(), { modelPath: join(dir, 'gone.gguf') }),
      {},
      // Spawned anyway, these would transcribe.
      fakeDeps([{ stdout: cliJson('hej', []) }, { stdout: cliJson('hej', []) }])
    )
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'engine_runtime_missing',
    })
  })

  test('a missing parakeet-cli is engine_runtime_missing with the remediation, and nothing is spawned', async () => {
    const remediation =
      'parakeet-cli not found. Run `bun run scripts/pre-build.ts --parakeet-cli-only`, then rebuild the app.'
    const result = await transcribeWithEkkoTuned(
      request(twoUtterances()),
      {},
      fakeDeps([], {
        resolveBinary: async () => {
          throw new Error(remediation)
        },
      })
    )
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'engine_runtime_missing',
      diagnostic: remediation,
    })
  })

  test('a recording that is not a WAV is unreadable, and nothing is spawned', async () => {
    const path = join(dir, 'not-a-wav.wav')
    writeFileSync(path, 'ID3 this is an mp3')
    const result = await transcribeWithEkkoTuned(
      request(path),
      {},
      fakeDeps([])
    )
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'engine_output_unreadable',
    })
  })

  test('each slice reaches parakeet-cli as a 16 kHz mono WAV, with the pinned argv and env', async () => {
    const seen: string[] = []
    const deps = fakeDeps([], {
      spawn: (argv, { env }) => {
        const input = argv[argv.indexOf('--input') + 1]
        const wav = readWavSamples(new Uint8Array(readFileSync(input)))
        const argvOk =
          JSON.stringify(argv) ===
          JSON.stringify(ekkoSliceArgv(BINARY, GGUF, input))
        seen.push(
          `${argvOk} ${env.PARAKEET_ATT_CONTEXT} ${wav.sampleRate} ${(wav.samples.length / wav.sampleRate).toFixed(2)}`
        )
        return exitedProcess({ stdout: cliJson('', []) })
      },
    })
    await transcribeWithEkkoTuned(request(twoUtterances()), {}, deps)
    // Each slice is 2 s of speech with 0.2 s either side.
    expect(seen.length).toBeGreaterThan(0)
    for (const run of seen) expect(run).toBe('true 128 16000 2.40')
  })
})

describe("the ekko adapter's slices", () => {
  /**
   * The noise floor is the hushed room, and the 4 s between the sentences is a louder room,
   * well above that floor but 40 dB under the speech: the long pause #108 lost words after.
   */
  function noisyPause(): string {
    return wavFile(
      ['hush', 1],
      ['speech', 3],
      ['room', 4],
      ['speech', 3],
      ['hush', 1]
    )
  }
  const at = (seconds: number) => Math.round(seconds * SR)

  test('a long pause of room noise above the noise floor ends a slice', () => {
    const slicing = ekkoSlices(noisyPause())
    expect(slicing.ok && slicing.slices).toEqual([
      { startSample: at(0.8), endSample: at(4.2) },
      { startSample: at(7.8), endSample: at(11.2) },
    ])
  })

  test('slice options from the long-audio check keep that rule', () => {
    const slicing = ekkoSlices(noisyPause(), { maxSliceSeconds: 20 })
    expect(slicing.ok && slicing.slices).toEqual([
      { startSample: at(0.8), endSample: at(4.2) },
      { startSample: at(7.8), endSample: at(11.2) },
    ])
  })
})

describe('the ekko slice command', () => {
  test('is parakeet-cli transcribe with the GGUF, the slice and JSON output, and nothing else', () => {
    expect(
      ekkoSliceArgv('/bin/parakeet-cli', '/models/ekko.gguf', '/tmp/s.wav')
    ).toEqual([
      '/bin/parakeet-cli',
      'transcribe',
      '--model',
      '/models/ekko.gguf',
      '--input',
      '/tmp/s.wav',
      '--json',
    ])
  })

  test('runs with the attention context the gate measured', () => {
    expect(EKKO_ENV).toEqual({ PARAKEET_ATT_CONTEXT: '128' })
  })
})

describe('the ekko warm-up run', () => {
  /** Deps that record the one spawn and read its WAV before the fake process exits. */
  function warmupDeps(run: CannedRun = {}) {
    const seen: {
      argv: string[]
      env: Record<string, string | undefined>
      wav: { samples: Float32Array; sampleRate: number }
      slicePath: string
    }[] = []
    const delays: number[] = []
    const deps = fakeDeps([], {
      spawn: (argv, { env }) => {
        const slicePath = argv[argv.indexOf('--input') + 1]
        seen.push({
          argv,
          env,
          slicePath,
          wav: readWavSamples(new Uint8Array(readFileSync(slicePath))),
        })
        return exitedProcess(run)
      },
      clock: {
        setTimeout: (callback, delayMs) => {
          delays.push(delayMs)
          return setTimeout(callback, delayMs)
        },
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    })
    return { deps, seen, delays }
  }

  test('runs the slice command with EKKO_ENV on half a second of 16 kHz silence, under 60 s', async () => {
    const { deps, seen, delays } = warmupDeps({
      stdout: cliJson('', [{ w: '', start: 0, end: 0.08 }]),
    })
    await warmUpEkko(GGUF, deps)

    expect(seen).toHaveLength(1)
    const [run] = seen
    expect(run.argv).toEqual(ekkoSliceArgv(BINARY, GGUF, run.slicePath))
    expect(run.env.PARAKEET_ATT_CONTEXT).toBe('128')
    expect(run.wav.sampleRate).toBe(16_000)
    expect(run.wav.samples.length).toBe(8_000)
    expect(run.wav.samples.every((s) => s === 0)).toBe(true)
    expect(delays).toContain(60_000)
  })

  test('removes its temp directory', async () => {
    const { deps, seen } = warmupDeps()
    await warmUpEkko(GGUF, deps)
    expect(existsSync(dirname(seen[0].slicePath))).toBe(false)
  })

  test('a non-zero exit rejects with the exit code and stderr, and still cleans up', async () => {
    const { deps, seen } = warmupDeps({
      exitCode: 3,
      stderr: 'no Metal device',
    })
    await expect(warmUpEkko(GGUF, deps)).rejects.toThrow(
      /exit 3.*no Metal device/
    )
    expect(existsSync(dirname(seen[0].slicePath))).toBe(false)
  })

  test('a missing parakeet-cli rejects without spawning', async () => {
    const { deps, seen } = warmupDeps()
    deps.resolveBinary = async () => {
      throw new Error('parakeet-cli not installed')
    }
    await expect(warmUpEkko(GGUF, deps)).rejects.toThrow(
      'parakeet-cli not installed'
    )
    expect(seen).toHaveLength(0)
  })

  test('a missing GGUF rejects without spawning', async () => {
    const { deps, seen } = warmupDeps()
    await expect(warmUpEkko(join(dir, 'gone.gguf'), deps)).rejects.toThrow(
      /GGUF not on disk/
    )
    expect(seen).toHaveLength(0)
  })
})

/** Times to the millisecond, so a sum like 0.8 + 0.16 compares as the 0.96 it is. */
function rounded<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'number' ? Math.round(v * 1000) / 1000 : v
    )
  ) as T
}
