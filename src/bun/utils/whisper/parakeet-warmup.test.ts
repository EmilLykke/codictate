/**
 * The two parts of the background Parakeet load that are worth pinning: whether a settle calls
 * for a load, and when the in-flight load starts and stops counting as a Parakeet Preparation.
 *
 * The rest of the module is lifecycle glue - reading the selection, spawning the helper, a
 * bounded wait - and tests over glue only restate the glue. The predicate is the seam ADR-0005
 * cares about, because it is the thing that used to be written out three times, slightly
 * differently, at boot, at a settings write and after a download. The tracker runs a fake load,
 * so nothing here spawns a helper.
 */

import { describe, expect, test } from 'bun:test'
import {
  createParakeetLoadTracker,
  shouldStartParakeetLoad,
  type ParakeetLoadState,
} from './parakeet-warmup'

/** Parakeet just became the selection, weights on disk, nothing running: the case that loads. */
function state(overrides: Partial<ParakeetLoadState> = {}): ParakeetLoadState {
  return {
    selectedEngineId: 'whisperkit',
    weightsInstalled: true,
    helperSupported: true,
    alreadyLoadable: false,
    loadInFlight: false,
    ...overrides,
  }
}

describe('shouldStartParakeetLoad', () => {
  test('launch, selecting Parakeet or finishing its download starts a load', () => {
    expect(shouldStartParakeetLoad(state())).toBe(true)
  })

  test('a Whisper or hviske selection never loads Parakeet', () => {
    expect(
      shouldStartParakeetLoad(state({ selectedEngineId: 'whisper_cpp' }))
    ).toBe(false)
    expect(shouldStartParakeetLoad(state({ selectedEngineId: 'hviske' }))).toBe(
      false
    )
  })

  test('a selection the catalog has never heard of never loads Parakeet', () => {
    expect(shouldStartParakeetLoad(state({ selectedEngineId: null }))).toBe(
      false
    )
  })

  test('nothing is loaded where the Native Helper does not ship', () => {
    expect(shouldStartParakeetLoad(state({ helperSupported: false }))).toBe(
      false
    )
  })

  test('weights that are not on disk cannot be loaded', () => {
    expect(shouldStartParakeetLoad(state({ weightsInstalled: false }))).toBe(
      false
    )
  })

  /**
   * Settings writes are frequent - every language, duration and toggle change is one - so a
   * settle that changes nothing about Parakeet must not respawn the helper, broken or not.
   */
  test('a settle that leaves Parakeet selected and installed loads nothing', () => {
    expect(shouldStartParakeetLoad(state({ alreadyLoadable: true }))).toBe(
      false
    )
  })

  /**
   * The concurrency rule. Boot, a settings write and a finished download can all want a load
   * within the same second, and two Preparations of the same weights race each other.
   */
  test('a load already running is joined, not duplicated', () => {
    expect(shouldStartParakeetLoad(state({ loadInFlight: true }))).toBe(false)
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createParakeetLoadTracker', () => {
  const PREPARING_AFTER_MS = 20

  function tracker() {
    let pushes = 0
    const loads = createParakeetLoadTracker({
      preparingAfterMs: PREPARING_AFTER_MS,
      onPreparingChanged: () => {
        pushes += 1
      },
    })
    return { loads, pushes: () => pushes }
  }

  /** The common case: prepared weights load in about 0.15 s, and Settings never mentions it. */
  test('a load that ends inside the threshold never says preparing and pushes nothing', async () => {
    const { loads, pushes } = tracker()
    const load = deferred()
    expect(loads.start(() => load.promise)).toBe(true)
    expect(loads.inFlight).not.toBeNull()
    expect(loads.preparing).toBe(false)
    load.resolve()
    await loads.inFlight
    await sleep(PREPARING_AFTER_MS * 2)
    expect(loads.inFlight).toBeNull()
    expect(loads.preparing).toBe(false)
    expect(pushes()).toBe(0)
  })

  test('a load past the threshold says preparing, and stops saying it when it ends', async () => {
    const { loads, pushes } = tracker()
    const load = deferred()
    loads.start(() => load.promise)
    await sleep(PREPARING_AFTER_MS * 2)
    expect(loads.preparing).toBe(true)
    expect(pushes()).toBe(1)

    const pending = loads.inFlight
    load.resolve()
    await pending
    expect(loads.preparing).toBe(false)
    expect(loads.inFlight).toBeNull()
    expect(pushes()).toBe(2)
  })

  test('a second load is refused while one is running', async () => {
    const { loads } = tracker()
    const load = deferred()
    loads.start(() => load.promise)
    const first = loads.inFlight
    let secondRan = false
    expect(
      loads.start(async () => {
        secondRan = true
      })
    ).toBe(false)
    expect(loads.inFlight).toBe(first)
    load.resolve()
    await first
    expect(secondRan).toBe(false)
  })

  /** A Dictation awaits the in-flight promise, so a failed load must still let it through. */
  test('a failed load resolves the in-flight promise and clears preparing', async () => {
    const { loads, pushes } = tracker()
    const load = deferred()
    loads.start(() => load.promise)
    await sleep(PREPARING_AFTER_MS * 2)
    const pending = loads.inFlight
    load.reject(new Error('helper exited'))
    await expect(pending).resolves.toBeUndefined()
    expect(loads.preparing).toBe(false)
    expect(loads.inFlight).toBeNull()
    expect(pushes()).toBe(2)
  })

  test('a new load can start once the previous one has ended', async () => {
    const { loads } = tracker()
    const first = deferred()
    loads.start(() => first.promise)
    const pending = loads.inFlight
    first.resolve()
    await pending
    expect(loads.start(() => Promise.resolve())).toBe(true)
  })
})
