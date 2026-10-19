import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { STALE_WORK_DIR_MS } from '../file-transcription/work-dirs'
import {
  encodeBase64,
  MAX_DROPPED_FILE_CHUNK_BYTES,
  uploadDroppedFile,
  type DroppedFileSource,
  type DroppedFileTransport,
} from '../../shared/dropped-file-upload'
import {
  ABANDONED_UPLOAD_MS,
  createDroppedFiles,
  droppedFileDisplayName,
  droppedFileName,
  isDroppedFileDirName,
  MAX_CONCURRENT_UPLOADS,
  type DroppedFilesDeps,
} from './dropped-files'

let parent = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'codictate-dropped-files-test-'))
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

/** What the page reads of a dropped `File`. */
const fileOf = (bytes: Uint8Array, name: string): DroppedFileSource => ({
  name,
  size: bytes.length,
  slice: (start, end) => ({
    arrayBuffer: async () => new Uint8Array(bytes.slice(start, end)).buffer,
  }),
})

const b64 = (text: string) => Buffer.from(text).toString('base64')

/** Our directories in `parent`. */
const uploadDirs = () => readdirSync(parent).filter(isDroppedFileDirName)

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting')
}

function setup(overrides: Partial<DroppedFilesDeps> = {}) {
  const queued: {
    filePath: string
    fileName: string
    contents: string
    settle: () => void
    fail: (err: Error) => void
  }[] = []
  let now = 1_000_000
  let ids = 0
  const dropped = createDroppedFiles({
    parentDir: parent,
    transcribe: (copy) =>
      new Promise<void>((resolve, reject) => {
        queued.push({
          ...copy,
          contents: readFileSync(copy.filePath, 'utf8'),
          settle: resolve,
          fail: reject,
        })
      }),
    now: () => now,
    log: () => {},
    newUploadId: () => `up-${++ids}`,
    ...overrides,
  })
  return {
    dropped,
    queued,
    advance: (ms: number) => {
      now += ms
    },
  }
}

async function begin(
  dropped: ReturnType<typeof setup>['dropped'],
  name: string,
  size: number
): Promise<string> {
  const reply = await dropped.begin({ name, size })
  if (!reply.ok) throw new Error(reply.message)
  return reply.uploadId
}

describe('dropped file names', () => {
  test('ordinary names come through unchanged', () => {
    for (const name of ['interview.mov', 'Søren 2026.m4a', '会议.mp3']) {
      expect(droppedFileName(name)).toBe(name)
      expect(droppedFileDisplayName(name)).toBe(name)
    }
  })

  test('never a path, never a name either system refuses', () => {
    expect(droppedFileName('../../etc/passwd')).toBe('passwd')
    expect(droppedFileName('C:\\Users\\me\\a.wav')).toBe('a.wav')
    expect(droppedFileName('a:b?.wav')).toBe('a_b_.wav')
    expect(droppedFileName('bad\u0000name.wav')).toBe('badname.wav')
    expect(droppedFileName('trailing. . ')).toBe('trailing')
    expect(droppedFileName('CON.wav')).toBe('_CON.wav')
    expect(droppedFileName('..')).toBe('Dropped file')
    expect(droppedFileName('')).toBe('Dropped file')
    expect(droppedFileDisplayName('  ')).toBe('Dropped file')
    expect(droppedFileDisplayName('a/b/talk.mov')).toBe('talk.mov')
  })

  test('a long name is cut to fit, keeping its extension', () => {
    const name = droppedFileName(`${'å'.repeat(300)}.mov`)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
    expect(name.endsWith('.mov')).toBe(true)
  })
})

