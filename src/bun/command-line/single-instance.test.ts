import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireInstanceLock,
  claimSingleInstance,
  type InstanceClaimSteps,
  type ListenOutcome,
  type LockOutcome,
} from './single-instance'

interface Script {
  /** `null`: Windows, no lock. */
  lock?: LockOutcome['status'] | null
  prepareThrows?: boolean
  socketFile?: boolean
  listen?: ListenOutcome['status']
  /** One answer per ask; the last repeats. */
  answers?: boolean[]
}

function fakeSteps(script: Script) {
  const calls: string[] = []
  let clock = 0
  let asks = 0
  const answers = script.answers ?? [false]
  const lockStatus = script.lock === undefined ? 'acquired' : script.lock
  const steps: InstanceClaimSteps = {
    lock:
      lockStatus === null
        ? null
        : async () => {
            calls.push('lock')
            if (lockStatus === 'acquired') {
              return {
                status: 'acquired',
                release: () => calls.push('release'),
              }
            }
            if (lockStatus === 'held') return { status: 'held' }
            return { status: 'failed', error: new Error('no lock') }
          },
    prepare: () => {
      calls.push('prepare')
      if (script.prepareThrows) throw new Error('bad dir')
    },
    socketFileExists: () => script.socketFile ?? false,
    removeSocketFile: () => calls.push('remove'),
    listen: async () => {
      calls.push('listen')
      const status = script.listen ?? 'listening'
      return status === 'failed'
        ? { status, error: new Error('listen failed') }
        : { status }
    },
    askRunningApp: async () => {
      calls.push('ask')
      return answers[Math.min(asks++, answers.length - 1)]
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  return { steps, calls, elapsed: () => clock }
}

const timing = { waitForOwnerMs: 1_000, retryEveryMs: 250 }

describe('claimSingleInstance, Unix (lock file)', () => {
  test('lock taken, no socket file: listen and serve, keeping the lock', async () => {
    const { steps, calls } = fakeSteps({})
    const claim = await claimSingleInstance(steps, timing)
    expect(claim.status).toBe('serving')
    expect(calls).toEqual(['lock', 'prepare', 'listen'])
  })

  test('lock taken, stale socket nobody answers on: removed under the lock, then served', async () => {
    const { steps, calls } = fakeSteps({ socketFile: true })
    expect((await claimSingleInstance(steps, timing)).status).toBe('serving')
    expect(calls).toEqual(['lock', 'prepare', 'ask', 'remove', 'listen'])
  })

  test('lock taken, but a live socket (a build without the lock): quit, socket untouched', async () => {
    const { steps, calls } = fakeSteps({ socketFile: true, answers: [true] })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).toEqual(['lock', 'prepare', 'ask', 'release'])
  })

  test('lock held and the owner answers: quit after asking it to show', async () => {
    const { steps, calls } = fakeSteps({ lock: 'held', answers: [true] })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).toEqual(['lock', 'ask'])
  })

  test('lock held by an owner still starting: retried until it answers', async () => {
    const { steps, calls, elapsed } = fakeSteps({
      lock: 'held',
      answers: [false, false, true],
    })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).toEqual(['lock', 'ask', 'ask', 'ask'])
    expect(elapsed()).toBe(500)
  })

  test('lock held and the owner never answers: still quit, never listen or remove', async () => {
    const { steps, calls, elapsed } = fakeSteps({
      lock: 'held',
      socketFile: true,
    })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).not.toContain('listen')
    expect(calls).not.toContain('remove')
    expect(calls).not.toContain('prepare')
    expect(elapsed()).toBe(1_000)
  })

  test('lock taken but the address is in use anyway: quit', async () => {
    const { steps, calls } = fakeSteps({ listen: 'in-use' })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls[calls.length - 1]).toBe('release')
  })

  test('lock taken, listen fails for another reason: run without the command line, lock kept', async () => {
    const { steps, calls } = fakeSteps({ listen: 'failed' })
    const claim = await claimSingleInstance(steps, timing)
    expect(claim.status).toBe('unavailable')
    expect(calls).not.toContain('release')
  })

  test('lock taken, socket directory refused: run without the command line, lock kept', async () => {
    const { steps, calls } = fakeSteps({ prepareThrows: true })
    const claim = await claimSingleInstance(steps, timing)
    expect(claim.status).toBe('unavailable')
    expect(calls).toEqual(['lock', 'prepare'])
  })

  test('lock failed and a stale socket: never removed without the lock', async () => {
    const { steps, calls } = fakeSteps({ lock: 'failed', socketFile: true })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'unavailable'
    )
    expect(calls).not.toContain('remove')
    expect(calls).not.toContain('listen')
  })

  test('lock failed, no socket: serve on a fresh address; a taken one means quit', async () => {
    const free = fakeSteps({ lock: 'failed' })
    expect((await claimSingleInstance(free.steps, timing)).status).toBe(
      'serving'
    )
    const taken = fakeSteps({ lock: 'failed', listen: 'in-use' })
    expect((await claimSingleInstance(taken.steps, timing)).status).toBe(
      'another-instance'
    )
  })
})

describe('claimSingleInstance, Windows (the pipe name is the lock)', () => {
  test('nobody answers: listen and serve', async () => {
    const { steps, calls } = fakeSteps({ lock: null })
    expect((await claimSingleInstance(steps, timing)).status).toBe('serving')
    expect(calls).toEqual(['prepare', 'ask', 'listen'])
  })

  test('the running app answers: quit without listening', async () => {
    const { steps, calls } = fakeSteps({ lock: null, answers: [true] })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).toEqual(['prepare', 'ask'])
  })

  test('the name is taken by an instance still starting: wait for it, then quit', async () => {
    const { steps, calls } = fakeSteps({
      lock: null,
      listen: 'in-use',
      answers: [false, false, true],
    })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(calls).toEqual(['prepare', 'ask', 'listen', 'ask', 'ask'])
  })

  test('the name is taken and nobody ever answers: quit rather than run twice', async () => {
    const { steps, elapsed } = fakeSteps({ lock: null, listen: 'in-use' })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'another-instance'
    )
    expect(elapsed()).toBe(1_000)
  })

  test('listen fails for another reason: run without the command line', async () => {
    const { steps } = fakeSteps({ lock: null, listen: 'failed' })
    expect((await claimSingleInstance(steps, timing)).status).toBe(
      'unavailable'
    )
  })
})

describe.skipIf(process.platform === 'win32')('acquireInstanceLock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codictate-instance-lock-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('one holder at a time, released on close, and the file holds the pid', async () => {
    const path = join(dir, 'app.codictate.lock')
    const first = await acquireInstanceLock(path)
    expect(first.status).toBe('acquired')
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)

    // A second open file description is a second contender, even in this process.
    expect((await acquireInstanceLock(path)).status).toBe('held')

    if (first.status === 'acquired') first.release()
    const second = await acquireInstanceLock(path)
    expect(second.status).toBe('acquired')
    if (second.status === 'acquired') second.release()
  })

  test('a lock file left behind by a dead holder is simply taken', async () => {
    const path = join(dir, 'left-behind.lock')
    const crashed = await acquireInstanceLock(path)
    if (crashed.status === 'acquired') crashed.release()
    // The file is still there (never unlinked); nobody holds it.
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)
    const next = await acquireInstanceLock(path)
    expect(next.status).toBe('acquired')
    if (next.status === 'acquired') next.release()
  })

  test('an unusable path is a failure, not a held lock', async () => {
    const outcome = await acquireInstanceLock(join(dir, 'missing', 'x.lock'))
    expect(outcome.status).toBe('failed')
  })
})
