import { describe, expect, it } from 'bun:test'
import {
  engineProcessTimeoutMs,
  superviseProcess,
  type ProcessSupervisorClock,
} from './process-supervisor'

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

  advanceBy(delayMs: number): void {
    const target = this.now + delayMs
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.now = due[1].at
      this.tasks.delete(due[0])
      due[1].callback()
    }
    this.now = target
  }

  get pending(): number {
    return this.tasks.size
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const bytes = (text: string) => new TextEncoder().encode(text)

function closedStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes(text))
      controller.close()
    },
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('superviseProcess', () => {
  it('returns completed output and clears the deadline when the process exits first', async () => {
    const clock = new ManualClock()
    const exit = deferred<number>()
    const signals: (number | NodeJS.Signals | undefined)[] = []
    const pending = superviseProcess(
      { exited: exit.promise, kill: (signal) => signals.push(signal) },
      {
        stdout: closedStream('transcript'),
        stderr: closedStream('log'),
        timeoutMs: 100,
        cleanupGraceMs: 10,
        clock,
      }
    )

    exit.resolve(0)
    const result = await pending

    expect(result.status).toBe('exited')
    if (result.status !== 'exited') return
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('transcript')
    expect(result.outputComplete).toBe(true)
    expect(signals).toEqual([])
    expect(clock.pending).toBe(0)
  })

  it('sends SIGTERM at the deadline and reports a timeout even when kill exits', async () => {
    const clock = new ManualClock()
    const exit = deferred<number>()
    const signals: (number | NodeJS.Signals | undefined)[] = []
    const pending = superviseProcess(
      {
        exited: exit.promise,
        kill: (signal) => {
          signals.push(signal)
          exit.resolve(143)
        },
      },
      { timeoutMs: 100, cleanupGraceMs: 10, clock }
    )

    clock.advanceBy(100)
    const result = await pending

    expect(result.status).toBe('timed_out')
    expect(signals).toEqual(['SIGTERM'])
    expect(clock.pending).toBe(0)
  })

  it('returns after the grace period and escalates when kill never settles exited', async () => {
    const clock = new ManualClock()
    const exit = deferred<number>()
    const signals: (number | NodeJS.Signals | undefined)[] = []
    let settled = false
    const pending = superviseProcess(
      { exited: exit.promise, kill: (signal) => signals.push(signal) },
      { timeoutMs: 100, cleanupGraceMs: 10, clock }
    ).then((result) => {
      settled = true
      return result
    })

    clock.advanceBy(100)
    await flush()
    expect(settled).toBe(false)
    clock.advanceBy(10)
    const result = await pending

    expect(result.status).toBe('timed_out')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(clock.pending).toBe(0)
  })

  it('aborts a blocked drain without awaiting a cancellation that never settles', async () => {
    const clock = new ManualClock()
    const exit = deferred<number>()
    let cancelCalls = 0
    const blockedStream = () =>
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => {
          cancelCalls++
          return new Promise<void>(() => {})
        },
      })
    const pending = superviseProcess(
      {
        exited: exit.promise,
        kill: () => exit.resolve(143),
      },
      {
        stdout: blockedStream(),
        stderr: blockedStream(),
        timeoutMs: 100,
        cleanupGraceMs: 10,
        clock,
      }
    )

    clock.advanceBy(100)
    const result = await pending

    expect(result.status).toBe('timed_out')
    expect(cancelCalls).toBe(2)
  })
})

describe('engineProcessTimeoutMs', () => {
  it('uses the three-minute floor for short or unknown audio', () => {
    expect(engineProcessTimeoutMs()).toBe(180_000)
    expect(engineProcessTimeoutMs(10_000)).toBe(180_000)
  })

  it('allows three times the audio plus startup for a supported 30-minute capture', () => {
    expect(engineProcessTimeoutMs(30 * 60_000)).toBe(91 * 60_000)
  })
})
