import { describe, expect, test } from 'bun:test'
import type { RunnableDictationPlan } from '../../../../shared/dictation-plan'
import type { ParakeetSessionRequest } from '../../../../shared/parakeet-session-protocol'
import { transcribeWithParakeet } from './parakeet-engine'
import {
  killParakeetSessions,
  spawnsParakeetSessionAtRecordStart,
  startParakeetSession,
  type ParakeetSession,
  type ParakeetSessionDeps,
  type ParakeetSessionProcess,
} from './parakeet-session'
import type { ProcessSupervisorClock } from './process-supervisor'
import type { ParakeetTranscriptionRequest } from './transcription'

const MODEL_ID = 'parakeet-tdt-0.6b-v3'
const MODEL_DIR = '/models/parakeet-tdt-0.6b-v3'
const HELPER = '/helpers/CodictateParakeetHelperDev'
const LOAD_TIMEOUT_MS = 10_000
const GRACE_MS = 5

class ManualClock implements ProcessSupervisorClock {
  private now = 0
  private nextId = 1
  private tasks = new Map<number, { at: number; callback: () => void }>()

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.tasks.set(id, { at: this.now + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.now + delayMs
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.now = due[1].at
      this.tasks.delete(due[0])
      due[1].callback()
      await settle()
    }
    this.now = target
    await settle()
  }
}

