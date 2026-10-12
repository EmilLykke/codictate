import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HistoryManager,
  normalizeHistoryEntry,
  normalizeHistoryIndex,
  parseStoredHistoryIndex,
  storedAudioFilename,
} from './history-manager'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createManager(): { manager: HistoryManager; storage: string } {
  const storage = mkdtempSync(join(tmpdir(), 'codictate-history-'))
  tempDirs.push(storage)
  return { manager: new HistoryManager(() => storage), storage }
}

function halfSecondWav(): Buffer {
  const sampleRate = 16_000
  const dataSize = sampleRate
  const wav = Buffer.alloc(44 + dataSize)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataSize, 40)
  return wav
}

describe('HistoryManager persistence', () => {
  test('serializes concurrent saves and recovers after a queued failure', async () => {
    const { manager, storage } = createManager()
    const failed = manager.saveEntry(
      join(storage, 'missing.wav'),
      'missing audio'
    )
    const first = manager.saveEntry('', 'first', { saveAudio: false })
    const second = manager.saveEntry('', 'second', { saveAudio: false })

    expect(
      await failed.then(
        () => false,
        () => true
      )
    ).toBe(true)
    await Promise.all([first, second])

    expect(
      (await manager.loadEntries()).map((entry) => entry.transcript)
    ).toEqual(['second', 'first'])
  })

  test('ranks substring matches before fuzzy matches and deletes entries', async () => {
    const { manager } = createManager()
    const substring = await manager.saveEntry('', 'contains abc exactly', {
      saveAudio: false,
    })
    await manager.saveEntry('', 'a big cat', { saveAudio: false })

    expect((await manager.loadEntries('abc')).map((entry) => entry.id)).toEqual(
      [substring.id, expect.any(String)]
    )
    expect(await manager.deleteEntry(substring.id)).toBe(true)
    expect(await manager.deleteEntry(substring.id)).toBe(false)
    expect(await manager.loadEntries('abc')).toHaveLength(1)
  })

  test('copies WAV audio, uses the shared duration parser, and removes the copy', async () => {
    const { manager, storage } = createManager()
    const source = join(storage, 'source.wav')
    writeFileSync(source, halfSecondWav())

    const entry = await manager.saveEntry(source, 'with audio')
    const savedAudio = join(storage, 'recordings', entry.audioFilename)

    expect(entry.durationMs).toBe(500)
    expect(existsSync(savedAudio)).toBe(true)
    expect(await manager.getAudioBase64(entry.id)).toStartWith(
      'data:audio/wav;base64,'
    )
    expect(await manager.deleteEntry(entry.id)).toBe(true)
    expect(existsSync(savedAudio)).toBe(false)
    expect(await manager.getAudioBase64(entry.id)).toBeNull()
  })
})

describe('History entry sources', () => {
  test('reads an entry written before File Transcription as a Dictation', () => {
    expect(
      normalizeHistoryEntry({
        id: 'a',
        timestamp: 1,
        transcript: 'hello',
        audioFilename: 'a.wav',
        durationMs: 500,
      })
    ).toEqual({
      id: 'a',
      timestamp: 1,
      transcript: 'hello',
      audioFilename: 'a.wav',
      durationMs: 500,
      source: 'dictation',
    })
  })

  test('keeps the file name only on a File Transcription', () => {
    expect(
      normalizeHistoryEntry({
        id: 'b',
        timestamp: 2,
        transcript: 'meeting',
        audioFilename: '',
        source: 'file',
        fileName: 'meeting.m4a',
      })
    ).toMatchObject({ source: 'file', fileName: 'meeting.m4a' })
    expect(
      normalizeHistoryEntry({
        id: 'c',
        timestamp: 3,
        transcript: 'x',
        source: 'dictation',
        fileName: 'stray.wav',
      })
    ).not.toHaveProperty('fileName')
  })

  test('drops malformed entries and tolerates a malformed index', () => {
    expect(
      normalizeHistoryIndex({
        entries: [null, { id: 1 }, { id: 'ok', transcript: 't' }],
      }).entries.map((entry) => entry.id)
    ).toEqual(['ok'])
    expect(normalizeHistoryIndex({}).entries).toEqual([])
    expect(normalizeHistoryIndex(null).entries).toEqual([])
  })

  test('saves a File Transcription with no audio, finds it by file name, and plays nothing', async () => {
    const { manager, storage } = createManager()
    writeFileSync(
      join(storage, 'history.json'),
      JSON.stringify({
        entries: [
          { id: 'old', timestamp: 1, transcript: 'old one', audioFilename: '' },
        ],
      })
    )

    const entry = await manager.saveFileTranscription('the quarterly numbers', {
      fileName: 'board-call.m4a',
      durationMs: 3_121_500.4,
    })

    expect(entry).toMatchObject({
      source: 'file',
      fileName: 'board-call.m4a',
      audioFilename: '',
      durationMs: 3_121_500,
    })
    const all = await manager.loadEntries()
    expect(all.map((e) => [e.id, e.source])).toEqual([
      [entry.id, 'file'],
      ['old', 'dictation'],
    ])
    expect((await manager.loadEntries('board-call')).map((e) => e.id)).toEqual([
      entry.id,
    ])
    expect(await manager.getAudioBase64(entry.id)).toBeNull()
  })
})

