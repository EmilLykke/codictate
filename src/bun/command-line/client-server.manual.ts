/**
 * The real `codictate` client against the real app side, end to end, for every command.
 * Opt-in (`.manual.ts`, so `bun test` never discovers it): it spawns the Rust client and
 * sends it signals.
 *
 *   bun run build:native:cli
 *   bun test ./src/bun/command-line/client-server.manual.ts
 *
 * The app side is `startCommandLineServer` + `createCommandHandlers` + the real session, on
 * the socket `commandLineEndpoint` computes for a temp data dir, with the real File
 * Transcription queue and the real model operations over fake engines, decoders, weights and
 * a fake recording module. The client is the release build, copied into a fake app bundle.
 * Every assertion is against docs/CLI.md.
 *
 * Nothing real can start: `CODICTATE_APP_BUNDLE` is a relative path that begins with `--`, so
 * the client's `open -g <bundle>` fails in `open`'s own argument parsing, before LaunchServices
 * is asked anything. The client is only ever run without that override for `--version`, which
 * launches nothing.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import {
  CONTRACT_VERSION,
  encodeLine,
  parseRequestLine,
} from '../../shared/command-line-protocol'
import {
  blockedDictationPlan,
  type RunnableDictationPlan,
} from '../../shared/dictation-plan'
import {
  DEFAULT_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
} from '../../shared/speech-models'
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../shared/transcription-languages'
import { cliBinarySource } from '../../../scripts/build-native-cli'
import type {
  CommandLineDictationControl,
  CommandLineDictationOptions,
  CommandLineDictationResult,
  CommandLineDictationStart,
} from '../dictation/command-line-dictation'
import type { DecodeAudioResult } from '../file-transcription/extract-audio'
import { createFileTranscriptionQueue } from '../file-transcription/queue'
import type { FileTranscriptionQueue } from '../file-transcription/types'
import {
  createModelOperations,
  type SpeechModelStore,
} from '../model-operations'
import {
  failedTranscription,
  type TranscriptionResult,
} from '../utils/whisper/engines/transcription'
import {
  commandLineEndpoint,
  hiddenLaunchMarkerPath,
  isFreshHiddenLaunchMarker,
} from './endpoint'
import { createCommandHandlers, type CommandLineDeps } from './handlers'
import { NdjsonLineSplitter } from './line-splitter'
import type { CommandHandlers } from './session'
import { startCommandLineServer, type CommandLineServer } from './transport'

const REPO = join(import.meta.dir, '..', '..', '..')
const BUILT_CLIENT = join(REPO, cliBinarySource(process.platform))

const IDENTITY = {
  version: '0.0.62',
  channel: 'dev',
  identifier: 'app.codictate.cli-e2e',
}
/** Relative to the clients' cwd. `open -g --codictate-e2e-inert` is an `open` usage error. */
const INERT_BUNDLE = '--codictate-e2e-inert'

const HVISKE_ID = 'hviske-v5-tiny-q5_0'
const SMALL_ID = 'small-q5_1'
const NOT_INSTALLED_ID = 'large-v3-q5_0'
const DOWNLOADABLE_ID = 'medium.en-q5_0'

// ── The fake machine behind the real app side ─────────────────────────────

/** An "audio file" here is JSON telling the fake decoder and engine what to do. */
interface AudioSpec {
  text?: string
  decode?: 'ok' | 'input_unreadable' | 'no_audio'
  engineFails?: boolean
  /** Decoding waits until `releaseHolds()`. */
  hold?: boolean
  transcribeMs?: number
  seconds?: number
}

const state = {
  commandLineControl: false,
  speechModelId: DEFAULT_MODEL_ID,
  transcriptionLanguageId: 'auto',
  installed: new Set<string>(),
  notifications: [] as { title: string; body: string }[],
  downloadError: null as string | null,
  downloadStepMs: 300,
  cancelledDownloads: [] as string[],
  decodeStarted: [] as string[],
  transcribeAborted: 0,
}

let holds: (() => void)[] = []
function releaseHolds() {
  const waiting = holds
  holds = []
  for (const release of waiting) release()
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

function readSpec(path: string): AudioSpec {
  return JSON.parse(readFileSync(path, 'utf8')) as AudioSpec
}

function engineIdOf(speechModelId: string) {
  return getSpeechModel(speechModelId)!.engine
}

/** A recording module that records nothing and honours stop, cancel and `--max`. */
class FakeDictation implements CommandLineDictationControl {
  starts: CommandLineDictationOptions[] = []
  text = 'Hello from the microphone.'
  /** How long "transcribing" takes after a stop. */
  stopDelayMs = 50
  stops = 0
  cancels = 0
  private current: { stop(): void; cancel(): void } | null = null
  private startedWaiters: (() => void)[] = []

  reset() {
    this.starts = []
    this.stopDelayMs = 50
    this.stops = 0
    this.cancels = 0
    this.current?.cancel()
    this.current = null
  }

  whenStarted(): Promise<void> {
    if (this.current) return Promise.resolve()
    return new Promise((resolve) => this.startedWaiters.push(resolve))
  }

  async startCommandLineDictation(
    options: CommandLineDictationOptions
  ): Promise<CommandLineDictationStart> {
    if (this.current) return { status: 'busy' }
    const speechModelId = options.speechModelId ?? state.speechModelId
    // As the real resolver: weights that are not there block the plan.
    if (!state.installed.has(speechModelId)) {
      return {
        status: 'blocked',
        plan: blockedDictationPlan(
          'batch',
          'speech_model_not_installed',
          speechModelId
        ),
        fromOverrides: options.speechModelId !== null,
      }
    }
    this.starts.push(options)
    const plan: RunnableDictationPlan = {
      status: 'runnable',
      mode: 'batch',
      speechModelId,
      engineId: engineIdOf(speechModelId),
      crispasrBackend: null,
      transcriptionLanguageId:
        options.transcriptionLanguageId ?? state.transcriptionLanguageId,
      languageCode: null,
      translateToEnglish: false,
    }
    let settle!: (result: CommandLineDictationResult) => void
    const result = new Promise<CommandLineDictationResult>((resolve) => {
      settle = resolve
    })
    let ended = false
    let stopping = false
    let maxTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: CommandLineDictationResult) => {
      if (ended) return
      ended = true
      clearTimeout(maxTimer)
      if (this.current === handle) this.current = null
      settle(value)
    }
    const handle = {
      stop: () => {
        if (ended || stopping) return
        stopping = true
        this.stops += 1
        options.onEvent({ type: 'transcribing' })
        setTimeout(
          () =>
            finish({
              status: 'ok',
              text: this.text,
              rawText: this.text,
              formattingModeId: null,
              pasted: options.output === 'cursor',
              live: false,
              plan,
              audioSeconds: 1.5,
            }),
          this.stopDelayMs
        )
      },
      cancel: () => {
        this.cancels += 1
        finish({ status: 'cancelled' })
      },
    }
    if (options.maxSeconds !== null) {
      maxTimer = setTimeout(handle.stop, options.maxSeconds * 1000)
    }
    this.current = handle
    options.onEvent({ type: 'recording' })
    for (const resolve of this.startedWaiters.splice(0)) resolve()
    return { status: 'started', ...handle, result }
  }

  stopAnyDictation(): boolean {
    if (!this.current) return false
    this.current.stop()
    return true
  }

  getActiveDictation() {
    return this.current
      ? { active: true, startedBy: 'command-line' as const }
      : { active: false, startedBy: null }
  }
}

