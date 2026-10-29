import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryEntry, StatsSessionEntry } from '../../../shared/types'
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
    punctuationRestored: false,
    languageId: 'en',
    ...overrides,
  }
}

function managerAt(
  year: number,
  month: number,
  day: number,
  storage = mkdtempSync(join(tmpdir(), 'codictate-stats-'))
): StatsManager {
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

describe('StatsManager sessions: Punctuation Restoration', () => {
  test('records whether Punctuation Restoration ran', async () => {
    const manager = managerAt(2026, 10, 29)
    await manager.saveSession(
      session(localTimestamp(2026, 10, 29), 5, { punctuationRestored: true })
    )
    await manager.saveSession(
      session(localTimestamp(2026, 10, 29, 13), 6, {
        punctuationRestored: false,
      })
    )

    const sessions = await manager.getSessions()

    expect(sessions.map((s) => s.punctuationRestored)).toEqual([true, false])
  })

  /** Rows written before Punctuation Restoration existed have no such key. */
  test('reads an older row as unknown, like formattingUsed', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'codictate-stats-'))
    writeFileSync(
      join(storage, 'stats.json'),
      JSON.stringify({
        entries: [
          {
            timestamp: localTimestamp(2026, 9, 1),
            rawWordCount: 4,
            outputWordCount: 4,
            durationMs: 2000,
            engineId: 'hviske-v5-tiny-q5_0',
            formattingUsed: false,
            languageId: 'da',
          },
        ],
      })
    )
    const manager = managerAt(2026, 10, 29, storage)

    const [old] = await manager.getSessions()

    expect(old.punctuationRestored).toBeNull()
    expect(old.formattingUsed).toBe(false)
  })

  test('a row backfilled from History is unknown too', async () => {
    const manager = managerAt(2026, 10, 29)
    await manager.backfillFromHistory([
      {
        id: 'h1',
        timestamp: localTimestamp(2026, 10, 1),
        transcript: 'hej med dig',
        audioFilename: '',
        source: 'dictation',
      } satisfies HistoryEntry,
    ])

    const [backfilled] = await manager.getSessions()

    expect(backfilled.punctuationRestored).toBeNull()
  })
})