describe('history.json back-compat', () => {
  const readIndexFile = (storage: string) =>
    JSON.parse(readFileSync(join(storage, 'history.json'), 'utf8')) as {
      entries: unknown[]
      [key: string]: unknown
    }
  const transcripts = (storage: string) =>
    readIndexFile(storage).entries.map(
      (e) => (e as { transcript?: unknown }).transcript
    )

  test('a rewrite keeps unknown fields, top-level and per entry, and entries it cannot show', async () => {
    const { manager, storage } = createManager()
    const future = {
      id: 'future',
      timestamp: 5,
      transcript: 'from a newer Codictate',
      audioFilename: '',
      source: 'meeting',
      speakers: ['A', 'B'],
      durationMs: 'unknown',
    }
    const unreadable = { id: 'broken', transcript: 42, audioFilename: 'b.wav' }
    writeFileSync(
      join(storage, 'history.json'),
      JSON.stringify({ version: 3, entries: [future, unreadable, 'junk'] })
    )

    const saved = await manager.saveEntry('', 'new', { saveAudio: false })

    const written = readIndexFile(storage)
    expect(written.version).toBe(3)
    expect(written.entries.slice(0, 3)).toEqual([future, unreadable, 'junk'])
    expect(written.entries[3]).toMatchObject({
      id: saved.id,
      transcript: 'new',
    })

    // Shown: only what this version can read, normalized.
    expect((await manager.loadEntries()).map((e) => e.id)).toEqual([
      saved.id,
      'future',
    ])

    expect(await manager.deleteEntry(saved.id)).toBe(true)
    expect(readIndexFile(storage)).toEqual({
      version: 3,
      entries: [future, unreadable, 'junk'],
    })
  })

  test('trimming to maxEntries removes the audio of an entry this version cannot show', async () => {
    const { manager, storage } = createManager()
    mkdirSync(join(storage, 'recordings'), { recursive: true })
    writeFileSync(join(storage, 'recordings', 'old.wav'), halfSecondWav())
    writeFileSync(
      join(storage, 'history.json'),
      JSON.stringify({
        entries: [{ id: 'old', transcript: null, audioFilename: 'old.wav' }],
      })
    )

    await manager.saveEntry('', 'one', { saveAudio: false, maxEntries: 1 })

    expect(existsSync(join(storage, 'recordings', 'old.wav'))).toBe(false)
    expect(transcripts(storage)).toEqual(['one'])
  })

  test('an unreadable history.json is moved aside, never overwritten', async () => {
    const { manager, storage } = createManager()
    writeFileSync(join(storage, 'history.json'), '{"entries": [ truncated')

    expect(await manager.loadEntries()).toEqual([])
    await manager.saveEntry('', 'after', { saveAudio: false })

    const aside = readdirSync(storage).filter((name) =>
      name.startsWith('history.unreadable-')
    )
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(storage, aside[0]!), 'utf8')).toBe(
      '{"entries": [ truncated'
    )
    expect(transcripts(storage)).toEqual(['after'])
  })

  test('parseStoredHistoryIndex refuses what is not an index', () => {
    expect(parseStoredHistoryIndex({ entries: {} })).toBeNull()
    expect(parseStoredHistoryIndex([])).toBeNull()
    expect(parseStoredHistoryIndex('x')).toBeNull()
    expect(parseStoredHistoryIndex({ other: 1 })).toEqual({
      rest: { other: 1 },
      entries: [],
    })
  })

  test('storedAudioFilename only names a file inside recordings/', () => {
    expect(storedAudioFilename({ audioFilename: 'a.wav' })).toBe('a.wav')
    expect(storedAudioFilename({ audioFilename: '' })).toBeNull()
    expect(storedAudioFilename({ audioFilename: '../x.wav' })).toBeNull()
    expect(storedAudioFilename({ audioFilename: 'a\\b.wav' })).toBeNull()
    expect(storedAudioFilename({ audioFilename: '..' })).toBeNull()
    expect(storedAudioFilename(null)).toBeNull()
  })
})
