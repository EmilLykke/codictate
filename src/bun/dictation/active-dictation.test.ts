import { afterEach, describe, expect, test } from 'bun:test'
import {
  activeDictationStatus,
  claimDictation,
  currentDictation,
  releaseDictation,
  stopAnyDictation,
  type DictationClaim,
} from './active-dictation'

function fakeClaim(
  startedBy: DictationClaim['startedBy'],
  stops = true
): DictationClaim & { stopped: number } {
  const claim = {
    owner: Symbol('instance'),
    startedBy,
    stopped: 0,
    stop() {
      claim.stopped += 1
      return stops
    },
    cancel() {},
  }
  return claim
}

afterEach(() => {
  const claim = currentDictation()
  if (claim) releaseDictation(claim)
})

describe('active Dictation', () => {
  test('one at a time', () => {
    const first = fakeClaim('shortcut')
    const second = fakeClaim('command-line')
    expect(claimDictation(first)).toBe(true)
    expect(claimDictation(second)).toBe(false)
    expect(activeDictationStatus()).toEqual({
      active: true,
      startedBy: 'shortcut',
    })
  })

  test('a late release cannot clear a newer Dictation', () => {
    const old = fakeClaim('shortcut')
    claimDictation(old)
    releaseDictation(old)
    const newer = fakeClaim('command-line')
    claimDictation(newer)
    releaseDictation(old)
    expect(activeDictationStatus().startedBy).toBe('command-line')
  })

  test('stopAnyDictation stops whoever started it, and says when nothing was', () => {
    expect(stopAnyDictation()).toBe(false)
    const claim = fakeClaim('shortcut')
    claimDictation(claim)
    expect(stopAnyDictation()).toBe(true)
    expect(claim.stopped).toBe(1)
    releaseDictation(claim)
    expect(activeDictationStatus()).toEqual({ active: false, startedBy: null })
  })
})