const dictation = new FakeDictation()

/** Weights that land in a few progress steps, unless `downloadError` says otherwise. */
const store: SpeechModelStore = (() => {
  const running = new Map<string, () => void>()
  return {
    downloadModel(id, onProgress) {
      return new Promise<void>((resolve) => {
        const fractions = [0.1, 0.35, 0.6, 0.85]
        let step = 0
        const timer = setInterval(() => {
          if (step < fractions.length) {
            onProgress(fractions[step++], false)
            return
          }
          clearInterval(timer)
          running.delete(id)
          if (state.downloadError !== null) {
            onProgress(1, true, state.downloadError)
          } else {
            state.installed.add(id)
            onProgress(1, true)
          }
          resolve()
        }, state.downloadStepMs)
        running.set(id, () => {
          clearInterval(timer)
          running.delete(id)
          onProgress(0, true, 'cancelled')
          resolve()
        })
      })
    },
    cancelDownload(id) {
      state.cancelledDownloads.push(id)
      running.get(id)?.()
    },
    deleteModel(id) {
      return state.installed.delete(id)
    },
  }
})()

// ── The fake app tree and the server ──────────────────────────────────────

let root = ''
let work = ''
let dataDir = ''
let appClient = ''
let server: CommandLineServer | null = null
let handlers: CommandHandlers
let queue: FileTranscriptionQueue

function writeVersionJson(bundle: string) {
  const resources = join(bundle, 'Contents', 'Resources')
  mkdirSync(join(resources, 'app', 'bin'), { recursive: true })
  writeFileSync(
    join(resources, 'version.json'),
    JSON.stringify({ ...IDENTITY, hash: 'e2e', baseUrl: '', name: 'Codictate' })
  )
  return resources
}

function audio(name: string, spec: AudioSpec): string {
  const path = join(work, name)
  writeFileSync(path, JSON.stringify(spec))
  return path
}

function endpointFor(appDataDir: string) {
  return commandLineEndpoint({
    platform: process.platform,
    appDataDir,
    identifier: IDENTITY.identifier,
    username: userInfo().username,
    uid: process.getuid!(),
  })
}

/** Serve `handlers` on `appDataDir`'s endpoint, as the app does at boot. */
async function serve(appDataDir: string): Promise<CommandLineServer> {
  const start = await startCommandLineServer(endpointFor(appDataDir), handlers)
  if (start.status !== 'serving') {
    throw new Error(`the server did not start: ${start.status}`)
  }
  return start.server
}

