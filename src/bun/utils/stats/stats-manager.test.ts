import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatsSessionEntry } from '../../../shared/types'
import { StatsManager } from './stats-manager'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour = 12
): number {
  return new Date(year, month - 1, day, hour).getTime()
}

function session(
  timestamp: number,
  outputWordCount: number,
  overrides: Partial<StatsSessionEntry> = {}
): StatsSessionEntry {
  return {
    timestamp,
    rawWordCount: outputWordCount,
    outputWordCount,
    durationMs: 60_000,
    engineId: 'whisper_cpp',
    formattingUsed: false,
    languageId: 'en',
    ...overrides,
  }
}

function managerAt(year: number, month: number, day: number): StatsManager {
  const storage = mkdtempSync(join(tmpdir(), 'codictate-stats-'))
  tempDirs.push(storage)
  return new StatsManager(
    () => storage,
    () => localTimestamp(year, month, day)
  )
}

describe('StatsManager calendar summaries', () => {
  test('clamps a three-month window at a shorter month boundary', async () => {
    const manager = managerAt(2025, 5, 31)
    await manager.saveSession(session(localTimestamp(2025, 2, 27), 10))
    await manager.saveSession(session(localTimestamp(2025, 2, 28), 20))
    await manager.saveSession(session(localTimestamp(2025, 5, 31), 30))

    const summary = await manager.getSummary('3m')

    expect(summary.totalSessions).toBe(2)
    expect(summary.totalOutputWords).toBe(50)
    expect(summary.trendPreviousWords).toBe(10)
  })

  test('compares this month with the previous month across a year boundary', async () => {
    const manager = managerAt(2026, 1, 15)
    await manager.saveSession(session(localTimestamp(2025, 12, 31), 12))
    await manager.saveSession(session(localTimestamp(2026, 1, 1), 7))
    await manager.saveSession(session(localTimestamp(2026, 1, 15), 8))

    const summary = await manager.getSummary('all')

    expect(summary.trendCurrentWords).toBe(15)
    expect(summary.trendPreviousWords).toBe(12)
  })

  test('counts streaks by local calendar day across a month boundary', async () => {
    const manager = managerAt(2025, 3, 2)
    for (const [timestamp, words] of [
      [localTimestamp(2025, 2, 27), 1],
      [localTimestamp(2025, 2, 28), 2],
      [localTimestamp(2025, 3, 1), 3],
      [localTimestamp(2025, 3, 2), 4],
      [localTimestamp(2025, 2, 20), 5],
    ]) {
      await manager.saveSession(session(timestamp, words))
    }

    const summary = await manager.getSummary('all')

    expect(summary.currentStreakDays).toBe(4)
    expect(summary.longestStreakDays).toBe(4)
    expect(summary.dailyActivity['2025-03-02']).toBe(4)
  })
})
