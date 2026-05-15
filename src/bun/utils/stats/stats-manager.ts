import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import type {
  HistoryEntry,
  StatsRange,
  StatsSessionEntry,
  StatsSummary,
} from '../../../shared/types'

const STATS_FILENAME = 'stats.json'

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function toLocalDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface StatsIndex {
  entries: StatsSessionEntry[]
}

export class StatsManager {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private getStoragePath: () => string) {}

  private get statsPath(): string {
    return join(this.getStoragePath(), STATS_FILENAME)
  }

  private ensureDir(): void {
    mkdirSync(this.getStoragePath(), { recursive: true })
  }

  private async readIndex(): Promise<StatsIndex> {
    try {
      const file = Bun.file(this.statsPath)
      if (!(await file.exists())) return { entries: [] }
      return (await file.json()) as StatsIndex
    } catch {
      return { entries: [] }
    }
  }

  private async writeIndex(index: StatsIndex): Promise<void> {
    this.ensureDir()
    await Bun.write(this.statsPath, JSON.stringify(index, null, 2))
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn, fn)
    this.writeQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  async saveSession(entry: StatsSessionEntry): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.readIndex()
      index.entries.push(entry)
      await this.writeIndex(index)
      log('stats', 'saved session', {
        outputWords: entry.outputWordCount,
        durationMs: entry.durationMs,
      })
    })
  }

  private rangeToMs(range: StatsRange): { start: number; prevStart: number } {
    const now = new Date()
    now.setHours(23, 59, 59, 999)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    switch (range) {
      case 'today': {
        const start = today.getTime()
        const prev = new Date(today)
        prev.setDate(prev.getDate() - 1)
        return { start, prevStart: prev.getTime() }
      }
      case '7d': {
        const start = new Date(today)
        start.setDate(start.getDate() - 6)
        const prev = new Date(start)
        prev.setDate(prev.getDate() - 7)
        return { start: start.getTime(), prevStart: prev.getTime() }
      }
      case '30d': {
        const start = new Date(today)
        start.setDate(start.getDate() - 29)
        const prev = new Date(start)
        prev.setDate(prev.getDate() - 30)
        return { start: start.getTime(), prevStart: prev.getTime() }
      }
      case '3m': {
        const start = new Date(today)
        start.setMonth(start.getMonth() - 3)
        const prev = new Date(start)
        prev.setMonth(prev.getMonth() - 3)
        return { start: start.getTime(), prevStart: prev.getTime() }
      }
      case 'all': {
        return { start: 0, prevStart: 0 }
      }
    }
  }

  async getSummary(range: StatsRange = 'all'): Promise<StatsSummary> {
    const index = await this.readIndex()
    const allEntries = index.entries

    const empty: StatsSummary = {
      totalOutputWords: 0,
      averageRawWpm: 0,
      totalSessions: 0,
      trendCurrentWords: 0,
      trendPreviousWords: 0,
      formattingUsagePercent: 0,
      dailyActivity: {},
      currentStreakDays: 0,
      longestStreakDays: 0,
    }

    if (allEntries.length === 0) return empty

    const { start, prevStart } = this.rangeToMs(range)
    const filtered = allEntries.filter((e) => e.timestamp >= start)

    let prevFiltered: StatsSessionEntry[]
    if (range === 'all') {
      const now = new Date()
      const thisMonthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      ).getTime()
      const lastMonthStart = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        1
      ).getTime()
      prevFiltered = allEntries.filter(
        (e) => e.timestamp >= lastMonthStart && e.timestamp < thisMonthStart
      )
    } else {
      prevFiltered = allEntries.filter(
        (e) => e.timestamp >= prevStart && e.timestamp < start
      )
    }

    let totalOutputWords = 0
    let wpmSum = 0
    let wpmCount = 0
    let formattingUsedCount = 0
    let formattingKnownCount = 0

    for (const e of filtered) {
      totalOutputWords += e.outputWordCount

      if (e.rawWordCount !== null && e.rawWordCount > 0 && e.durationMs > 0) {
        wpmSum += (e.rawWordCount / e.durationMs) * 60_000
        wpmCount++
      }

      if (e.formattingUsed !== null) {
        formattingKnownCount++
        if (e.formattingUsed) formattingUsedCount++
      }
    }

    const heatmapStart = range === 'today' ? this.rangeToMs('7d').start : start
    const heatmapEntries = allEntries.filter((e) => e.timestamp >= heatmapStart)
    const dailyActivity: Record<string, number> = {}
    for (const e of heatmapEntries) {
      const dayKey = toLocalDateKey(e.timestamp)
      dailyActivity[dayKey] = (dailyActivity[dayKey] ?? 0) + e.outputWordCount
    }

    let trendPreviousWords = 0
    for (const e of prevFiltered) {
      trendPreviousWords += e.outputWordCount
    }

    let trendCurrentWords = totalOutputWords
    if (range === 'all') {
      const now = new Date()
      const thisMonthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      ).getTime()
      trendCurrentWords = 0
      for (const e of filtered) {
        if (e.timestamp >= thisMonthStart)
          trendCurrentWords += e.outputWordCount
      }
    }

    const averageRawWpm = wpmCount > 0 ? Math.round(wpmSum / wpmCount) : 0
    const allActiveDays = this.getActiveDays(allEntries)
    const currentStreakDays = this.computeCurrentStreak(allActiveDays)
    const longestStreakDays = this.computeLongestStreak(allActiveDays)
    const formattingUsagePercent =
      formattingKnownCount > 0
        ? Math.round((formattingUsedCount / formattingKnownCount) * 100)
        : 0

    return {
      totalOutputWords,
      averageRawWpm,
      totalSessions: filtered.length,
      trendCurrentWords,
      trendPreviousWords,
      formattingUsagePercent,
      dailyActivity,
      currentStreakDays,
      longestStreakDays,
    }
  }

  private getActiveDays(entries: StatsSessionEntry[]): Set<string> {
    const days = new Set<string>()
    for (const e of entries) {
      days.add(toLocalDateKey(e.timestamp))
    }
    return days
  }

  private computeCurrentStreak(activeDays: Set<string>): number {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todayKey = toLocalDateKey(today.getTime())
    if (!activeDays.has(todayKey)) return 0

    let streak = 1
    const cursor = new Date(today)
    for (;;) {
      cursor.setDate(cursor.getDate() - 1)
      if (!activeDays.has(toLocalDateKey(cursor.getTime()))) break
      streak++
    }
    return streak
  }

  private computeLongestStreak(activeDays: Set<string>): number {
    if (activeDays.size === 0) return 0
    const sorted = [...activeDays].sort()
    let longest = 1
    let current = 1
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1])
      const curr = new Date(sorted[i])
      const diffMs = curr.getTime() - prev.getTime()
      if (diffMs <= 86_400_000 + 1000) {
        current++
        if (current > longest) longest = current
      } else {
        current = 1
      }
    }
    return longest
  }

  async backfillFromHistory(historyEntries: HistoryEntry[]): Promise<number> {
    return this.enqueue(async () => {
      const index = await this.readIndex()
      let added = 0

      for (const h of historyEntries) {
        const outputWordCount = countWords(h.transcript)
        if (outputWordCount === 0) continue

        index.entries.push({
          timestamp: h.timestamp,
          rawWordCount: null,
          outputWordCount,
          durationMs: h.durationMs ?? 0,
          engineId: null,
          formattingUsed: null,
          languageId: null,
        })
        added++
      }

      if (added > 0) {
        index.entries.sort((a, b) => a.timestamp - b.timestamp)
        await this.writeIndex(index)
        log('stats', 'backfilled from history', { added })
      }

      return added
    })
  }
}