/** Lets every pending promise chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

class FakeHelper implements ParakeetSessionProcess {
  readonly pid = 4242
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly requests: ParakeetSessionRequest[] = []
  readonly signals: (number | NodeJS.Signals | undefined)[] = []
  endCalls = 0
  onRequest: (request: ParakeetSessionRequest) => void = () => {}

  private stdoutController!: ReadableStreamDefaultController<Uint8Array>
  private stderrController!: ReadableStreamDefaultController<Uint8Array>
  private resolveExited!: (code: number) => void
  private closed = false
  private input = ''

  readonly exited = new Promise<number>((resolve) => {
    this.resolveExited = resolve
  })

  readonly stdin = {
    write: (data: string | Uint8Array) => {
      this.input +=
        typeof data === 'string' ? data : new TextDecoder().decode(data)
      let newline = this.input.indexOf('\n')
      while (newline >= 0) {
        const line = this.input.slice(0, newline)
        this.input = this.input.slice(newline + 1)
        const request = JSON.parse(line) as ParakeetSessionRequest
        this.requests.push(request)
        this.onRequest(request)
        newline = this.input.indexOf('\n')
      }
    },
    flush: () => {},
    end: () => {
      this.endCalls++
      this.exit(0)
    },
  }

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller
      },
    })
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrController = controller
      },
    })
  }

  get alive(): boolean {
    return !this.closed
  }

  line(value: unknown): void {
    if (this.closed) return
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    this.stdoutController.enqueue(new TextEncoder().encode(`${text}\n`))
  }

  ready(): void {
    this.line({ kind: 'ready' })
  }

  log(text: string): void {
    if (this.closed) return
    this.stderrController.enqueue(new TextEncoder().encode(`${text}\n`))
  }

  exit(code: number): void {
    if (this.closed) return
    this.closed = true
    this.stdoutController.close()
    this.stderrController.close()
    this.resolveExited(code)
  }

  kill(signal?: number | NodeJS.Signals): void {
    this.signals.push(signal)
    this.exit(signal === 'SIGKILL' ? 137 : 143)
  }
}

function harness(overrides: Partial<ParakeetSessionDeps> = {}) {
  const clock = new ManualClock()
  const spawned: string[][] = []
  const helpers: FakeHelper[] = []
  const lowered: number[] = []
  const deps: Partial<ParakeetSessionDeps> = {
    resolveHelperBinary: () => HELPER,
    modelDirExists: () => true,
    spawn: (argv) => {
      spawned.push(argv)
      const helper = new FakeHelper()
      helpers.push(helper)
      return helper
    },
    clock,
    lowerPriority: (pid) => lowered.push(pid),
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    cleanupGraceMs: GRACE_MS,
    ...overrides,
  }
  const start = () =>
    startParakeetSession({ speechModelId: MODEL_ID, modelDir: MODEL_DIR }, deps)
  return { clock, spawned, helpers, lowered, start }
}

function request(
  overrides: Partial<ParakeetTranscriptionRequest> = {}
): ParakeetTranscriptionRequest {
  return {
    engineId: 'whisperkit',
    speechModelId: MODEL_ID,
    audioPath: '/tmp/recording.wav',
    timeoutMs: 1_000,
    modelDir: MODEL_DIR,
    ...overrides,
  }
}

const finalWithTiming = (id: number) => ({
  kind: 'final',
  id,
  text: 'Hello there.',
  timing: {
    unit: 'spoken-word',
    items: [
      { text: 'hello', start: 0.1, end: 0.4 },
      { text: 'there', start: 0.5, end: 0.9 },
    ],
  },
})

describe('startParakeetSession', () => {
  test('spawns transcribe-session at record start, before any request', async () => {
    const h = harness()
    h.start()
    expect(h.spawned).toEqual([[HELPER, 'transcribe-session', MODEL_DIR]])
    h.helpers[0].ready()
    await settle()
    expect(h.helpers[0].requests).toEqual([])
    expect(h.helpers[0].alive).toBe(true)
  })

  test('on stop sends one request, returns the final with its timing, then closes stdin', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.ready()
    helper.onRequest = (r) => helper.line(finalWithTiming(r.id))

    const run = await session.transcribe(request())

    expect(helper.requests).toEqual([
      { id: 1, audioPath: '/tmp/recording.wav' },
    ])
    expect(run).toEqual({
      status: 'final',
      final: {
        text: 'Hello there.',
        timing: finalWithTiming(1).timing as never,
      },
    })
    await settle()
    expect(helper.endCalls).toBe(1)
    expect(helper.signals).toEqual([])
    expect(h.spawned).toHaveLength(1)
  })

  test('waits for a load that is still running when recording stops', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.onRequest = (r) => helper.line(finalWithTiming(r.id))

    let done = false
    const pending = session.transcribe(request()).then((run) => {
      done = true
      return run
    })
    await settle()
    expect(helper.requests).toEqual([])
    expect(done).toBe(false)

    helper.log('loading models...')
    helper.ready()
    const run = await pending
    expect(run.status).toBe('final')
    expect(helper.requests).toHaveLength(1)
  })

  test('the request deadline starts when the request is sent, not at the spawn', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.ready()
    await settle()

    // A recording far longer than both the request deadline and the load bound.
    await h.clock.advanceBy(LOAD_TIMEOUT_MS * 3)
    expect(helper.alive).toBe(true)

    let settled = false
    const pending = session
      .transcribe(request({ timeoutMs: 1_000 }))
      .then((run) => {
        settled = true
        return run
      })
    await settle()
    expect(helper.requests).toHaveLength(1)

    await h.clock.advanceBy(999)
    expect(settled).toBe(false)
    await h.clock.advanceBy(1)
    const run = await pending
    expect(run.status).toBe('failed')
    if (run.status === 'failed') expect(run.reason).toBe('engine_timed_out')
    expect(helper.signals).toEqual(['SIGTERM'])
    expect(h.spawned).toHaveLength(1)
  })

  test('a helper that never loads is killed at the load bound, even mid-recording', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]

    await h.clock.advanceBy(LOAD_TIMEOUT_MS - 1)
    expect(helper.alive).toBe(true)
    await h.clock.advanceBy(1)
    expect(helper.signals).toEqual(['SIGTERM'])

    const run = await session.transcribe(request())
    expect(run.status).toBe('failed')
    if (run.status === 'failed') expect(run.reason).toBe('engine_timed_out')
    expect(helper.requests).toEqual([])
    expect(h.spawned).toHaveLength(1)
  })

  test('discard kills the helper, and a later transcribe is a cancellation', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]

    session.discard()
    session.discard()
    await settle()
    expect(helper.signals).toEqual(['SIGTERM'])

    const run = await session.transcribe(request())
    expect(run.status).toBe('failed')
    if (run.status === 'failed') expect(run.reason).toBe('cancelled')
    expect(helper.requests).toEqual([])
  })

  test('discard after transcribe leaves the cleanup to transcribe', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.ready()
    helper.onRequest = (r) => helper.line({ kind: 'final', id: r.id, text: '' })

    const run = await session.transcribe(request())
    session.discard()
    await settle()
    expect(run).toEqual({
      status: 'final',
      final: { text: '', timing: null },
    })
    expect(helper.endCalls).toBe(1)
    expect(helper.signals).toEqual([])
  })

  test('a helper that dies while loading fails the Dictation, with no second spawn', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.log('codictate-parakeet-helper: model not found')
    helper.exit(1)

    const run = await session.transcribe(request())
    expect(run.status).toBe('failed')
    if (run.status === 'failed') {
      expect(run.reason).toBe('engine_exited_nonzero')
      expect(run.diagnostic).toContain('model not found')
    }
    expect(h.spawned).toHaveLength(1)
  })

  test('a helper that exits cleanly without a final has no final line', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.ready()
    helper.onRequest = () => helper.exit(0)

    const run = await session.transcribe(request())
    expect(run.status).toBe('failed')
    if (run.status === 'failed')
      expect(run.reason).toBe('parakeet_no_final_line')
  })

  test('noise lines are skipped, as the one-shot reader skips them', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.line('Compiling model...')
    helper.ready()
    helper.onRequest = (r) => {
      helper.line('not json either')
      helper.line({ kind: 'final', id: r.id, text: 'Hi.' })
    }

    const run = await session.transcribe(request())
    expect(run.status).toBe('final')
  })

  test('cancelling while the load runs kills the helper', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    const controller = new AbortController()

    const pending = session.transcribe(request({ signal: controller.signal }))
    await settle()
    controller.abort()
    const run = await pending

    expect(run.status).toBe('failed')
    if (run.status === 'failed') expect(run.reason).toBe('cancelled')
    expect(helper.signals).toEqual(['SIGTERM'])
    expect(helper.requests).toEqual([])
  })

  test('lowPriority lowers the running helper', async () => {
    const h = harness()
    const session = h.start()
    const helper = h.helpers[0]
    helper.ready()
    helper.onRequest = (r) => helper.line({ kind: 'final', id: r.id, text: '' })

    await session.transcribe(request({ lowPriority: true }))
    expect(h.lowered).toEqual([helper.pid])
  })

  test('a missing helper binary or missing weights spawn nothing', async () => {
    const noHelper = harness({
      resolveHelperBinary: () => {
        throw new Error('CodictateParakeetHelperDev not found')
      },
    })
    const noWeights = harness({ modelDirExists: () => false })
    for (const h of [noHelper, noWeights]) {
      const run = await h.start().transcribe(request())
      expect(run.status).toBe('failed')
      if (run.status === 'failed') {
        expect(run.reason).toBe('engine_runtime_missing')
      }
      expect(h.spawned).toEqual([])
    }
  })

  test('app quit kills every helper still running', async () => {
    const h = harness()
    h.start()
    h.start()
    h.helpers[1].ready()
    await settle()

    killParakeetSessions()
    expect(h.helpers.map((helper) => helper.signals)).toEqual([
      ['SIGTERM'],
      ['SIGTERM'],
    ])
  })
})

describe('spawnsParakeetSessionAtRecordStart', () => {
  const plan = (mode: 'batch' | 'live', engineId: string) =>
    ({ mode, engineId }) as RunnableDictationPlan

  test('only a Batch Dictation on Parakeet', () => {
    expect(
      spawnsParakeetSessionAtRecordStart(plan('batch', 'whisperkit'))
    ).toBe(true)
    expect(spawnsParakeetSessionAtRecordStart(plan('live', 'whisperkit'))).toBe(
      false
    )
    expect(
      spawnsParakeetSessionAtRecordStart(plan('batch', 'whisper_cpp'))
    ).toBe(false)
    expect(spawnsParakeetSessionAtRecordStart(plan('batch', 'hviske'))).toBe(
      false
    )
  })
})

describe('transcribeWithParakeet with a session', () => {
  test('asks the session instead of spawning, and times the transcript', async () => {
    const asked: ParakeetTranscriptionRequest[] = []
    const session: ParakeetSession = {
      transcribe: async (r) => {
        asked.push(r)
        return {
          status: 'final',
          final: {
            text: ' Hello there. ',
            timing: {
              unit: 'spoken-word',
              items: [
                { text: 'hello', start: 0.1, end: 0.4 },
                { text: 'there', start: 0.5, end: 0.9 },
              ],
            },
          },
        }
      },
      discard: () => {},
    }

    const result = await transcribeWithParakeet(request({ session }))

    expect(asked).toHaveLength(1)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rawTranscript).toBe('Hello there.')
      expect(result.timedTranscript?.text).toBe('Hello there.')
      expect(result.timedTranscript?.parts.length).toBeGreaterThan(0)
    }
  })

  test('passes a session failure through unchanged', async () => {
    const session: ParakeetSession = {
      transcribe: async () => ({
        status: 'failed',
        reason: 'engine_exited_nonzero',
        message: 'm',
      }),
      discard: () => {},
    }
    const result = await transcribeWithParakeet(request({ session }))
    expect(result).toEqual({
      status: 'failed',
      reason: 'engine_exited_nonzero',
      message: 'm',
    })
  })
})
