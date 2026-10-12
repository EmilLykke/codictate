import { mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { log } from '../logger'
import type { HistoryEntry } from '../../../shared/types'
import { estimateWavDurationMsFromBytes } from '../../../shared/wav-duration'

const INDEX_FILENAME = 'history.json'
const RECORDINGS_DIR = 'recordings'

function isSubsequence(needle: string, haystack: string): boolean {
  let j = 0
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++
  }
  return j === needle.length
}

function generateId(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const suffix = Math.random().toString(16).slice(2, 6)
  return `${date}_${time}_${suffix}`
}

interface HistoryIndex {
  entries: HistoryEntry[]
}

/**
 * `history.json` as it is on disk. Entries stay exactly as read, unknown fields and all, so a
 * rewrite (a save, a delete, a trim) never loses what an older or newer Codictate wrote, and
 * an entry this version cannot show is kept rather than dropped with its audio orphaned.
 * Only `HistoryEntry` views are normalized (`normalizeHistoryEntry`).
 */
export interface StoredHistoryIndex {
  /** Every top-level field but `entries`, written back unchanged. */
  rest: Record<string, unknown>
  entries: unknown[]
}

/** The stored index, or `null` when the value is not one (so it must not be overwritten). */
export function parseStoredHistoryIndex(
  raw: unknown
): StoredHistoryIndex | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { entries, ...rest } = raw as Record<string, unknown>
  if (entries === undefined) return { rest, entries: [] }
  if (!Array.isArray(entries)) return null
  return { rest, entries: [...entries] }
}

export function serializeStoredHistoryIndex(index: StoredHistoryIndex): string {
  return JSON.stringify({ ...index.rest, entries: index.entries }, null, 2)
}

function storedId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const id = (raw as Record<string, unknown>).id
  return typeof id === 'string' ? id : null
}

/**
 * The recording a stored entry owns, as a bare file name inside `recordings/`, or `null`.
 * Read from the raw entry so an entry that is otherwise unreadable still has its audio
 * removed with it. Anything with a path separator is not ours to delete.
 */
export function storedAudioFilename(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const name = (raw as Record<string, unknown>).audioFilename
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..'
  ) {
    return null
  }
  return basename(name) === name && !name.includes('\\') ? name : null
}

/**
 * One entry from `history.json`, as the app reads it today. Entries written before File
 * Transcription have no `source` and are Dictations. Anything that is not an object with an
 * id and a transcript is not shown rather than shown half-broken; it stays in
 * `history.json` all the same (`StoredHistoryIndex`).
 */
export function normalizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.transcript !== 'string') {
    return null
  }
  const source = value.source === 'file' ? 'file' : 'dictation'
  const entry: HistoryEntry = {
    id: value.id,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : 0,
    transcript: value.transcript,
    audioFilename:
      typeof value.audioFilename === 'string' ? value.audioFilename : '',
    source,
  }
  if (typeof value.durationMs === 'number') entry.durationMs = value.durationMs
  if (source === 'file' && typeof value.fileName === 'string') {
    entry.fileName = value.fileName
  }
  return entry
}

export function normalizeHistoryIndex(raw: unknown): HistoryIndex {
  const entries =
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : []
  return {
    entries: entries
      .map(normalizeHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null),
  }
}

/** What search matches: the transcript, and a File Transcription's file name. */
function searchableText(entry: HistoryEntry): string {
  return (
    entry.fileName ? `${entry.transcript}\n${entry.fileName}` : entry.transcript
  ).toLowerCase()
}

