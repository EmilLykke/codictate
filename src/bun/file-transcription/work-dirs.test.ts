import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkDir,
  isWorkDirName,
  removeStaleWorkDirs,
  STALE_WORK_DIR_MS,
} from './work-dirs'

let parent = ''
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const OLD = (NOW - STALE_WORK_DIR_MS - 60_000) / 1000
const FRESH = (NOW - 60_000) / 1000

function touch(path: string, seconds: number) {
  utimesSync(path, seconds, seconds)
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'codictate-work-dirs-test-'))
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('isWorkDirName', () => {
  test('only the exact mkdtemp shape', () => {
    expect(isWorkDirName('codictate-file-transcription-a1B2c3')).toBe(true)
    expect(isWorkDirName('codictate-file-transcription-e2e-a1B2c3')).toBe(false)
    expect(isWorkDirName('codictate-file-transcription-')).toBe(false)
    expect(isWorkDirName('other-a1B2c3')).toBe(false)
  })
})

describe('removeStaleWorkDirs', () => {
  test('removes old job dirs, keeps fresh ones and anything that is not a job dir', () => {
    const stale = createWorkDir(parent)
    writeFileSync(join(stale, 'audio.wav'), 'x')
    touch(join(stale, 'audio.wav'), OLD)
    touch(stale, OLD)

    const fresh = createWorkDir(parent)
    touch(fresh, FRESH)

    // Old dir, but a file inside was written recently: a job may still own it.
    const busy = createWorkDir(parent)
    writeFileSync(join(busy, 'audio.wav'), 'x')
    touch(join(busy, 'audio.wav'), FRESH)
    touch(busy, OLD)

    const lookalikeFile = join(parent, 'codictate-file-transcription-zzzzzz')
    writeFileSync(lookalikeFile, 'x')
    touch(lookalikeFile, OLD)

    const other = join(parent, 'codictate-file-transcription-e2e-abcdef')
    mkdirSync(other)
    touch(other, OLD)

    const target = join(parent, 'target')
    mkdirSync(target)
    const link = join(parent, 'codictate-file-transcription-linkkk')
    symlinkSync(target, link)

    expect(removeStaleWorkDirs(parent, { now: NOW })).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    for (const kept of [fresh, busy, lookalikeFile, other, link, target]) {
      expect(existsSync(kept)).toBe(true)
    }
  })

  test('a missing parent is nothing to do', () => {
    expect(removeStaleWorkDirs(join(parent, 'nope'), { now: NOW })).toEqual([])
  })
})