describe('receiving a dropped file', () => {
  test('happy path: chunks in order, queued under its own name, deleted once the job settles', async () => {
    const { dropped, queued } = setup()
    const id = await begin(dropped, 'Interview 1.mov', 11)
    expect(
      await dropped.append({ uploadId: id, offset: 0, data: b64('hello ') })
    ).toEqual({
      ok: true,
      received: 6,
    })
    expect(
      await dropped.append({ uploadId: id, offset: 6, data: b64('world') })
    ).toEqual({
      ok: true,
      received: 11,
    })
    expect(await dropped.finish({ uploadId: id })).toEqual({ ok: true })

    expect(queued).toHaveLength(1)
    const [job] = queued
    expect(job.fileName).toBe('Interview 1.mov')
    expect(basename(job.filePath)).toBe('Interview 1.mov')
    expect(dirname(dirname(job.filePath))).toBe(parent)
    expect(isDroppedFileDirName(basename(dirname(job.filePath)))).toBe(true)
    expect(job.contents).toBe('hello world')

    // Still there while the job waits or runs.
    expect(existsSync(job.filePath)).toBe(true)
    job.settle()
    await waitFor(() => !existsSync(dirname(job.filePath)))
    expect(uploadDirs()).toEqual([])
  })

  test('an empty file is queued with no chunks', async () => {
    const { dropped, queued } = setup()
    const id = await begin(dropped, 'empty.wav', 0)
    expect(await dropped.finish({ uploadId: id })).toEqual({ ok: true })
    expect(queued[0]?.contents).toBe('')
  })

  test('a wrong offset ends the upload and deletes the copy', async () => {
    const { dropped, queued } = setup()
    const id = await begin(dropped, 'a.wav', 10)
    await dropped.append({ uploadId: id, offset: 0, data: b64('abcd') })
    const reply = await dropped.append({
      uploadId: id,
      offset: 2,
      data: b64('efgh'),
    })
    expect(reply.ok).toBe(false)
    expect(uploadDirs()).toEqual([])
    expect(
      await dropped.append({ uploadId: id, offset: 4, data: b64('ef') })
    ).toEqual({
      ok: false,
      message: "That file isn't being added anymore.",
    })
    expect(await dropped.finish({ uploadId: id })).toMatchObject({ ok: false })
    expect(queued).toEqual([])
  })

  test('more bytes than announced end the upload', async () => {
    const { dropped } = setup()
    const id = await begin(dropped, 'a.wav', 4)
    expect(
      (await dropped.append({ uploadId: id, offset: 0, data: b64('abcdef') }))
        .ok
    ).toBe(false)
    expect(uploadDirs()).toEqual([])
  })

  test('an oversized or malformed chunk ends the upload before it is decoded', async () => {
    const big = setup()
    const id = await begin(
      big.dropped,
      'a.wav',
      MAX_DROPPED_FILE_CHUNK_BYTES * 2
    )
    const tooBig = Buffer.alloc(MAX_DROPPED_FILE_CHUNK_BYTES + 3).toString(
      'base64'
    )
    expect(
      (await big.dropped.append({ uploadId: id, offset: 0, data: tooBig })).ok
    ).toBe(false)

    const bad = setup()
    const id2 = await begin(bad.dropped, 'b.wav', 10)
    expect(
      (
        await bad.dropped.append({
          uploadId: id2,
          offset: 0,
          data: 'not base64!',
        })
      ).ok
    ).toBe(false)
    const id3 = await begin(bad.dropped, 'c.wav', 10)
    expect(
      (await bad.dropped.append({ uploadId: id3, offset: 0, data: '' })).ok
    ).toBe(false)
    expect(uploadDirs()).toEqual([])
  })

  test('finishing short of the announced size refuses and deletes the copy', async () => {
    const { dropped, queued } = setup()
    const id = await begin(dropped, 'a.wav', 10)
    await dropped.append({ uploadId: id, offset: 0, data: b64('abc') })
    expect(await dropped.finish({ uploadId: id })).toEqual({
      ok: false,
      message: "That file didn't arrive in one piece. Try dropping it again.",
    })
    expect(queued).toEqual([])
    expect(uploadDirs()).toEqual([])
  })

  test('a size that is not a byte count is refused', async () => {
    const { dropped } = setup()
    for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect((await dropped.begin({ name: 'a.wav', size })).ok).toBe(false)
    }
    expect(uploadDirs()).toEqual([])
  })

  test('cancel deletes what arrived; an unknown upload is nothing to cancel', async () => {
    const { dropped, queued } = setup()
    const id = await begin(dropped, 'a.wav', 10)
    await dropped.append({ uploadId: id, offset: 0, data: b64('abc') })
    expect(uploadDirs()).toHaveLength(1)
    expect(await dropped.cancel({ uploadId: id })).toBe(true)
    expect(uploadDirs()).toEqual([])
    expect(await dropped.cancel({ uploadId: id })).toBe(false)
    expect(await dropped.finish({ uploadId: id })).toMatchObject({ ok: false })
    expect(queued).toEqual([])
  })

  test('a cancel that lands mid-write cleans up when the write returns', async () => {
    const { dropped } = setup()
    const id = await begin(dropped, 'a.wav', 10)
    const pending = dropped.append({
      uploadId: id,
      offset: 0,
      data: b64('abc'),
    })
    expect(await dropped.cancel({ uploadId: id })).toBe(true)
    expect((await pending).ok).toBe(false)
    expect(uploadDirs()).toEqual([])
  })

  test('the copy is deleted when its job fails, or is cancelled, too', async () => {
    const { dropped, queued } = setup()
    for (const name of ['a.wav', 'b.wav']) {
      const id = await begin(dropped, name, 1)
      await dropped.append({ uploadId: id, offset: 0, data: b64('x') })
      await dropped.finish({ uploadId: id })
    }
    expect(uploadDirs()).toHaveLength(2)
    // A cancelled or failed File Transcription still settles: the controller resolves.
    queued[0].settle()
    // And a broken settle path still deletes the copy.
    queued[1].fail(new Error('history exploded'))
    await waitFor(() => uploadDirs().length === 0)
  })

  test('only a few files at a time; an abandoned one frees its slot', async () => {
    const { dropped, advance } = setup()
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) {
      await begin(dropped, `f${i}.wav`, 10)
    }
    expect(await dropped.begin({ name: 'more.wav', size: 10 })).toEqual({
      ok: false,
      message:
        'Codictate is already adding several files. Try again when they are in.',
    })
    advance(ABANDONED_UPLOAD_MS)
    expect((await dropped.begin({ name: 'more.wav', size: 10 })).ok).toBe(true)
    await waitFor(() => uploadDirs().length === 1)
  })

  test('removeAll deletes copies being received and copies waiting in the queue', async () => {
    const { dropped } = setup()
    const receiving = await begin(dropped, 'a.wav', 10)
    await dropped.append({ uploadId: receiving, offset: 0, data: b64('abc') })
    const done = await begin(dropped, 'b.wav', 1)
    await dropped.append({ uploadId: done, offset: 0, data: b64('x') })
    await dropped.finish({ uploadId: done })
    expect(uploadDirs()).toHaveLength(2)
    dropped.removeAll()
    expect(uploadDirs()).toEqual([])
  })
})