export class HistoryManager {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private getStoragePath: () => string) {}

  private get indexPath(): string {
    return join(this.getStoragePath(), INDEX_FILENAME)
  }

  private get recordingsDir(): string {
    return join(this.getStoragePath(), RECORDINGS_DIR)
  }

  ensureStorageDir(): void {
    mkdirSync(this.recordingsDir, { recursive: true })
  }

  private async readIndex(): Promise<HistoryIndex> {
    const stored = await this.readStored()
    return normalizeHistoryIndex({ entries: stored?.entries ?? [] })
  }

  /** `null` when `history.json` exists but cannot be read as an index. */
  private async readStored(): Promise<StoredHistoryIndex | null> {
    const file = Bun.file(this.indexPath)
    if (!(await file.exists())) return { rest: {}, entries: [] }
    try {
      return parseStoredHistoryIndex(await file.json())
    } catch {
      return null
    }
  }

  /**
   * The stored index for a rewrite. A `history.json` that cannot be read is moved aside
   * first, never overwritten: it may still be someone's whole history.
   */
  private async readStoredForWrite(): Promise<StoredHistoryIndex> {
    const stored = await this.readStored()
    if (stored !== null) return stored
    const aside = join(
      this.getStoragePath(),
      `history.unreadable-${Date.now()}.json`
    )
    try {
      renameSync(this.indexPath, aside)
      log('history', 'moved an unreadable history.json aside', { aside })
    } catch (err) {
      throw new Error(
        `history.json is unreadable and could not be moved aside: ${String(err)}`,
        { cause: err }
      )
    }
    return { rest: {}, entries: [] }
  }

  private async writeStored(index: StoredHistoryIndex): Promise<void> {
    this.ensureStorageDir()
    await Bun.write(this.indexPath, serializeStoredHistoryIndex(index))
  }

  private deleteAudio(raw: unknown, context: string): void {
    const name = storedAudioFilename(raw)
    if (name === null) return
    try {
      const p = join(this.recordingsDir, name)
      if (existsSync(p)) unlinkSync(p)
    } catch (err) {
      log('history', `failed to delete ${context} audio file`, {
        id: storedId(raw),
        err: String(err),
      })
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn, fn)
    this.writeQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  /** A Dictation. The audio is copied from `audioSourcePath` only when `saveAudio` is on. */
  async saveEntry(
    audioSourcePath: string,
    transcript: string,
    options?: { saveAudio?: boolean; maxEntries?: number }
  ): Promise<HistoryEntry> {
    return this.enqueue(async () => {
      const id = generateId()
      const saveAudio = options?.saveAudio ?? true
      let audioFilename = ''
      let durationMs = 0

      this.ensureStorageDir()

      if (saveAudio) {
        audioFilename = `${id}.wav`
        const destPath = join(this.recordingsDir, audioFilename)
        const sourceFile = Bun.file(audioSourcePath)
        if (!(await sourceFile.exists())) {
          throw new Error(`Source audio not found: ${audioSourcePath}`)
        }
        const audioBuffer = Buffer.from(await sourceFile.arrayBuffer())
        await Bun.write(destPath, audioBuffer)
        durationMs = estimateWavDurationMsFromBytes(audioBuffer) ?? 0
      }

      return this.append(
        {
          id,
          timestamp: Date.now(),
          transcript,
          audioFilename,
          durationMs,
          source: 'dictation',
        },
        options?.maxEntries ?? 0
      )
    })
  }

  /**
   * A File Transcription asked for in Codictate's window. Transcript only: the file is the
   * user's own and stays where it is, so no audio is copied and no audio path is needed.
   */
  async saveFileTranscription(
    transcript: string,
    options: { fileName: string; durationMs: number; maxEntries?: number }
  ): Promise<HistoryEntry> {
    return this.enqueue(async () => {
      this.ensureStorageDir()
      return this.append(
        {
          id: generateId(),
          timestamp: Date.now(),
          transcript,
          audioFilename: '',
          durationMs: Math.max(0, Math.round(options.durationMs)),
          source: 'file',
          fileName: options.fileName,
        },
        options.maxEntries ?? 0
      )
    })
  }

  /** Runs inside the write queue. */
  private async append(
    entry: HistoryEntry,
    maxEntries: number
  ): Promise<HistoryEntry> {
    const index = await this.readStoredForWrite()
    index.entries.push(entry)

    if (maxEntries > 0 && index.entries.length > maxEntries) {
      const removed = index.entries.splice(0, index.entries.length - maxEntries)
      for (const old of removed) this.deleteAudio(old, 'old')
    }

    await this.writeStored(index)

    log('history', 'saved entry', {
      id: entry.id,
      source: entry.source,
      audioFilename: entry.audioFilename || '(transcript only)',
    })
    return entry
  }

  async loadEntries(search?: string): Promise<HistoryEntry[]> {
    const index = await this.readIndex()
    const all = index.entries.slice().reverse()
    if (!search || !search.trim()) return all

    const q = search.trim().toLowerCase()
    const substring: HistoryEntry[] = []
    const fuzzy: HistoryEntry[] = []
    for (const e of all) {
      const text = searchableText(e)
      if (text.includes(q)) {
        substring.push(e)
      } else if (isSubsequence(q, text)) {
        fuzzy.push(e)
      }
    }
    return [...substring, ...fuzzy]
  }

  async deleteEntry(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = await this.readStoredForWrite()
      const matching = index.entries.filter((raw) => storedId(raw) === id)
      if (matching.length === 0) return false

      for (const raw of matching) this.deleteAudio(raw, 'the')
      index.entries = index.entries.filter((raw) => storedId(raw) !== id)
      await this.writeStored(index)

      log('history', 'deleted entry', { id })
      return true
    })
  }

  async getAudioBase64(id: string): Promise<string | null> {
    const index = await this.readIndex()
    const entry = index.entries.find((e) => e.id === id)
    if (!entry || !entry.audioFilename) return null

    const audioPath = join(this.recordingsDir, entry.audioFilename)
    try {
      const file = Bun.file(audioPath)
      if (!(await file.exists())) return null
      const buffer = Buffer.from(await file.arrayBuffer())
      return `data:audio/wav;base64,${buffer.toString('base64')}`
    } catch {
      return null
    }
  }
}
