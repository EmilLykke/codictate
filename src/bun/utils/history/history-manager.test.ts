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
  storedTimingsFilename,
  type FileTranscriptionHistoryRecord,
} from './history-manager'
import { timedTranscriptFromPieces } from '../../../shared/timed-transcript'

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

    const entry = await manager.saveFileTranscription({
      transcript: 'the quarterly numbers',
      fileName: 'board-call.m4a',
      filePath: '/Users/me/board-call.m4a',
      durationMs: 3_121_500.4,
      processingSeconds: 42.3,
      speechModelId: 'large-v3-turbo-q5_0',
      language: null,
      translated: false,
      timedTranscript: null,
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

function fileRecord(
  overrides: Partial<FileTranscriptionHistoryRecord> = {}
): FileTranscriptionHistoryRecord {
  const transcript = overrides.transcript ?? 'Hello there. How are you?'
  return {
    transcript,
    fileName: 'memo.m4a',
    filePath: '/Users/me/memo.m4a',
    durationMs: 5_200,
    processingSeconds: 1.4,
    speechModelId: 'large-v3-turbo-q5_0',
    language: 'en',
    translated: false,
    timedTranscript: timedTranscriptFromPieces(transcript, [
      { text: 'Hello there.', start: 0.5, end: 1.25 },
      { text: 'How are you?', start: 3, end: 4.1 },
    ]),
    ...overrides,
  }
}

describe('File Transcription details and the Timed Transcript sidecar', () => {
  const readIndexFile = (storage: string) =>
    JSON.parse(readFileSync(join(storage, 'history.json'), 'utf8')) as {
      entries: Record<string, unknown>[]
    }
  const sidecar = (storage: string, id: string) =>
    join(storage, 'timings', `${id}.json`)

  test('keeps the whole record, with the Timed Transcript in a sidecar', async () => {
    const { manager, storage } = createManager()
    const record = fileRecord()

    const entry = await manager.saveFileTranscription(record)

    expect(entry).toEqual({
      id: entry.id,
      timestamp: expect.any(Number),
      transcript: record.transcript,
      audioFilename: '',
      durationMs: 5_200,
      source: 'file',
      fileName: 'memo.m4a',
      filePath: '/Users/me/memo.m4a',
      processingSeconds: 1.4,
      speechModelId: 'large-v3-turbo-q5_0',
      language: 'en',
      translated: false,
      hasTimedTranscript: true,
    })
    expect((await manager.loadEntries())[0]).toEqual(entry)

    const [stored] = readIndexFile(storage).entries
    expect(stored.timedTranscriptFile).toBe(`${entry.id}.json`)
    expect(stored).not.toHaveProperty('timedTranscript')
    expect(stored).not.toHaveProperty('hasTimedTranscript')
    expect(
      JSON.parse(readFileSync(sidecar(storage, entry.id), 'utf8'))
    ).toEqual(record.timedTranscript)

    expect(await manager.loadExportSource(entry.id)).toEqual({
      fileName: 'memo.m4a',
      speechModelId: 'large-v3-turbo-q5_0',
      language: 'en',
      translated: false,
      audioSeconds: 5.2,
      processingSeconds: 1.4,
      text: record.transcript,
      timedTranscript: record.timedTranscript,
    })
  })

  test('a dropped file keeps its name and no path', async () => {
    const { manager, storage } = createManager()
    const entry = await manager.saveFileTranscription(
      fileRecord({ fileName: 'Interview.mov', filePath: null })
    )
    expect(entry.fileName).toBe('Interview.mov')
    expect(entry).not.toHaveProperty('filePath')
    const [stored] = readIndexFile(storage).entries
    expect(stored).not.toHaveProperty('filePath')
    expect((await manager.loadEntries())[0]).not.toHaveProperty('filePath')
  })

  test('no Timed Transcript, no sidecar', async () => {
    const { manager, storage } = createManager()
    const entry = await manager.saveFileTranscription(
      fileRecord({ timedTranscript: null, language: null, translated: true })
    )

    expect(entry).toMatchObject({
      hasTimedTranscript: false,
      language: null,
      translated: true,
    })
    expect(readIndexFile(storage).entries[0]).not.toHaveProperty(
      'timedTranscriptFile'
    )
    expect(existsSync(join(storage, 'timings'))).toBe(false)
    expect(await manager.loadExportSource(entry.id)).toMatchObject({
      language: null,
      translated: true,
      timedTranscript: null,
    })
  })

  test('a Timed Transcript that does not say the transcript is not kept', async () => {
    const { manager, storage } = createManager()
    const entry = await manager.saveFileTranscription(
      fileRecord({
        timedTranscript: timedTranscriptFromPieces('Something else.', [
          { text: 'Something else.', start: 0, end: 1 },
        ]),
      })
    )
    expect(entry.hasTimedTranscript).toBe(false)
    expect(existsSync(sidecar(storage, entry.id))).toBe(false)
  })

  test('deleting the entry deletes its sidecar', async () => {
    const { manager, storage } = createManager()
    const entry = await manager.saveFileTranscription(fileRecord())
    expect(existsSync(sidecar(storage, entry.id))).toBe(true)

    expect(await manager.deleteEntry(entry.id)).toBe(true)

    expect(existsSync(sidecar(storage, entry.id))).toBe(false)
    expect(await manager.loadExportSource(entry.id)).toBeNull()
  })

  test('trimming to maxEntries deletes the sidecar of the entry it drops', async () => {
    const { manager, storage } = createManager()
    const first = await manager.saveFileTranscription(fileRecord())
    const second = await manager.saveFileTranscription(fileRecord(), {
      maxEntries: 1,
    })

    expect(existsSync(sidecar(storage, first.id))).toBe(false)
    expect(existsSync(sidecar(storage, second.id))).toBe(true)
    expect((await manager.loadEntries()).map((e) => e.id)).toEqual([second.id])
  })

  test('a missing or unreadable sidecar gives no Timed Transcript, and the rest still exports', async () => {
    const { manager, storage } = createManager()
    const garbled = await manager.saveFileTranscription(fileRecord())
    const gone = await manager.saveFileTranscription(fileRecord())
    const wrongShape = await manager.saveFileTranscription(fileRecord())
    writeFileSync(sidecar(storage, garbled.id), '{"text": "Hello', 'utf8')
    rmSync(sidecar(storage, gone.id))
    writeFileSync(
      sidecar(storage, wrongShape.id),
      JSON.stringify({ text: 'Hello there. How are you?', parts: [] })
    )

    for (const id of [garbled.id, gone.id, wrongShape.id]) {
      expect(await manager.loadExportSource(id)).toMatchObject({
        text: 'Hello there. How are you?',
        speechModelId: 'large-v3-turbo-q5_0',
        timedTranscript: null,
      })
    }
  })

  test('an entry saved before these fields existed exports with nulls', async () => {
    const { manager, storage } = createManager()
    writeFileSync(
      join(storage, 'history.json'),
      JSON.stringify({
        entries: [
          {
            id: 'old-file',
            timestamp: 1,
            transcript: 'the quarterly numbers',
            audioFilename: '',
            durationMs: 3_121_500,
            source: 'file',
            fileName: 'board-call.m4a',
          },
          {
            id: 'a-dictation',
            timestamp: 2,
            transcript: 'hello',
            audioFilename: '',
          },
        ],
      })
    )

    const [, oldFile] = await manager.loadEntries()
    expect(oldFile).toEqual({
      id: 'old-file',
      timestamp: 1,
      transcript: 'the quarterly numbers',
      audioFilename: '',
      durationMs: 3_121_500,
      source: 'file',
      fileName: 'board-call.m4a',
      hasTimedTranscript: false,
    })
    expect(await manager.loadExportSource('old-file')).toEqual({
      fileName: 'board-call.m4a',
      speechModelId: null,
      language: null,
      translated: false,
      audioSeconds: 3_121.5,
      processingSeconds: null,
      text: 'the quarterly numbers',
      timedTranscript: null,
    })
    expect(await manager.loadExportSource('a-dictation')).toBeNull()
    expect(await manager.loadExportSource('nope')).toBeNull()
  })

  test('File Transcription fields are read only on File Transcriptions, and only when well-formed', () => {
    const shown = {
      filePath: '/x/a.m4a',
      processingSeconds: 2,
      speechModelId: 'small-q5_1',
      language: 'da',
      translated: true,
    }
    const fields = { ...shown, timedTranscriptFile: 'd.json' }
    expect(
      normalizeHistoryEntry({
        id: 'd',
        transcript: 't',
        source: 'dictation',
        ...fields,
      })
    ).toEqual({
      id: 'd',
      timestamp: 0,
      transcript: 't',
      audioFilename: '',
      source: 'dictation',
    })
    const file = normalizeHistoryEntry({
      id: 'f',
      transcript: 't',
      source: 'file',
      ...fields,
    })
    expect(file).toMatchObject({ ...shown, hasTimedTranscript: true })
    expect(file).not.toHaveProperty('timedTranscriptFile')
    expect(
      normalizeHistoryEntry({
        id: 'g',
        transcript: 't',
        source: 'file',
        filePath: 3,
        processingSeconds: -1,
        speechModelId: '',
        language: 7,
        translated: 'yes',
        timedTranscriptFile: '../escape.json',
      })
    ).toEqual({
      id: 'g',
      timestamp: 0,
      transcript: 't',
      audioFilename: '',
      source: 'file',
      hasTimedTranscript: false,
    })
  })

  test('storedTimingsFilename only names a file inside timings/', () => {
    expect(storedTimingsFilename({ timedTranscriptFile: 'a.json' })).toBe(
      'a.json'
    )
    expect(storedTimingsFilename({ timedTranscriptFile: '' })).toBeNull()
    expect(
      storedTimingsFilename({ timedTranscriptFile: '../a.json' })
    ).toBeNull()
    expect(
      storedTimingsFilename({ timedTranscriptFile: 'a\\b.json' })
    ).toBeNull()
    expect(storedTimingsFilename({ audioFilename: 'a.wav' })).toBeNull()
    expect(storedTimingsFilename(null)).toBeNull()
  })
})
