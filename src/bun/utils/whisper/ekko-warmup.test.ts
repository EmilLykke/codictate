/**
 * ekko's background load: when a settle of the settings and availability starts one, that a
 * failure is logged and the next trigger tries again, and that a Dictation waits for a load in
 * flight, bounded. The load is a fake, so nothing here spawns `parakeet-cli`.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildDictationPlan,
  type DictationAvailability,
  type DictationPlan,
} from '../../../shared/dictation-plan'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
} from '../../../shared/speech-models'
import { createEkkoWarmup } from './ekko-warmup'

const EKKO = 'ekko-v1-tiny-q5_0'
const HVISKE = 'hviske-v5-tiny-q5_0'
const PARAKEET = DEFAULT_STREAM_CAPABLE_MODEL_ID

/** The Dictation's selection and what is on disk, changed between settles by a test. */
function world(speechModelId: string, installed = true) {
  const state = { speechModelId, installed }
  const plan = (): DictationPlan => {
    const availability: DictationAvailability = {
      isModelAvailable: (id) => id !== EKKO || state.installed,
      streamSupported: true,
      punctuationModelInstalled: true,
    }
    return buildDictationPlan(
      {
        speechModelId: state.speechModelId,
        transcriptionLanguageId: 'auto',
        translateDefaultLanguageId: 'auto',
        translateToEnglish: false,
        streamMode: false,
        addPunctuation: false,
      },
      availability
    )
  }
  return { state, plan }
}

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A warm-up whose loads are recorded and settled by the test. */
function harness(speechModelId: string, installed = true) {
  const { state, plan } = world(speechModelId, installed)
  const loads: { speechModelId: string; run: ReturnType<typeof deferred> }[] =
    []
  const logged: { message: string; data?: Record<string, unknown> }[] = []
  const warmup = createEkkoWarmup({
    dictationPlan: plan,
    load: (target) => {
      const run = deferred()
      loads.push({ speechModelId: target.speechModelId, run })
      return run.promise
    },
    log: (_scope, message, data) => {
      logged.push({ message, data })
    },
  })
  /** Let the in-flight load settle and its bookkeeping run. */
  const settled = async () => {
    await warmup.inFlight
  }
  return { state, warmup, loads, logged, settled }
}

describe('the ekko warm-up trigger table', () => {
  test('launch with ekko selected and installed starts one load', () => {
    const { warmup, loads } = harness(EKKO)
    warmup.ensureWarm()
    expect(loads.map((l) => l.speechModelId)).toEqual([EKKO])
  })

  test('ekko becoming the Dictation selection starts a load', async () => {
    const { state, warmup, loads } = harness(DEFAULT_MODEL_ID)
    warmup.ensureWarm()
    expect(loads).toHaveLength(0)
    state.speechModelId = EKKO
    warmup.ensureWarm()
    expect(loads).toHaveLength(1)
  })

  test('ekko download finishing starts a load', () => {
    const { state, warmup, loads } = harness(EKKO, false)
    warmup.ensureWarm()
    expect(loads).toHaveLength(0)
    state.installed = true
    warmup.ensureWarm()
    expect(loads).toHaveLength(1)
  })

  test('a settle that leaves ekko selected and installed starts nothing more', async () => {
    const { warmup, loads, settled } = harness(EKKO)
    warmup.ensureWarm()
    loads[0].run.resolve()
    await settled()
    warmup.ensureWarm()
    warmup.ensureWarm()
    expect(loads).toHaveLength(1)
  })

  test('a load already running is joined, not duplicated', () => {
    const { state, warmup, loads } = harness(EKKO)
    warmup.ensureWarm()
    // Selected away and back while the first load still runs.
    state.speechModelId = HVISKE
    warmup.ensureWarm()
    state.speechModelId = EKKO
    warmup.ensureWarm()
    expect(loads).toHaveLength(1)
  })

  test('Whisper, hviske and Parakeet selections never load ekko', () => {
    for (const id of [DEFAULT_MODEL_ID, HVISKE, PARAKEET]) {
      const { warmup, loads } = harness(id)
      warmup.ensureWarm()
      expect(loads).toHaveLength(0)
    }
  })

  test('ekko selected but not available loads nothing', () => {
    const { warmup, loads } = harness(EKKO, false)
    warmup.ensureWarm()
    expect(loads).toHaveLength(0)
  })
})

describe('a failed ekko warm-up', () => {
  test('is logged, and the next trigger tries again', async () => {
    const { state, warmup, loads, logged, settled } = harness(EKKO)
    warmup.ensureWarm()
    loads[0].run.reject(new Error('parakeet-cli exited 1'))
    await settled()
    expect(warmup.inFlight).toBeNull()
    expect(logged).toContainEqual({
      message: 'warm-up failed',
      data: expect.objectContaining({
        speechModelId: EKKO,
        err: 'parakeet-cli exited 1',
      }),
    })

    // A plain settings settle is not a trigger, so a broken parakeet-cli is not respawned on each.
    warmup.ensureWarm()
    expect(loads).toHaveLength(1)

    // Selecting ekko again is.
    state.speechModelId = HVISKE
    warmup.ensureWarm()
    state.speechModelId = EKKO
    warmup.ensureWarm()
    expect(loads).toHaveLength(2)
  })

  test('a plan that throws is logged and starts nothing', () => {
    const logged: string[] = []
    const warmup = createEkkoWarmup({
      dictationPlan: () => {
        throw new Error('broken catalog')
      },
      load: () => Promise.resolve(),
      log: (_scope, message) => {
        logged.push(message)
      },
    })
    expect(() => warmup.ensureWarm()).not.toThrow()
    expect(warmup.inFlight).toBeNull()
    expect(logged).toEqual(['could not tell whether to warm up'])
  })
})

describe('a Dictation during an ekko warm-up', () => {
  test('does not wait when nothing is loading', async () => {
    const { warmup } = harness(DEFAULT_MODEL_ID)
    warmup.ensureWarm()
    expect(warmup.inFlight).toBeNull()
    await expect(warmup.whenLoaded(10_000)).resolves.toBeUndefined()
  })

  test('waits for the load in flight to end', async () => {
    const { warmup, loads } = harness(EKKO)
    warmup.ensureWarm()
    let done = false
    const waiting = warmup.whenLoaded(10_000).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    loads[0].run.resolve()
    await waiting
    expect(done).toBe(true)
  })

  test('a failed load still lets it through', async () => {
    const { warmup, loads } = harness(EKKO)
    warmup.ensureWarm()
    const waiting = warmup.whenLoaded(10_000)
    loads[0].run.reject(new Error('timed out'))
    await expect(waiting).resolves.toBeUndefined()
  })

  test('stops waiting at the bound when the load hangs', async () => {
    const { warmup, logged } = harness(EKKO)
    warmup.ensureWarm()
    await warmup.whenLoaded(5)
    expect(warmup.inFlight).not.toBeNull()
    expect(logged.map((l) => l.message)).toContain(
      'stopped waiting for the warm-up'
    )
  })
})
