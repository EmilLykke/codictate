import { mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { log } from '../logger'
import type { HistoryEntry } from '../../../shared/types'
import {
  isTimedTranscript,
  type TimedTranscript,
} from '../../../shared/timed-transcript'
import type { TranscriptExportSource } from '../../../shared/transcript-export'
import { estimateWavDurationMsFromBytes } from '../../../shared/wav-duration'

const INDEX_FILENAME = 'history.json'
const RECORDINGS_DIR = 'recordings'
/** A File Transcription's Timed Transcript, one `<id>.json` per entry, kept out of `history.json`. */
const TIMINGS_DIR = 'timings'

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

/** What `append` needs of an entry it stores as is. */
type StoredEntry = Pick<HistoryEntry, 'id' | 'source' | 'audioFilename'>

interface HistoryIndex {
  entries: HistoryEntry[]
}

/** Everything History keeps about a File Transcription asked for in Codictate's window. */
export interface FileTranscriptionHistoryRecord {
  /** The Raw Transcript. */
  transcript: string
  fileName: string
  filePath: string
  /** Length of the file's audio. */
  durationMs: number
  /** Processing Time. */
  processingSeconds: number
  speechModelId: string
  /** The Transcription Language the run was fixed to, `null` when detected. */
  language: string | null
  translated: boolean
  timedTranscript: TimedTranscript | null
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

/** `raw[key]` when it is a bare file name, `null` otherwise. */
function storedBareFilename(raw: unknown, key: string): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const name = (raw as Record<string, unknown>)[key]
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
 * The recording a stored entry owns, as a bare file name inside `recordings/`, or `null`.
 * Read from the raw entry so an entry that is otherwise unreadable still has its audio
 * removed with it. Anything with a path separator is not ours to delete.
 */
export function storedAudioFilename(raw: unknown): string | null {
  return storedBareFilename(raw, 'audioFilename')
}

/**
 * The Timed Transcript sidecar a stored entry owns, as a bare file name inside `timings/`,
 * or `null`. Same rules as `storedAudioFilename`, for the same reasons.
 */
export function storedTimingsFilename(raw: unknown): string | null {
  return storedBareFilename(raw, 'timedTranscriptFile')
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
  if (source === 'file') readFileTranscriptionFields(value, entry)
  return entry
}

/** The File Transcription fields an entry has; an older entry has fewer, and none is required. */
function readFileTranscriptionFields(
  value: Record<string, unknown>,
  entry: HistoryEntry
): void {
  if (typeof value.fileName === 'string') entry.fileName = value.fileName
  if (typeof value.filePath === 'string' && value.filePath !== '') {
    entry.filePath = value.filePath
  }
  if (
    typeof value.processingSeconds === 'number' &&
    Number.isFinite(value.processingSeconds) &&
    value.processingSeconds >= 0
  ) {
    entry.processingSeconds = value.processingSeconds
  }
  if (typeof value.speechModelId === 'string' && value.speechModelId !== '') {
    entry.speechModelId = value.speechModelId
  }
  if (typeof value.language === 'string' || value.language === null) {
    entry.language = value.language
  }
  if (typeof value.translated === 'boolean') entry.translated = value.translated
  entry.hasTimedTranscript = storedTimingsFilename(value) !== null
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

  private get timingsDir(): string {
    return join(this.getStoragePath(), TIMINGS_DIR)
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

  /** The files a stored entry owns: its recording and its Timed Transcript sidecar. */
  private deleteOwnedFiles(raw: unknown, context: string): void {
    this.deleteFile(this.recordingsDir, storedAudioFilename(raw), raw, {
      context,
      kind: 'audio',
    })
    this.deleteFile(this.timingsDir, storedTimingsFilename(raw), raw, {
      context,
      kind: 'timings',
    })
  }

  private deleteFile(
    dir: string,
    name: string | null,
    raw: unknown,
    what: { context: string; kind: string }
  ): void {
    if (name === null) return
    try {
      const p = join(dir, name)
      if (existsSync(p)) unlinkSync(p)
    } catch (err) {
      log('history', `failed to delete ${what.context} ${what.kind} file`, {
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

      const entry: HistoryEntry = {
        id,
        timestamp: Date.now(),
        transcript,
        audioFilename,
        durationMs,
        source: 'dictation',
      }
      await this.append(entry, options?.maxEntries ?? 0)
      return entry
    })
  }

  /**
   * A File Transcription asked for in Codictate's window. Transcript only: the file is the
   * user's own and stays where it is, so no audio is copied and no audio path is needed.
   * Its Timed Transcript goes to a sidecar, `timings/<id>.json`, because `history.json` is
   * rewritten on every Dictation and shipped whole to the window. A sidecar that cannot be
   * written costs the captions, never the entry.
   */
  async saveFileTranscription(
    record: FileTranscriptionHistoryRecord,
    options: { maxEntries?: number } = {}
  ): Promise<HistoryEntry> {
    return this.enqueue(async () => {
      const id = generateId()
      this.ensureStorageDir()
      const timedTranscriptFile = await this.writeTimings(
        id,
        record.transcript,
        record.timedTranscript
      )
      const stored: StoredEntry & Record<string, unknown> = {
        id,
        timestamp: Date.now(),
        transcript: record.transcript,
        audioFilename: '',
        durationMs: Math.max(0, Math.round(record.durationMs)),
        source: 'file',
        fileName: record.fileName,
        filePath: record.filePath,
        processingSeconds: record.processingSeconds,
        speechModelId: record.speechModelId,
        language: record.language,
        translated: record.translated,
      }
      if (timedTranscriptFile !== null) {
        stored.timedTranscriptFile = timedTranscriptFile
      }
      try {
        await this.append(stored, options.maxEntries ?? 0)
      } catch (err) {
        this.deleteOwnedFiles(stored, 'the unsaved')
        throw err
      }
      const entry = normalizeHistoryEntry(stored)
      if (entry === null) throw new Error('unreachable: a saved entry is valid')
      return entry
    })
  }

  /** The sidecar's file name, or `null` when there is none to keep (or it could not be written). */
  private async writeTimings(
    id: string,
    transcript: string,
    timed: TimedTranscript | null
  ): Promise<string | null> {
    if (timed === null) return null
    if (!isTimedTranscript(timed) || timed.text !== transcript) {
      log('history', 'not keeping a Timed Transcript that does not match', {
        id,
      })
      return null
    }
    const name = `${id}.json`
    try {
      mkdirSync(this.timingsDir, { recursive: true })
      await Bun.write(join(this.timingsDir, name), JSON.stringify(timed))
      return name
    } catch (err) {
      log('history', 'failed to write the Timed Transcript', {
        id,
        err: String(err),
      })
      return null
    }
  }

  /**
   * What a Transcript Export of a History entry is made from. `null` when there is no File
   * Transcription entry with that id. What an older entry never recorded is `null` (and
   * `translated` is `false`); a sidecar that is gone or unreadable gives no Timed Transcript.
   */
  async loadExportSource(id: string): Promise<TranscriptExportSource | null> {
    const stored = await this.readStored()
    const raw = stored?.entries.find((e) => storedId(e) === id)
    const entry = raw === undefined ? null : normalizeHistoryEntry(raw)
    if (entry === null || entry.source !== 'file') return null
    return {
      fileName: entry.fileName ?? '',
      speechModelId: entry.speechModelId ?? null,
      language: entry.language ?? null,
      translated: entry.translated ?? false,
      audioSeconds: (entry.durationMs ?? 0) / 1000,
      processingSeconds: entry.processingSeconds ?? null,
      text: entry.transcript,
      timedTranscript: await this.readTimings(raw, entry.transcript),
    }
  }

  private async readTimings(
    raw: unknown,
    transcript: string
  ): Promise<TimedTranscript | null> {
    const name = storedTimingsFilename(raw)
    if (name === null) return null
    try {
      const file = Bun.file(join(this.timingsDir, name))
      if (!(await file.exists())) return null
      const value: unknown = await file.json()
      return isTimedTranscript(value) && value.text === transcript
        ? value
        : null
    } catch {
      return null
    }
  }

  /** Runs inside the write queue. `entry` is stored as is. */
  private async append(entry: StoredEntry, maxEntries: number): Promise<void> {
    const index = await this.readStoredForWrite()
    index.entries.push(entry)

    if (maxEntries > 0 && index.entries.length > maxEntries) {
      const removed = index.entries.splice(0, index.entries.length - maxEntries)
      for (const old of removed) this.deleteOwnedFiles(old, 'old')
    }

    await this.writeStored(index)

    log('history', 'saved entry', {
      id: entry.id,
      source: entry.source,
      audioFilename: entry.audioFilename || '(transcript only)',
    })
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

      for (const raw of matching) this.deleteOwnedFiles(raw, 'the')
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