describe('stale copies at boot', () => {
  test('old copies a crash left behind are removed; fresh ones and lookalikes are kept', () => {
    const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)
    const old = (NOW - STALE_WORK_DIR_MS - 60_000) / 1000
    const touch = (path: string, seconds: number) =>
      utimesSync(path, seconds, seconds)

    const stale = mkdtempSync(join(parent, 'codictate-dropped-file-'))
    writeFileSync(join(stale, 'talk.mov'), 'x')
    touch(join(stale, 'talk.mov'), old)
    touch(stale, old)

    const fresh = mkdtempSync(join(parent, 'codictate-dropped-file-'))

    const lookalike = join(parent, 'codictate-dropped-file-e2e-abcdef')
    mkdirSync(lookalike)
    touch(lookalike, old)

    const workDir = join(parent, 'codictate-file-transcription-abcdef')
    mkdirSync(workDir)
    touch(workDir, old)

    setup({ now: () => NOW })
    expect(existsSync(stale)).toBe(false)
    for (const kept of [fresh, lookalike, workDir]) {
      expect(existsSync(kept)).toBe(true)
    }
  })
})

describe('the page sending a file over RPC (the fallback)', () => {
  /**
   * The page's uploader against the real receiver, with no upload URL, so every byte goes
   * in RPC chunks. The HTTP path is in dropped-file-server.test.ts.
   */
  function wired(dropped: ReturnType<typeof setup>['dropped']) {
    const calls: string[] = []
    const transport: DroppedFileTransport = {
      begin: async (p) => {
        calls.push('begin')
        const reply = await dropped.begin(p)
        return reply.ok
          ? { ok: true, uploadId: reply.uploadId, upload: null }
          : reply
      },
      append: (p) => {
        calls.push(`append ${p.offset}`)
        return dropped.append(p)
      },
      finish: (p) => {
        calls.push('finish')
        return dropped.finish(p)
      },
      cancel: (p) => {
        calls.push('cancel')
        return dropped.cancel(p)
      },
      newUploadRequest: () => {
        throw new Error('no upload URL was given')
      },
    }
    return { transport, calls }
  }

  test('sends every byte in order, one chunk at a time, and reports progress', async () => {
    const { dropped, queued } = setup()
    const { transport, calls } = wired(dropped)
    const bytes = new Uint8Array(10_000).map((_, i) => (i * 7) % 256)
    const file = fileOf(bytes, 'clip.wav')
    const progress: number[] = []
    const result = await uploadDroppedFile(file, transport, {
      chunkBytes: 4096,
      onProgress: (sent) => progress.push(sent),
    })
    expect(result).toEqual({ status: 'queued' })
    expect(calls).toEqual([
      'begin',
      'append 0',
      'append 4096',
      'append 8192',
      'finish',
    ])
    expect(progress).toEqual([4096, 8192, 10_000])
    expect(new Uint8Array(readFileSync(queued[0].filePath))).toEqual(bytes)
  })

  test('a cancel stops after the chunk in flight and deletes the copy', async () => {
    const { dropped, queued } = setup()
    const { transport, calls } = wired(dropped)
    const controller = new AbortController()
    const result = await uploadDroppedFile(
      fileOf(new Uint8Array(10_000), 'clip.wav'),
      transport,
      {
        chunkBytes: 4096,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }
    )
    expect(result).toEqual({ status: 'cancelled' })
    expect(calls).toEqual(['begin', 'append 0', 'cancel'])
    expect(queued).toEqual([])
    expect(uploadDirs()).toEqual([])
  })

  test("the main process's refusal is the message shown", async () => {
    const { dropped } = setup()
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) {
      await begin(dropped, `f${i}.wav`, 10)
    }
    const { transport } = wired(dropped)
    expect(
      await uploadDroppedFile(fileOf(Buffer.from('x'), 'clip.wav'), transport)
    ).toEqual({
      status: 'failed',
      message:
        'Codictate is already adding several files. Try again when they are in.',
    })
  })

  test('a file that cannot be read, or a request that times out, fails and cleans up', async () => {
    const { dropped } = setup()
    const { transport, calls } = wired(dropped)
    const unreadable = {
      name: 'gone.mov',
      size: 10,
      slice: () => {
        throw new Error('NotReadableError')
      },
    }
    expect(await uploadDroppedFile(unreadable, transport)).toEqual({
      status: 'failed',
      message: "Couldn't read that file. It may have moved.",
    })
    expect(calls).toEqual(['begin', 'cancel'])
    expect(uploadDirs()).toEqual([])

    const timesOut: DroppedFileTransport = {
      ...transport,
      append: () => Promise.reject(new Error('RPC request timed out.')),
    }
    expect(
      await uploadDroppedFile(fileOf(Buffer.from('abc'), 'a.wav'), timesOut)
    ).toEqual({ status: 'failed', message: "Couldn't add that file." })
    expect(uploadDirs()).toEqual([])
  })
})

describe('encodeBase64', () => {
  test('matches Buffer, across the slice boundary', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => (i * 31) % 256)
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    expect(encodeBase64(new Uint8Array())).toBe('')
  })
})