beforeAll(async () => {
  if (!existsSync(BUILT_CLIENT)) {
    throw new Error(
      `${BUILT_CLIENT} is missing. Run bun run build:native:cli first.`
    )
  }
  // Under /tmp, not $TMPDIR: a Unix socket path must stay under 104 bytes on macOS.
  root = realpathSync(mkdtempSync('/tmp/cdx-e2e-'))
  work = join(root, 'work')
  dataDir = join(root, 'data')
  mkdirSync(join(root, 'jobs'), { recursive: true })
  mkdirSync(work, { recursive: true })

  // The fake app, with the client where docs/CLI.md says it lives.
  const resources = writeVersionJson(join(root, 'Codictate E2E.app'))
  appClient = join(resources, 'app', 'bin', 'codictate')
  copyFileSync(BUILT_CLIENT, appClient)
  // The inert bundle the clients are pointed at; only its version.json is ever read.
  writeVersionJson(join(work, INERT_BUNDLE))

  let jobCounter = 0
  queue = createFileTranscriptionQueue({
    settings: {
      getSpeechModelId: () => state.speechModelId,
      getTranscriptionLanguageId: () => state.transcriptionLanguageId,
    },
    isModelAvailable: (id) => state.installed.has(id),
    locations: {
      getModelPath: (id) => `/nonexistent/${id}.bin`,
      getParakeetInstallDir: (id) => `/nonexistent/${id}`,
    },
    inspectInput: (path) => {
      try {
        return statSync(path).isFile() ? 'file' : 'not_a_file'
      } catch {
        return 'missing'
      }
    },
    createWorkDir: () => mkdtempSync(join(root, 'jobs', 'job-')),
    removeWorkDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    decode: async (input, output, { signal }): Promise<DecodeAudioResult> => {
      state.decodeStarted.push(input)
      const spec = readSpec(input)
      if (spec.hold) {
        await new Promise<void>((resolve) => {
          holds.push(resolve)
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (signal.aborted) {
        return { status: 'failed', code: 'cancelled', message: 'cancelled' }
      }
      if (spec.decode === 'input_unreadable') {
        return {
          status: 'failed',
          code: 'input_unreadable',
          message: 'not a readable audio or video file',
        }
      }
      if (spec.decode === 'no_audio') {
        return { status: 'failed', code: 'no_audio', message: 'no audio track' }
      }
      writeFileSync(output, JSON.stringify(spec))
      return { status: 'ok' }
    },
    wavDurationSeconds: (path) => readSpec(path).seconds ?? 2.5,
    transcribe: async (request): Promise<TranscriptionResult> => {
      const spec = readSpec(request.audioPath)
      await sleepOrAbort(spec.transcribeMs ?? 0, request.signal)
      if (request.signal?.aborted) {
        state.transcribeAborted += 1
        return failedTranscription('cancelled', request.speechModelId)
      }
      if (spec.engineFails) {
        return failedTranscription(
          'engine_exited_nonzero',
          request.speechModelId,
          'segfault'
        )
      }
      return { status: 'ok', rawTranscript: spec.text ?? '' }
    },
    clock: {
      now: () => Date.now(),
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    },
    newJobId: () => `job-${++jobCounter}`,
    log: () => {},
  })

  const deps: CommandLineDeps = {
    app: IDENTITY,
    isOnboardingCompleted: () => true,
    getMicrophone: () => 'granted',
    getCommandLineControl: () => state.commandLineControl,
    isMicrophoneGranted: () => true,
    dictation,
    notify: (notification) => state.notifications.push(notification),
    getSpeechModelId: () => state.speechModelId,
    getTranscriptionLanguageId: () => state.transcriptionLanguageId,
    isModelAvailable: (id) => state.installed.has(id),
    fileTranscriptions: queue,
    showMainWindow: () => {},
    getStreamMode: () => false,
    updateTranscriptionSettings: async (patch) => {
      if (patch.speechModelId !== undefined) {
        state.speechModelId = patch.speechModelId
      }
      if (patch.transcriptionLanguageId !== undefined) {
        state.transcriptionLanguageId = patch.transcriptionLanguageId
      }
      return true
    },
    models: createModelOperations({
      store,
      pushProgress: () => {},
      pushAvailability: () => {},
      onAvailabilityChanged: async () => {},
      log: () => {},
    }),
  }

  handlers = createCommandHandlers(deps)
  server = await serve(dataDir)
})

afterAll(() => {
  server?.close()
  releaseHolds()
  if (root) rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  state.commandLineControl = false
  state.speechModelId = DEFAULT_MODEL_ID
  state.transcriptionLanguageId = 'auto'
  state.installed = new Set([
    ...SPEECH_MODELS.filter((m) => m.bundled).map((m) => m.id),
    SMALL_ID,
    HVISKE_ID,
  ])
  state.notifications = []
  state.downloadError = null
  state.cancelledDownloads = []
  state.decodeStarted = []
  state.transcribeAborted = 0
  dictation.reset()
  releaseHolds()
})

// ── Running the client ────────────────────────────────────────────────────

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

interface RunOptions {
  binary?: string
  cwd?: string
  /** Replaces the default environment entirely. */
  env?: Record<string, string>
  dataDir?: string
}

function clientEnv(options: RunOptions = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? root,
    CODICTATE_APP_BUNDLE: INERT_BUNDLE,
    CODICTATE_DATA_DIR: options.dataDir ?? dataDir,
  }
}

function spawnClient(args: string[], options: RunOptions = {}) {
  const proc = Bun.spawn([options.binary ?? appClient, ...args], {
    cwd: options.cwd ?? work,
    env: options.env ?? clientEnv(options),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const done: Promise<Ran> = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  })()
  return { proc, done }
}

const codictate = (args: string[], options?: RunOptions) =>
  spawnClient(args, options).done

async function waitFor(what: string, condition: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Json = Record<string, unknown>

/** `--json` stdout: one object per line, the last a `result` or an `error`. */
function events(stdout: string): Json[] {
  expect(stdout.endsWith('\n')).toBe(true)
  const lines = stdout.slice(0, -1).split('\n')
  const parsed = lines.map((line) => JSON.parse(line) as Json)
  expect(['result', 'error']).toContain(String(parsed[parsed.length - 1].type))
  return parsed
}

/** docs/CLI.md "Output": errors are one line on stderr starting `codictate: `. */
function expectOneErrorLine(stderr: string, contains?: string) {
  expect(stderr.endsWith('\n')).toBe(true)
  const lines = stderr.slice(0, -1).split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0].startsWith('codictate: ')).toBe(true)
  if (contains !== undefined) expect(lines[0]).toContain(contains)
}

/** docs/CLI.md "Output": progress goes to stderr only on a terminal; these runs have none. */
function expectQuietSuccess(ran: Ran) {
  expect(ran.stderr).toBe('')
  expect(ran.code).toBe(0)
}

// ── --version and finding the app ─────────────────────────────────────────

describe.skipIf(process.platform === 'win32')(
  'codictate client <-> app',
  () => {
    const appLine = `codictate ${IDENTITY.version} (${IDENTITY.identifier}, contract ${CONTRACT_VERSION})\n`

    describe('--version and where the client lives', () => {
      test('inside an app bundle it names that app, found from its own path', async () => {
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
        const ran = await codictate(['--version'], { env })
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(appLine)
      })

      test('through a symlink (the "Install command" one) it still finds its app', async () => {
        const link = join(root, 'bin', 'codictate')
        mkdirSync(join(root, 'bin'), { recursive: true })
        if (!existsSync(link)) symlinkSync(appClient, link)
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
        const ran = await codictate(['--version'], { binary: link, env })
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(appLine)
      })

      test('CODICTATE_APP_BUNDLE points it at another bundle', async () => {
        const ran = await codictate(['--version'])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(appLine)
      })

      test('outside an app bundle: (no app, contract 1)', async () => {
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
        const ran = await codictate(['--version'], {
          binary: BUILT_CLIENT,
          env,
        })
        expectQuietSuccess(ran)
        expect(ran.stdout).toMatch(/^codictate \S+ \(no app, contract 1\)\n$/)
      })

      test('--help is help on stdout, exit 0, and needs no app', async () => {
        const ran = await codictate(['--help'], {
          dataDir: join(root, 'nobody-here'),
        })
        expectQuietSuccess(ran)
        expect(ran.stdout).toContain('transcribe')
        expect(existsSync(join(root, 'nobody-here'))).toBe(false)
      })
    })

    describe("usage errors (the client's own)", () => {
      test('an unknown flag: exit 2, one line pointing at --help', async () => {
        const ran = await codictate(['status', '--nope'])
        expect(ran.code).toBe(2)
        expect(ran.stdout).toBe('')
        expectOneErrorLine(ran.stderr, "(see 'codictate --help')")
      })

      test('with --json it also prints a usage error event', async () => {
        const ran = await codictate(['status', '--nope', '--json'])
        expect(ran.code).toBe(2)
        expectOneErrorLine(ran.stderr, "(see 'codictate --help')")
        const [event] = events(ran.stdout)
        expect(event).toMatchObject({ type: 'error', code: 'usage' })
      })
    })

    // ── status ──────────────────────────────────────────────────────────────

    describe('status', () => {
      test('human: the documented key: value lines', async () => {
        const ran = await codictate(['status'])
        expectQuietSuccess(ran)
        const lines = ran.stdout.trimEnd().split('\n')
        expect(lines.map((line) => line.split(': ')[0])).toEqual([
          'app',
          'contract',
          'onboarding',
          'microphone',
          'command-line control',
          'dictation',
          'speech model',
          'transcription language',
          'file transcriptions',
        ])
        expect(ran.stdout).toBe(
          [
            `app: Codictate 0.0.62 (dev, ${IDENTITY.identifier})`,
            'contract: 1',
            'onboarding: completed',
            'microphone: granted',
            'command-line control: off',
            'dictation: idle',
            'speech model: Large V3 Turbo (large-v3-turbo-q5_0, whisper)',
            'transcription language: Auto-detect (auto)',
            'file transcriptions: 0 running, 0 queued',
            '',
          ].join('\n')
        )
      })

      test('--json: exactly one result line with the documented shape', async () => {
        const ran = await codictate(['status', '--json'])
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toEqual({
          type: 'result',
          contractVersion: 1,
          app: IDENTITY,
          onboardingCompleted: true,
          microphone: 'granted',
          commandLineControl: false,
          dictation: { active: false, startedBy: null },
          speechModel: {
            id: 'large-v3-turbo-q5_0',
            label: 'Large V3 Turbo',
            engine: 'whisper',
            installed: true,
          },
          transcriptionLanguage: { id: 'auto', label: 'Auto-detect' },
          fileTranscriptions: { running: 0, queued: 0 },
        })
      })

      test('reads are never gated by Command-Line Control', async () => {
        state.commandLineControl = false
        for (const args of [
          ['status'],
          ['models', 'list'],
          ['languages', 'list'],
        ]) {
          expect((await codictate(args)).code).toBe(0)
        }
        expect(state.notifications).toEqual([])
      })
    })

    // ── transcribe ──────────────────────────────────────────────────────────

    describe('transcribe', () => {
      test('one file, relative path, human: the transcript and a newline', async () => {
        audio('memo.json', { text: 'Hello there.' })
        const ran = await codictate(['transcribe', 'memo.json'])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe('Hello there.\n')
      })

      test('one file, --json: progress events, then the documented result', async () => {
        const file = audio('memo.json', { text: 'Hej.', seconds: 61.2 })
        state.speechModelId = HVISKE_ID
        state.transcriptionLanguageId = 'da'
        const ran = await codictate(['transcribe', 'memo.json', '--json'])
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        const result = lines[lines.length - 1]
        expect(result).toEqual({
          type: 'result',
          file,
          text: 'Hej.',
          language: 'da',
          speechModelId: HVISKE_ID,
          engine: 'hviske',
          audioSeconds: 61.2,
        })
        const progress = lines.slice(0, -1)
        expect(progress.map((e) => e.type)).toEqual(
          progress.map(() => 'progress')
        )
        expect(progress.map((e) => e.stage)).toEqual([
          'decoding',
          'transcribing',
        ])
        expect(progress[0].audioSeconds).toBeNull()
        expect(progress[1].audioSeconds).toBe(61.2)
      })

      test('an empty transcript is success with empty text', async () => {
        audio('silence.json', { text: '' })
        const ran = await codictate(['transcribe', 'silence.json'])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe('\n')
      })

      test("several files, one failing, human: tail headers, the error names the file as typed, first failure's exit", async () => {
        audio('a.json', { text: 'First.' })
        audio('c.json', { text: 'Third.' })
        const ran = await codictate([
          'transcribe',
          'a.json',
          './missing.json',
          'c.json',
        ])
        expect(ran.code).toBe(3)
        expect(ran.stdout).toBe(
          '==> a.json <==\nFirst.\n\n==> c.json <==\nThird.\n'
        )
        expectOneErrorLine(ran.stderr, 'codictate: ./missing.json: ')
      })

      test("several files, --json: each file's events in turn, one result or error per file", async () => {
        const a = audio('a.json', { text: 'First.' })
        audio('bad.json', { decode: 'no_audio' })
        audio('c.json', { text: 'Third.', engineFails: true })
        const ran = await codictate([
          'transcribe',
          'a.json',
          'bad.json',
          'c.json',
          '--json',
        ])
        // The first failure's exit: no_audio is 3, engine_failed (5) comes later.
        expect(ran.code).toBe(3)
        const lines = events(ran.stdout)
        const terminal = lines.filter(
          (e) => e.type === 'result' || e.type === 'error'
        )
        expect(terminal).toHaveLength(3)
        expect(terminal[0]).toMatchObject({ type: 'result', file: a })
        expect(terminal[1]).toMatchObject({ type: 'error', code: 'no_audio' })
        expect(terminal[2]).toMatchObject({
          type: 'error',
          code: 'engine_failed',
        })
        const stderr = ran.stderr.trimEnd().split('\n')
        expect(stderr).toHaveLength(2)
        expect(stderr[0].startsWith('codictate: bad.json: ')).toBe(true)
        expect(stderr[1].startsWith('codictate: c.json: ')).toBe(true)
      })

      test('error codes map to the documented exits', async () => {
        audio('ok.json', { text: 'x' })
        audio('unreadable.json', { decode: 'input_unreadable' })
        audio('engine.json', { engineFails: true })
        const cases: [string[], number, string][] = [
          [['transcribe', 'unreadable.json'], 3, 'input_unreadable'],
          [['transcribe', 'engine.json'], 5, 'engine_failed'],
          [
            ['transcribe', 'ok.json', '--model', NOT_INSTALLED_ID],
            4,
            'model_not_installed',
          ],
          [['transcribe', 'ok.json', '--model', 'nope'], 2, 'unknown_model'],
          [
            ['transcribe', 'ok.json', '--language', 'xx'],
            2,
            'unknown_language',
          ],
        ]
        for (const [args, exit, code] of cases) {
          const ran = await codictate([...args, '--json'])
          expect({ args, exit: ran.code }).toEqual({ args, exit })
          const lines = events(ran.stdout)
          expect(lines[lines.length - 1]).toMatchObject({ type: 'error', code })
          expectOneErrorLine(ran.stderr)
        }
      })

      test('--language is coerced for the Speech Model, as a settings change would be', async () => {
        audio('ok.json', { text: 'x' })
        const ran = await codictate([
          'transcribe',
          'ok.json',
          '--model',
          HVISKE_ID,
          '--language',
          'en',
          '--json',
        ])
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines[lines.length - 1]).toMatchObject({
          speechModelId: HVISKE_ID,
          language: 'da',
          engine: 'hviske',
        })
        expect(state.speechModelId).toBe(DEFAULT_MODEL_ID)
      })

      test('waits in the queue behind a window job: queued event, and status counts it', async () => {
        const blocker = audio('window.json', { hold: true, text: 'w' })
        const windowJob = queue.enqueue({
          filePath: blocker,
          origin: { kind: 'window' },
        })
        await waitFor('the window job to start', () =>
          state.decodeStarted.includes(blocker)
        )
        const status = events((await codictate(['status', '--json'])).stdout)[0]
        expect(status.fileTranscriptions).toEqual({ running: 1, queued: 0 })

        audio('mine.json', { text: 'Mine.' })
        const run = spawnClient(['transcribe', 'mine.json', '--json'])
        await waitFor(
          'the client job to queue',
          () => queue.snapshot().length === 2
        )
        // `caller` is the client's parent process: this test runner.
        expect(queue.snapshot()[1].origin).toEqual({
          kind: 'command-line',
          callerName: 'bun',
        })
        const queuedStatus = events(
          (await codictate(['status', '--json'])).stdout
        )[0]
        expect(queuedStatus.fileTranscriptions).toEqual({
          running: 1,
          queued: 1,
        })
        releaseHolds()
        expect((await windowJob.result).status).toBe('ok')

        const ran = await run.done
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines[0]).toEqual({ type: 'queued', position: 1 })
        expect(lines[lines.length - 1]).toMatchObject({
          type: 'result',
          text: 'Mine.',
        })
      })

      for (const [signal, exit] of [
        ['SIGTERM', 143],
        ['SIGINT', 130],
      ] as const) {
        test(`${signal} cancels a running transcription: exit ${exit}, the app stops the engine`, async () => {
          const file = audio('long.json', {
            text: 'never',
            transcribeMs: 30_000,
          })
          const run = spawnClient(['transcribe', 'long.json', '--json'])
          await waitFor('decoding to start', () =>
            state.decodeStarted.includes(file)
          )
          await waitFor('transcribing', () =>
            queue.snapshot().some((job) => job.state === 'transcribing')
          )
          run.proc.kill(signal)
          const ran = await run.done
          expect(ran.code).toBe(exit)
          expectOneErrorLine(ran.stderr, 'codictate: ')
          const lines = events(ran.stdout)
          expect(lines[lines.length - 1]).toMatchObject({
            type: 'error',
            code: 'cancelled',
          })
          await waitFor(
            'the engine to be stopped',
            () => state.transcribeAborted === 1
          )
          await waitFor(
            'the queue to empty',
            () => queue.snapshot().length === 0
          )
        })
      }

      test('SIGINT while queued takes the job out of the queue', async () => {
        const blocker = audio('window.json', { hold: true, text: 'w' })
        const windowJob = queue.enqueue({
          filePath: blocker,
          origin: { kind: 'window' },
        })
        await waitFor('the window job to start', () =>
          state.decodeStarted.includes(blocker)
        )
        audio('mine.json', { text: 'Mine.' })
        const run = spawnClient(['transcribe', 'mine.json'])
        await waitFor(
          'the client job to queue',
          () => queue.snapshot().length === 2
        )
        run.proc.kill('SIGINT')
        const ran = await run.done
        expect(ran.code).toBe(130)
        expect(ran.stdout).toBe('')
        expectOneErrorLine(ran.stderr)
        await waitFor(
          'the queued job to leave',
          () => queue.snapshot().length === 1
        )
        releaseHolds()
        await windowJob.result
      })
    })

    // ── dictate and stop ────────────────────────────────────────────────────

    describe('dictate', () => {
      test('Command-Line Control off: exit 7, a notification names the setting, nothing records', async () => {
        const ran = await codictate(['dictate'])
        expect(ran.code).toBe(7)
        expect(ran.stdout).toBe('')
        expectOneErrorLine(ran.stderr, 'Command-Line Control')
        expect(dictation.starts).toEqual([])
        expect(state.notifications).toHaveLength(1)
        expect(state.notifications[0].body).toContain('Settings > Command Line')

        const json = await codictate(['dictate', '--json'])
        expect(json.code).toBe(7)
        expect(events(json.stdout)).toEqual([
          expect.objectContaining({
            type: 'error',
            code: 'command_line_control_off',
          }),
        ])
      })

      test('the first SIGINT stops it: the text is printed, exit 0', async () => {
        state.commandLineControl = true
        const run = spawnClient(['dictate'])
        await dictation.whenStarted()
        run.proc.kill('SIGINT')
        const ran = await run.done
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(`${dictation.text}\n`)
        expect(dictation.starts[0]).toMatchObject({
          output: 'stdout',
          raw: false,
          until: 'enter',
          maxSeconds: null,
        })
        expect(dictation.cancels).toBe(0)
      })

      test('--json: recording, transcribing, then the documented result', async () => {
        state.commandLineControl = true
        const run = spawnClient(['dictate', '--json'])
        await dictation.whenStarted()
        run.proc.kill('SIGINT')
        const ran = await run.done
        expectQuietSuccess(ran)
        expect(events(ran.stdout)).toEqual([
          { type: 'recording' },
          { type: 'transcribing' },
          {
            type: 'result',
            text: dictation.text,
            rawText: dictation.text,
            formattingMode: null,
            pasted: false,
            live: false,
            language: null,
            speechModelId: DEFAULT_MODEL_ID,
            engine: 'whisper',
            audioSeconds: 1.5,
          },
        ])
      })

      test('a second SIGINT cancels it: exit 130, nothing printed', async () => {
        state.commandLineControl = true
        dictation.stopDelayMs = 30_000
        const run = spawnClient(['dictate', '--json'])
        await dictation.whenStarted()
        run.proc.kill('SIGINT')
        await waitFor('the stop to reach the app', () => dictation.stops === 1)
        run.proc.kill('SIGINT')
        const ran = await run.done
        expect(ran.code).toBe(130)
        const lines = events(ran.stdout)
        expect(lines.map((e) => e.type)).toEqual([
          'recording',
          'transcribing',
          'error',
        ])
        expect(lines[2]).toMatchObject({ code: 'cancelled' })
        expectOneErrorLine(ran.stderr)
        expect(dictation.cancels).toBe(1)
      })

      test('SIGTERM cancels it at once: exit 143', async () => {
        state.commandLineControl = true
        const run = spawnClient(['dictate'])
        await dictation.whenStarted()
        run.proc.kill('SIGTERM')
        const ran = await run.done
        expect(ran.code).toBe(143)
        expect(ran.stdout).toBe('')
        expectOneErrorLine(ran.stderr)
        expect(dictation.cancels).toBe(1)
      })

      test('--paste: placed at the cursor, nothing printed; `codictate stop` from another process ends it', async () => {
        state.commandLineControl = true
        const run = spawnClient(['dictate', '--paste'])
        await dictation.whenStarted()

        const status = events((await codictate(['status', '--json'])).stdout)[0]
        expect(status.dictation).toEqual({
          active: true,
          startedBy: 'command-line',
        })
        const busy = await codictate(['dictate'])
        expect(busy.code).toBe(8)
        expectOneErrorLine(busy.stderr)

        const stop = await codictate(['stop'])
        expectQuietSuccess(stop)
        expect(stop.stdout).toBe('Stopped the Dictation.\n')

        const ran = await run.done
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe('')
        expect(dictation.starts[0].output).toBe('cursor')
      })

      test('--paste --json: the result says pasted', async () => {
        state.commandLineControl = true
        const run = spawnClient(['dictate', '--paste', '--json'])
        await dictation.whenStarted()
        run.proc.kill('SIGINT')
        const ran = await run.done
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines[lines.length - 1]).toMatchObject({
          type: 'result',
          pasted: true,
        })
      })

      test('--max ends it in the app, and every flag reaches the app', async () => {
        state.commandLineControl = true
        const ran = await codictate([
          'dictate',
          '--max',
          '0.3',
          '--raw',
          '--until',
          'silence',
          '--model',
          SMALL_ID,
          '--language',
          'da',
        ])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(`${dictation.text}\n`)
        expect(dictation.starts[0]).toMatchObject({
          output: 'stdout',
          raw: true,
          until: 'silence',
          maxSeconds: 0.3,
          speechModelId: SMALL_ID,
          transcriptionLanguageId: 'da',
          formattingModeId: null,
        })
      })

      test('argument errors from the app: exit 2', async () => {
        state.commandLineControl = true
        const unknownMode = await codictate([
          'dictate',
          '--formatting-mode',
          'nope',
        ])
        expect(unknownMode.code).toBe(2)
        expectOneErrorLine(unknownMode.stderr)
        const rawAndMode = await codictate([
          'dictate',
          '--raw',
          '--formatting-mode',
          'email',
          '--json',
        ])
        expect(rawAndMode.code).toBe(2)
        expect(events(rawAndMode.stdout)).toEqual([
          expect.objectContaining({ type: 'error', code: 'usage' }),
        ])
        expectOneErrorLine(rawAndMode.stderr)
        const notInstalled = await codictate([
          'dictate',
          '--model',
          NOT_INSTALLED_ID,
          '--json',
        ])
        expect(notInstalled.code).toBe(4)
        expect(events(notInstalled.stdout)).toEqual([
          expect.objectContaining({
            type: 'error',
            code: 'model_not_installed',
          }),
        ])
        expect(dictation.starts).toEqual([])
      })
    })

    // ── On a terminal: progress on stderr, Enter ends a Dictation ────────────

    /**
     * The client on a pty, through `script`; its stdout and stderr arrive merged. `cat` in
     * front because `script` needs a pipe or a tty on stdin, and Bun's is a socket.
     */
    function onTerminal(args: string[]) {
      const command = ['sh', '-c', 'cat | script -q /dev/null "$@"', 'sh']
      const proc = Bun.spawn([...command, appClient, ...args], {
        cwd: work,
        env: clientEnv(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const done = (async () => {
        const output = await new Response(proc.stdout).text()
        return { code: await proc.exited, output }
      })()
      return { proc, done }
    }

    describe('on a terminal', () => {
      test('dictate: Enter stops it, the recording hint and the text are shown', async () => {
        state.commandLineControl = true
        const run = onTerminal(['dictate'])
        await dictation.whenStarted()
        // `script` can drop input that arrives while it is still setting up the pty, so Enter
        // is repeated until the app has the stop; a later Enter means nothing to the client.
        const enter = () => {
          run.proc.stdin.write('\n')
          run.proc.stdin.flush()
        }
        enter()
        const again = setInterval(enter, 250)
        try {
          await waitFor(
            'the stop to reach the app',
            () => dictation.stops === 1
          )
        } finally {
          clearInterval(again)
          run.proc.stdin.end()
        }
        const ran = await run.done
        expect(ran.code).toBe(0)
        expect(ran.output).toContain('Recording... press Enter to stop')
        expect(ran.output).toContain(dictation.text)
        expect(dictation.stops).toBe(1)
        expect(dictation.cancels).toBe(0)
      })

      test('transcribe: progress on stderr, then the transcript', async () => {
        audio('slow.json', {
          text: 'Slowly.',
          transcribeMs: 1_300,
          seconds: 61,
        })
        const run = onTerminal(['transcribe', 'slow.json'])
        run.proc.stdin.end()
        const ran = await run.done
        expect(ran.code).toBe(0)
        expect(ran.output).toContain('Transcribing... 0:01 (1:01 of audio)')
        expect(ran.output).toContain('Slowly.')
      })

      test('models download: the percentage', async () => {
        state.commandLineControl = true
        const run = onTerminal(['models', 'download', DOWNLOADABLE_ID])
        run.proc.stdin.end()
        const ran = await run.done
        expect(ran.code).toBe(0)
        expect(ran.output).toContain('Downloading... 10%')
        expect(ran.output).toContain(`Downloaded ${DOWNLOADABLE_ID}`)
      })
    })

    describe('stop', () => {
      test('nothing running: success, "No Dictation was running."', async () => {
        state.commandLineControl = true
        const ran = await codictate(['stop'])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe('No Dictation was running.\n')
        const json = await codictate(['stop', '--json'])
        expect(events(json.stdout)).toEqual([
          { type: 'result', stopped: false },
        ])
      })

      test('needs Command-Line Control: exit 7', async () => {
        const ran = await codictate(['stop', '--json'])
        expect(ran.code).toBe(7)
        expect(events(ran.stdout)[0]).toMatchObject({
          code: 'command_line_control_off',
        })
      })
    })

    // ── models ──────────────────────────────────────────────────────────────

    describe('models', () => {
      const listed = (all: boolean) =>
        SPEECH_MODELS.filter(
          (m) => all || m.curated === true || state.installed.has(m.id)
        ).map((m) => m.id)

      test('list: curated plus installed, a table with the selected row marked *', async () => {
        const ran = await codictate(['models', 'list'])
        expectQuietSuccess(ran)
        const lines = ran.stdout.trimEnd().split('\n')
        expect(lines[0]).toMatch(/^ {2}ID +NAME +ENGINE +SIZE +STATUS$/)
        const rows = lines.slice(1)
        expect(rows.map((row) => row.slice(2).split(/ +/)[0])).toEqual(
          listed(false)
        )
        expect(rows.filter((row) => row.startsWith('* '))).toEqual([
          expect.stringMatching(/^\* large-v3-turbo-q5_0 /),
        ])
        expect(rows.find((row) => row.includes(HVISKE_ID))).toContain(
          'installed'
        )
      })

      test('list --all --json: every Speech Model, one result line', async () => {
        const ran = await codictate(['models', 'list', '--all', '--json'])
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines).toHaveLength(1)
        const models = lines[0].models as Json[]
        expect(models.map((m) => m.id)).toEqual(listed(true))
        expect(models.find((m) => m.id === DEFAULT_MODEL_ID)).toEqual({
          id: DEFAULT_MODEL_ID,
          label: 'Large V3 Turbo',
          engine: 'whisper',
          downloadSizeMB: getSpeechModel(DEFAULT_MODEL_ID)!.downloadSizeMB,
          installed: true,
          selected: true,
          curated: true,
          bundled: true,
        })
      })

      test('use: needs Command-Line Control (7), must be installed (4), unknown is 2, then "Selected <id>"', async () => {
        expect((await codictate(['models', 'use', SMALL_ID])).code).toBe(7)
        state.commandLineControl = true
        const missing = await codictate(['models', 'use', NOT_INSTALLED_ID])
        expect(missing.code).toBe(4)
        expectOneErrorLine(missing.stderr)
        expect((await codictate(['models', 'use', 'nope'])).code).toBe(2)

        const ran = await codictate(['models', 'use', SMALL_ID])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(`Selected ${SMALL_ID}\n`)
        expect(state.speechModelId).toBe(SMALL_ID)

        const json = await codictate([
          'models',
          'use',
          DEFAULT_MODEL_ID,
          '--json',
        ])
        expect(events(json.stdout)).toEqual([
          { type: 'result', speechModelId: DEFAULT_MODEL_ID },
        ])
      })

      test('download --json: download events with fractions, then the result; does not select', async () => {
        state.commandLineControl = true
        const ran = await codictate([
          'models',
          'download',
          DOWNLOADABLE_ID,
          '--json',
        ])
        expectQuietSuccess(ran)
        const lines = events(ran.stdout)
        expect(lines[lines.length - 1]).toEqual({
          type: 'result',
          speechModelId: DOWNLOADABLE_ID,
        })
        const progress = lines.slice(0, -1)
        expect(progress.length).toBeGreaterThan(0)
        for (const event of progress) {
          expect(event.type).toBe('download')
          expect(typeof event.fraction).toBe('number')
        }
        const fractions = progress.map((e) => e.fraction as number)
        expect([...fractions].sort((x, y) => x - y)).toEqual(fractions)
        expect(state.installed.has(DOWNLOADABLE_ID)).toBe(true)
        expect(state.speechModelId).toBe(DEFAULT_MODEL_ID)
      })

      test('download, human: "Downloaded <id>", no progress off a terminal', async () => {
        state.commandLineControl = true
        const ran = await codictate(['models', 'download', DOWNLOADABLE_ID])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(`Downloaded ${DOWNLOADABLE_ID}\n`)
      })

      test('download fails: exit 10; unknown: exit 2; control off: exit 7', async () => {
        expect(
          (await codictate(['models', 'download', DOWNLOADABLE_ID])).code
        ).toBe(7)
        state.commandLineControl = true
        state.downloadError = 'connection reset'
        const failed = await codictate([
          'models',
          'download',
          DOWNLOADABLE_ID,
          '--json',
        ])
        expect(failed.code).toBe(10)
        const lines = events(failed.stdout)
        expect(lines[lines.length - 1]).toMatchObject({
          type: 'error',
          code: 'download_failed',
        })
        expectOneErrorLine(failed.stderr, 'connection reset')
        expect((await codictate(['models', 'download', 'nope'])).code).toBe(2)
      })

      test('SIGINT cancels a download: exit 130, and the download stops', async () => {
        state.commandLineControl = true
        const run = spawnClient(['models', 'download', DOWNLOADABLE_ID])
        await new Promise((resolve) => setTimeout(resolve, 400))
        run.proc.kill('SIGINT')
        const ran = await run.done
        expect(ran.code).toBe(130)
        expectOneErrorLine(ran.stderr)
        await waitFor('the download to stop', () =>
          state.cancelledDownloads.includes(DOWNLOADABLE_ID)
        )
        expect(state.installed.has(DOWNLOADABLE_ID)).toBe(false)
      })

      test('remove: a bundled Speech Model is refused with exit 2, an installed one is "Removed <id>"', async () => {
        state.commandLineControl = true
        const bundled = await codictate([
          'models',
          'remove',
          DEFAULT_MODEL_ID,
          '--json',
        ])
        expect(bundled.code).toBe(2)
        expect(events(bundled.stdout)).toEqual([
          expect.objectContaining({ type: 'error', code: 'model_bundled' }),
        ])
        expectOneErrorLine(bundled.stderr)
        expect(state.installed.has(DEFAULT_MODEL_ID)).toBe(true)

        const ran = await codictate(['models', 'remove', SMALL_ID])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe(`Removed ${SMALL_ID}\n`)
        expect(state.installed.has(SMALL_ID)).toBe(false)
      })
    })

    // ── languages ───────────────────────────────────────────────────────────

    describe('languages', () => {
      test('list: every Transcription Language, the selected one marked, disallowed ones said', async () => {
        state.speechModelId = HVISKE_ID
        state.transcriptionLanguageId = 'da'
        const ran = await codictate(['languages', 'list'])
        expectQuietSuccess(ran)
        const rows = ran.stdout.trimEnd().split('\n').slice(1)
        expect(rows).toHaveLength(TRANSCRIPTION_LANGUAGE_OPTIONS.length)
        expect(rows.filter((row) => row.startsWith('* '))).toEqual([
          expect.stringMatching(/^\* da /),
        ])
        const english = rows.find((row) => row.slice(2).startsWith('en '))!
        expect(english).toContain('not allowed')

        const json = await codictate(['languages', 'list', '--json'])
        const [result] = events(json.stdout)
        const languages = result.languages as Json[]
        expect(languages.map((l) => l.id)).toEqual(
          TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => o.id)
        )
        expect(languages.find((l) => l.id === 'en')).toMatchObject({
          selected: false,
          allowed: false,
        })
      })

      test('use: "Selected <id>"; not allowed by the Speech Model or unknown is exit 2; control off is 7', async () => {
        expect((await codictate(['languages', 'use', 'da'])).code).toBe(7)
        state.commandLineControl = true
        const ran = await codictate(['languages', 'use', 'da'])
        expectQuietSuccess(ran)
        expect(ran.stdout).toBe('Selected da\n')
        expect(state.transcriptionLanguageId).toBe('da')

        state.speechModelId = HVISKE_ID
        const refused = await codictate(['languages', 'use', 'en', '--json'])
        expect(refused.code).toBe(2)
        expect(events(refused.stdout)).toEqual([
          expect.objectContaining({
            type: 'error',
            code: 'language_not_allowed',
          }),
        ])
        expectOneErrorLine(refused.stderr)

        const unknown = await codictate(['languages', 'use', 'xx'])
        expect(unknown.code).toBe(2)

        const json = await codictate(['languages', 'use', 'auto', '--json'])
        expect(events(json.stdout)).toEqual([
          { type: 'result', transcriptionLanguageId: 'auto' },
        ])
      })
    })

    // ── When the app is not there, or disagrees ──────────────────────────────

    /** A listener that is not the real app, on the endpoint the app would use. */
    async function fakeApp(
      appDataDir: string,
      onRequest: (line: string, socket: net.Socket) => void
    ) {
      const endpoint = endpointFor(appDataDir)
      if (endpoint.kind !== 'unix-socket') throw new Error('Unix only')
      mkdirSync(endpoint.runDir, { recursive: true, mode: 0o700 })
      let connections = 0
      /** Every line after a request: the control lines. */
      const controls: Json[] = []
      const sockets = new Set<net.Socket>()
      const fake = net.createServer((socket) => {
        connections += 1
        sockets.add(socket)
        const splitter = new NdjsonLineSplitter()
        let answered = false
        socket.on('data', (chunk: Buffer) => {
          for (const line of splitter.push(chunk)) {
            if (answered) {
              controls.push(JSON.parse(line) as Json)
              continue
            }
            answered = true
            onRequest(line, socket)
          }
        })
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise<void>((resolve) => fake.listen(endpoint.path, resolve))
      return {
        controls,
        get connections() {
          return connections
        },
        close: () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy()
            fake.close(() => resolve())
          }),
      }
    }

    describe('the app disagrees or is gone', () => {
      test('contract mismatch: exit 11, and the remaining files are not sent', async () => {
        // The real request parser, handed the client's request as a newer client would
        // send it: the app's own `contract_mismatch` answer goes back over the socket.
        const appDataDir = join(root, 'data-mismatch')
        const requests: Json[] = []
        const fake = await fakeApp(appDataDir, (line, socket) => {
          const request = JSON.parse(line) as Json
          requests.push(request)
          const parsed = parseRequestLine(
            JSON.stringify({
              ...request,
              contractVersion: CONTRACT_VERSION + 1,
            })
          )
          if (parsed.ok) throw new Error('expected a contract mismatch')
          socket.end(encodeLine(parsed.error))
        })
        try {
          audio('a.json', { text: 'a' })
          audio('b.json', { text: 'b' })
          const ran = await codictate(
            ['transcribe', 'a.json', 'b.json', '--json'],
            {
              dataDir: appDataDir,
            }
          )
          expect(ran.code).toBe(11)
          expect(events(ran.stdout)).toEqual([
            expect.objectContaining({
              type: 'error',
              code: 'contract_mismatch',
            }),
          ])
          expect(fake.connections).toBe(1)
          expect(ran.stderr.trimEnd().split('\n')).toHaveLength(1)
          // docs/CLI.md "Request": the documented line, the relative file made absolute,
          // unset optional args sent as null.
          expect(requests).toEqual([
            {
              contractVersion: CONTRACT_VERSION,
              command: 'transcribe',
              args: {
                file: join(work, 'a.json'),
                speechModelId: null,
                languageId: null,
              },
              caller: { name: 'bun', pid: process.pid },
            },
          ])

          const status = await codictate(['status'], { dataDir: appDataDir })
          expect(status.code).toBe(11)
          expectOneErrorLine(status.stderr, 'contract version')
        } finally {
          await fake.close()
        }
      })

      test('cancel: the client sends cancel and waits up to 2 s for an app that does not answer', async () => {
        const appDataDir = join(root, 'data-silent')
        let requested = false
        const fake = await fakeApp(appDataDir, (_line, socket) => {
          requested = true
          socket.write(encodeLine({ type: 'queued', position: 1 }))
        })
        try {
          const run = spawnClient(['transcribe', 'a.json', '--json'], {
            dataDir: appDataDir,
          })
          await waitFor('the request', () => requested)
          const sent = Date.now()
          run.proc.kill('SIGTERM')
          const ran = await run.done
          const waited = Date.now() - sent
          expect(ran.code).toBe(143)
          expect(waited).toBeGreaterThan(1_800)
          expect(waited).toBeLessThan(4_000)
          expect(fake.controls).toEqual([{ type: 'cancel' }])
          // The client's own `cancelled`, so the last line is still an `error`.
          expect(events(ran.stdout)).toEqual([
            { type: 'queued', position: 1 },
            expect.objectContaining({ type: 'error', code: 'cancelled' }),
          ])
          expectOneErrorLine(ran.stderr)
        } finally {
          await fake.close()
        }
      })

      test('cancel: a second signal exits at once', async () => {
        const appDataDir = join(root, 'data-silent-twice')
        let requested = false
        const fake = await fakeApp(appDataDir, () => {
          requested = true
        })
        try {
          const run = spawnClient(['models', 'download', DOWNLOADABLE_ID], {
            dataDir: appDataDir,
          })
          await waitFor('the request', () => requested)
          run.proc.kill('SIGINT')
          await waitFor('the cancel', () => fake.controls.length === 1)
          const second = Date.now()
          run.proc.kill('SIGINT')
          const ran = await run.done
          expect(Date.now() - second).toBeLessThan(1_000)
          expect(ran.code).toBe(130)
          expect(fake.controls).toEqual([{ type: 'cancel' }])
          expectOneErrorLine(ran.stderr)
        } finally {
          await fake.close()
        }
      })

      test('dictate: the first SIGINT is a stop line on the wire, the second a cancel', async () => {
        const appDataDir = join(root, 'data-silent-dictate')
        let requested = false
        const fake = await fakeApp(appDataDir, (line, socket) => {
          requested = true
          expect((JSON.parse(line) as Json).command).toBe('dictate')
          socket.write(encodeLine({ type: 'recording' }))
        })
        try {
          const run = spawnClient(['dictate'], { dataDir: appDataDir })
          await waitFor('the request', () => requested)
          run.proc.kill('SIGINT')
          await waitFor('the stop', () => fake.controls.length === 1)
          run.proc.kill('SIGINT')
          await waitFor('the cancel', () => fake.controls.length === 2)
          run.proc.kill('SIGINT')
          const ran = await run.done
          expect(ran.code).toBe(130)
          expect(fake.controls).toEqual([{ type: 'stop' }, { type: 'cancel' }])
        } finally {
          await fake.close()
        }
      })

      test('the app closes the connection without an answer: exit 6, and --json still ends on an error', async () => {
        const appDataDir = join(root, 'data-hangup')
        const fake = await fakeApp(appDataDir, (_line, socket) => socket.end())
        try {
          const ran = await codictate(['status', '--json'], {
            dataDir: appDataDir,
          })
          expect(ran.code).toBe(6)
          expect(events(ran.stdout)).toEqual([
            expect.objectContaining({ type: 'error', code: 'app_unavailable' }),
          ])
          expectOneErrorLine(ran.stderr)
        } finally {
          await fake.close()
        }
      })

      test('not running and cannot be started: exit 6, after leaving a fresh hidden-launch marker', async () => {
        const appDataDir = join(root, 'data-nobody')
        const started = Date.now()
        const ran = await codictate(['status', '--json'], {
          dataDir: appDataDir,
        })
        expect(ran.code).toBe(6)
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(events(ran.stdout)).toEqual([
          expect.objectContaining({ type: 'error', code: 'app_unavailable' }),
        ])
        expectOneErrorLine(ran.stderr, INERT_BUNDLE)
        const marker = hiddenLaunchMarkerPath(appDataDir, IDENTITY.identifier)
        expect(
          isFreshHiddenLaunchMarker(readFileSync(marker, 'utf8'), Date.now())
        ).toBe(true)
        expect(statSync(join(appDataDir, 'run')).mode & 0o777).toBe(0o700)

        const human = await codictate(['transcribe', 'x.json', 'y.json'], {
          dataDir: appDataDir,
        })
        expect(human.code).toBe(6)
        expect(human.stdout).toBe('')
        expectOneErrorLine(human.stderr)
      })
    })

    describe('one app per user and identifier', () => {
      test('a second app on the same endpoint is told to quit, and the first keeps serving', async () => {
        const second = await startCommandLineServer(
          endpointFor(dataDir),
          handlers
        )
        expect(second.status).toBe('another-instance')
        const ran = await codictate(['status', '--json'])
        expect(ran.code).toBe(0)
      })

      test("a crashed app's socket file is replaced under the lock", async () => {
        const appDataDir = join(root, 'data-crashed')
        const endpoint = endpointFor(appDataDir)
        mkdirSync(join(appDataDir, 'run'), { recursive: true, mode: 0o700 })
        writeFileSync(endpoint.path, '')
        const revived = await serve(appDataDir)
        try {
          const ran = await codictate(['status', '--json'], {
            dataDir: appDataDir,
          })
          expect(ran.code).toBe(0)
        } finally {
          revived.close()
        }
      })
    })

    describe('a socket path too long for a Unix socket', () => {
      // Past 103 bytes once `/run/<identifier>.sock` is added; the docs/CLI.md fallback.
      const longDataDir = () => join(root, 'd'.repeat(100))
      const sharedDir = `/tmp/codictate-${process.getuid!()}`
      let sharedDirExisted = false
      let longServer: CommandLineServer | null = null

      beforeAll(async () => {
        sharedDirExisted = existsSync(sharedDir)
        longServer = await serve(longDataDir())
      })

      afterAll(() => {
        longServer?.close()
        if (!sharedDirExisted)
          rmSync(sharedDir, { recursive: true, force: true })
      })

      test('both sides use /tmp/codictate-<uid>/<identifier>.sock, private to the user', async () => {
        const endpoint = endpointFor(longDataDir())
        expect(endpoint.path).toBe(`${sharedDir}/${IDENTITY.identifier}.sock`)
        expect(statSync(sharedDir).mode & 0o7777).toBe(0o700)
        const ran = await codictate(['status', '--json'], {
          dataDir: longDataDir(),
        })
        expect(ran.code).toBe(0)
        const lines = events(ran.stdout)
        expect(lines[lines.length - 1]).toMatchObject({ type: 'result' })
      })

      test('the client refuses a shared directory that is not 0700: exit 6, one line', async () => {
        chmodSync(sharedDir, 0o755)
        try {
          const ran = await codictate(['status'], { dataDir: longDataDir() })
          expect(ran.code).toBe(6)
          expectOneErrorLine(ran.stderr, `refusing ${sharedDir}: mode 0755`)
        } finally {
          chmodSync(sharedDir, 0o700)
        }
      })
    })
  }
)
