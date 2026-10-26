/**
 * The two decisions inside automatic Parakeet warmup that are worth pinning: whether a
 * selection has just made a preparation worth spawning, and whether prepared weights should
 * be loaded ahead of the first Dictation to absorb a Cold Start.
 *
 * The rest of the module is lifecycle glue - a promise handle, a settings push, a bounded
 * wait - and tests over glue only restate the glue. This function is the seam ADR-0005 cares
 * about, because it is the thing that used to be written out three times, slightly
 * differently, at boot, at a settings write and after a download.
 */

import { describe, expect, test } from 'bun:test'
import {
  shouldStartParakeetColdStartLoad,
  shouldStartParakeetWarmup,
  type ParakeetColdStartState,
  type ParakeetWarmupState,
} from './parakeet-warmup'

/** Parakeet selected, weights on disk, cold, nothing running: the case that should warm. */
function state(
  overrides: Partial<ParakeetWarmupState> = {}
): ParakeetWarmupState {
  return {
    selectedEngineId: 'whisperkit',
    weightsInstalled: true,
    helperSupported: true,
    alreadyPrepared: false,
    preparationInFlight: false,
    previousAttemptFailed: false,
    ...overrides,
  }
}

describe('shouldStartParakeetWarmup', () => {
  test('selecting Parakeet with its weights installed starts a preparation', () => {
    expect(shouldStartParakeetWarmup(state())).toBe(true)
  })

  test('a Whisper or hviske selection never warms Parakeet', () => {
    expect(
      shouldStartParakeetWarmup(state({ selectedEngineId: 'whisper_cpp' }))
    ).toBe(false)
    expect(
      shouldStartParakeetWarmup(state({ selectedEngineId: 'hviske' }))
    ).toBe(false)
  })

  test('a selection the catalog has never heard of never warms Parakeet', () => {
    expect(shouldStartParakeetWarmup(state({ selectedEngineId: null }))).toBe(
      false
    )
  })

  test('nothing is warmed where the Native Helper does not ship', () => {
    expect(shouldStartParakeetWarmup(state({ helperSupported: false }))).toBe(
      false
    )
  })

  test('weights that are not on disk cannot be prepared', () => {
    expect(shouldStartParakeetWarmup(state({ weightsInstalled: false }))).toBe(
      false
    )
  })

  test('an already prepared Parakeet is not prepared again', () => {
    expect(shouldStartParakeetWarmup(state({ alreadyPrepared: true }))).toBe(
      false
    )
  })

  /**
   * The concurrency rule. Boot, a settings write and a finished download can all want a
   * preparation within the same second, and two compiles of the same weights race each other.
   */
  test('a preparation already running is joined, not duplicated', () => {
    expect(
      shouldStartParakeetWarmup(state({ preparationInFlight: true }))
    ).toBe(false)
  })

  /**
   * Settings writes are frequent - every language, duration and toggle change is one - so a
   * broken helper must not be respawned by each of them.
   */
  test('a preparation that already failed is not retried in this process', () => {
    expect(
      shouldStartParakeetWarmup(state({ previousAttemptFailed: true }))
    ).toBe(false)
  })
})

/** Parakeet selected, prepared, weights on disk, nothing loaded yet: the case that should load. */
function coldState(
  overrides: Partial<ParakeetColdStartState> = {}
): ParakeetColdStartState {
  return {
    selectedEngineId: 'whisperkit',
    weightsInstalled: true,
    helperSupported: true,
    alreadyPrepared: true,
    preparationInFlight: false,
    loadedThisProcess: false,
    ...overrides,
  }
}

describe('shouldStartParakeetColdStartLoad', () => {
  test('a prepared Parakeet is loaded once at launch, before the first Dictation', () => {
    expect(shouldStartParakeetColdStartLoad(coldState())).toBe(true)
  })

  test('a second load in the same process buys nothing', () => {
    expect(
      shouldStartParakeetColdStartLoad(coldState({ loadedThisProcess: true }))
    ).toBe(false)
  })

  test('unprepared weights get a preparation, not a load', () => {
    expect(
      shouldStartParakeetColdStartLoad(coldState({ alreadyPrepared: false }))
    ).toBe(false)
  })

  test('a preparation still running loads the weights itself', () => {
    expect(
      shouldStartParakeetColdStartLoad(coldState({ preparationInFlight: true }))
    ).toBe(false)
  })

  test('only a selected, installed Parakeet on a platform with its helper is loaded', () => {
    expect(
      shouldStartParakeetColdStartLoad(
        coldState({ selectedEngineId: 'whisper_cpp' })
      )
    ).toBe(false)
    expect(
      shouldStartParakeetColdStartLoad(coldState({ selectedEngineId: null }))
    ).toBe(false)
    expect(
      shouldStartParakeetColdStartLoad(coldState({ weightsInstalled: false }))
    ).toBe(false)
    expect(
      shouldStartParakeetColdStartLoad(coldState({ helperSupported: false }))
    ).toBe(false)
  })
})
