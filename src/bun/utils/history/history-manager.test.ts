import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryManager } from './history-manager'

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
