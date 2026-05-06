import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import type { HistoryEntry } from '../../../shared/types'

const INDEX_FILENAME = 'history.json'
const RECORDINGS_DIR = 'recordings'

function isSubsequence(needle: string, haystack: string): boolean {
  let j = 0
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++
  }
  return j === needle.length
}

function estimateWavDurationMs(buf: Buffer): number {
  if (buf.length < 44) return 0
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return 0
  if (buf.subarray(8, 12).toString('ascii') !== 'WAVE') return 0

  let off = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataSize = 0

  while (off + 8 <= buf.length) {
    const chunkId = buf.subarray(off, off + 4).toString('ascii')
    const chunkSize = buf.readUInt32LE(off + 4)
    const dataStart = off + 8
    off += 8 + chunkSize + (chunkSize % 2)
    if (chunkId === 'fmt ') {
      if (dataStart + 16 > buf.length) return 0
      channels = buf.readUInt16LE(dataStart + 2)
      sampleRate = buf.readUInt32LE(dataStart + 4)
      bitsPerSample = buf.readUInt16LE(dataStart + 14)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return 0
  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!bytesPerFrame || !Number.isInteger(bytesPerFrame)) return 0
  return Math.floor((dataSize / bytesPerFrame / sampleRate) * 1000)
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
    try {
      const file = Bun.file(this.indexPath)
      if (!(await file.exists())) return { entries: [] }
      return (await file.json()) as HistoryIndex
    } catch {
      return { entries: [] }
    }
  }

  private async writeIndex(index: HistoryIndex): Promise<void> {
    this.ensureStorageDir()
    await Bun.write(this.indexPath, JSON.stringify(index, null, 2))
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn, fn)
    this.writeQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

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
        durationMs = estimateWavDurationMs(audioBuffer)
      }

      const entry: HistoryEntry = {
        id,
        timestamp: Date.now(),
        transcript,
        audioFilename,
        durationMs,
      }

      const index = await this.readIndex()
      index.entries.push(entry)

      const maxEntries = options?.maxEntries ?? 0
      if (maxEntries > 0 && index.entries.length > maxEntries) {
        const removed = index.entries.splice(
          0,
          index.entries.length - maxEntries
        )
        for (const old of removed) {
          if (old.audioFilename) {
            try {
              const p = join(this.recordingsDir, old.audioFilename)
              if (existsSync(p)) unlinkSync(p)
            } catch (err) {
              log('history', 'failed to delete old audio file', {
                id: old.id,
                err: String(err),
              })
            }
          }
        }
      }

      await this.writeIndex(index)

      log('history', 'saved entry', {
        id,
        audioFilename: audioFilename || '(transcript only)',
      })
      return entry
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
      const text = e.transcript.toLowerCase()
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
      const index = await this.readIndex()
      const entry = index.entries.find((e) => e.id === id)
      if (!entry) return false

      const audioPath = join(this.recordingsDir, entry.audioFilename)
      try {
        if (existsSync(audioPath)) unlinkSync(audioPath)
      } catch (err) {
        log('history', 'failed to delete audio file', {
          id,
          err: String(err),
        })
      }

      index.entries = index.entries.filter((e) => e.id !== id)
      await this.writeIndex(index)

      log('history', 'deleted entry', { id })
      return true
    })
  }

  async getAudioBase64(id: string): Promise<string | null> {
    const index = await this.readIndex()
    const entry = index.entries.find((e) => e.id === id)
    if (!entry) return null

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
