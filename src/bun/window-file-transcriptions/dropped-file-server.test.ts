import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DROPPED_FILE_UPLOAD_TOKEN_HEADER,
  uploadDroppedFile,
  type DroppedFileSource,
  type DroppedFileTransport,
  type DroppedFileUploadRequest,
} from '../../shared/dropped-file-upload'
import {
  createDroppedFileServer,
  type DroppedFileListener,
} from './dropped-file-server'
import {
  ABANDONED_UPLOAD_MS,
  createDroppedFiles,
  isDroppedFileDirName,
} from './dropped-files'

/**
 * The upload endpoint, called with plain `Request`s: no socket is ever opened. The receiver
 * behind it is the real one, over an isolated temp directory.
 */

let parent = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'codictate-dropped-file-server-test-'))
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

const TOKEN = 'a'.repeat(64)
const GONE = "That file isn't being added anymore."
const BROKEN = "That file didn't arrive in one piece. Try dropping it again."

const uploadDirs = () => readdirSync(parent).filter(isDroppedFileDirName)
const text = (value: string) => new TextEncoder().encode(value)

function setup(listen?: () => DroppedFileListener) {
  const queued: { filePath: string; fileName: string; bytes: Buffer }[] = []
  let ids = 0
  let now = 1_000_000
  /** The abandonment check, fired by hand. */
  const timers = new Set<() => void>()
  const droppedFiles = createDroppedFiles({
    parentDir: parent,
    transcribe: async (copy) => {
      queued.push({ ...copy, bytes: readFileSync(copy.filePath) })
    },
    now: () => now,
    log: () => {},
    newUploadId: () => `up-${++ids}`,
    newToken: () => TOKEN,
    setTimer: (callback) => {
      timers.add(callback)
      return () => void timers.delete(callback)
    },
  })
  const stop = mock(() => {})
  const listenMock = mock(listen ?? (() => ({ port: 4321, stop })))
  const server = createDroppedFileServer({
    droppedFiles,
    listen: listenMock,
    log: () => {},
  })
  return {
    droppedFiles,
    server,
    queued,
    listen: listenMock,
    stop,
    advance: (ms: number) => {
      now += ms
    },
    fireTimers: () => {
      const due = [...timers]
      timers.clear()
      for (const callback of due) callback()
    },
  }
}

/** Listeners that record when they open and stop, on ports 5000, 5001, ... */
function recordingListeners() {
  const events: string[] = []
  let next = 5000
  const listen = () => {
    const port = next++
    events.push(`open ${port}`)
    return {
      port,
      stop: (cutOff: boolean) =>
        void events.push(`${cutOff ? 'cut off' : 'stop'} ${port}`),
    }
  }
  return { events, listen }
}

async function begin(server: ReturnType<typeof setup>['server'], size: number) {
  const reply = await server.begin({ name: 'talk.mov', size })
  if (!reply.ok || reply.upload === null) throw new Error('no upload URL')
  return { uploadId: reply.uploadId, ...reply.upload }
}

function put(
  url: string,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {
    [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: TOKEN,
  }
): Request {
  return new Request(url, { method: 'PUT', headers, body })
}

/** A body the test feeds by hand, to land a cancel mid-stream. */
function handFed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  return { stream, controller }
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe('beginning an upload', () => {
  test('hands out a loopback URL and the token; listens once, on first use', async () => {
    const { server, listen, stop } = setup()
    expect(listen).not.toHaveBeenCalled()
    expect(await server.begin({ name: 'talk.mov', size: 3 })).toEqual({
      ok: true,
      uploadId: 'up-1',
      upload: { url: 'http://127.0.0.1:4321/dropped-files/up-1', token: TOKEN },
    })
    await server.begin({ name: 'b.mov', size: 3 })
    expect(listen).toHaveBeenCalledTimes(1)
    server.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('when it cannot listen there is no URL, and the RPC chunks still work', async () => {
    const { server, droppedFiles } = setup(() => {
      throw new Error('EADDRNOTAVAIL')
    })
    const reply = await server.begin({ name: 'talk.mov', size: 3 })
    expect(reply).toEqual({ ok: true, uploadId: 'up-1', upload: null })
    expect(
      await droppedFiles.append({
        uploadId: 'up-1',
        offset: 0,
        data: Buffer.from('abc').toString('base64'),
      })
    ).toEqual({ ok: true, received: 3 })
  })

  test("the receiver's refusal passes through untouched", async () => {
    const { server } = setup()
    expect(await server.begin({ name: 'a.mov', size: -1 })).toEqual({
      ok: false,
      message: "Couldn't add that file.",
    })
  })
})

describe('the PUT', () => {
  test('every byte, then finish: queued byte for byte', async () => {
    const { server, droppedFiles, queued } = setup()
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 13) % 256)
    const { uploadId, url } = await begin(server, bytes.length)
    const response = await server.handle(
      put(url, bytes, {
        [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: TOKEN,
        'content-length': String(bytes.length),
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await json(response)).toEqual({ ok: true, received: 100_000 })
    expect(await droppedFiles.finish({ uploadId })).toEqual({ ok: true })
    expect(new Uint8Array(queued[0].bytes)).toEqual(bytes)
  })

  test('a streamed body in several pieces, and an empty file with no body', async () => {
    const { server, droppedFiles, queued } = setup()
    const { uploadId, url } = await begin(server, 11)
    const { stream, controller } = handFed()
    const pending = server.handle(put(url, stream))
    controller.enqueue(text('hello '))
    controller.enqueue(text('world'))
    controller.close()
    expect(await json(await pending)).toEqual({ ok: true, received: 11 })
    await droppedFiles.finish({ uploadId })
    expect(queued[0].bytes.toString()).toBe('hello world')

    const empty = await begin(server, 0)
    expect((await server.handle(put(empty.url, null))).status).toBe(200)
    expect(await droppedFiles.finish({ uploadId: empty.uploadId })).toEqual({
      ok: true,
    })
  })

  test('a wrong or missing token is a 404 like an unknown upload, and leaves the upload alone', async () => {
    const { server, droppedFiles } = setup()
    const { uploadId, url } = await begin(server, 3)
    const unknown = await server.handle(
      put('http://127.0.0.1:4321/dropped-files/nope', text('abc'))
    )
    for (const headers of [
      { [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: 'b'.repeat(64) } as Record<
        string,
        string
      >,
      { [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: 'short' },
      {},
    ]) {
      const wrong = await server.handle(put(url, text('abc'), headers))
      expect(wrong.status).toBe(404)
      expect(await json(wrong)).toEqual({ ok: false, message: GONE })
    }
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toEqual({ ok: false, message: GONE })

    expect(uploadDirs()).toHaveLength(1)
    expect((await server.handle(put(url, text('abc')))).status).toBe(200)
    expect(await droppedFiles.finish({ uploadId })).toEqual({ ok: true })
  })

  test('more bytes than announced: refused, and the copy is gone', async () => {
    const { server, droppedFiles } = setup()
    const { uploadId, url } = await begin(server, 4)
    const response = await server.handle(put(url, text('abcdef')))
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ ok: false, message: BROKEN })
    expect(uploadDirs()).toEqual([])
    expect((await droppedFiles.finish({ uploadId })).ok).toBe(false)
  })

  test('fewer bytes than announced: refused, and the copy is gone', async () => {
    const { server, droppedFiles } = setup()
    const { uploadId, url } = await begin(server, 10)
    const response = await server.handle(put(url, text('abc')))
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ ok: false, message: BROKEN })
    expect(uploadDirs()).toEqual([])
    expect((await droppedFiles.finish({ uploadId })).ok).toBe(false)
  })

  test('a Content-Length that is not the announced size is refused before a byte is written', async () => {
    const { server } = setup()
    const { url } = await begin(server, 3)
    const { stream } = handFed()
    const response = await server.handle(
      put(url, stream, {
        [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: TOKEN,
        'content-length': '4',
      })
    )
    expect(response.status).toBe(400)
    expect(uploadDirs()).toEqual([])
  })

  test('a second PUT for the same upload ends it', async () => {
    const { server } = setup()
    const { url } = await begin(server, 3)
    expect((await server.handle(put(url, text('abc')))).status).toBe(200)
    expect((await server.handle(put(url, text('abc')))).status).toBe(400)
    expect(uploadDirs()).toEqual([])
  })

  test('a cancel mid-stream stops the read at once and deletes the copy', async () => {
    const { server, droppedFiles, queued } = setup()
    const { uploadId, url } = await begin(server, 10)
    const { stream, controller } = handFed()
    const pending = server.handle(put(url, stream))
    controller.enqueue(text('abc'))
    // The page never sends the rest: the cancel alone has to end the request.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await droppedFiles.cancel({ uploadId })).toBe(true)
    const response = await pending
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ ok: false, message: GONE })
    expect(uploadDirs()).toEqual([])
    expect(queued).toEqual([])
  })

  test('a body that breaks off (the page closed) ends the upload', async () => {
    const { server } = setup()
    const { url } = await begin(server, 10)
    const { stream, controller } = handFed()
    const pending = server.handle(put(url, stream))
    controller.enqueue(text('abc'))
    controller.error(new Error('connection reset'))
    expect((await pending).status).toBe(400)
    expect(uploadDirs()).toEqual([])
  })
})

describe('everything else', () => {
  test('the CORS preflight allows the token header, PUT and a private network', async () => {
    const { server } = setup()
    const response = await server.handle(
      new Request('http://127.0.0.1:4321/dropped-files/up-1', {
        method: 'OPTIONS',
      })
    )
    expect(response.status).toBe(204)
    const headers = Object.fromEntries(response.headers)
    expect(headers).toMatchObject({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': `${DROPPED_FILE_UPLOAD_TOKEN_HEADER}, content-type`,
      'access-control-allow-private-network': 'true',
    })
  })

  test('another method is a 405, another path a 404', async () => {
    const { server } = setup()
    const { url } = await begin(server, 3)
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await server.handle(new Request(url, { method }))
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('PUT, OPTIONS')
    }
    for (const path of ['/', '/other/up-1', '/dropped-files/%E0%A4%A']) {
      const response = await server.handle(
        put(`http://127.0.0.1:4321${path}`, text('abc'))
      )
      expect(response.status).toBe(404)
    }
    expect(uploadDirs()).toHaveLength(1)
  })
})

describe('the page uploading through it', () => {
  /** What the page reads of a dropped `File`. */
  const fileOf = (bytes: Uint8Array, name: string): DroppedFileSource => ({
    name,
    size: bytes.length,
    slice: (start, end) => ({
      arrayBuffer: async () => new Uint8Array(bytes.slice(start, end)).buffer,
    }),
  })

  /** An `XMLHttpRequest` stand-in that hands its request to `handle` instead of a socket. */
  function loopbackRequest(
    handle: (request: Request) => Promise<Response>
  ): DroppedFileUploadRequest<DroppedFileSource> {
    const listeners = new Map<string, () => void>()
    let progress: (event: { loaded: number }) => void = () => {}
    let method = ''
    let url = ''
    const headers: Record<string, string> = {}
    const request = {
      status: 0,
      responseText: '',
      upload: {
        addEventListener: (
          _type: 'progress',
          listener: (event: { loaded: number }) => void
        ) => {
          progress = listener
        },
      },
      open: (m: string, u: string) => {
        method = m
        url = u
      },
      setRequestHeader: (name: string, value: string) => {
        headers[name] = value
      },
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener)
      },
      abort: () => listeners.get('abort')?.(),
      send: (body: DroppedFileSource) => {
        void (async () => {
          const bytes = await body.slice(0, body.size).arrayBuffer()
          progress({ loaded: body.size })
          const response = await handle(
            new Request(url, { method, headers, body: bytes })
          )
          request.status = response.status
          request.responseText = await response.text()
          listeners.get('load')?.()
        })()
      },
    }
    return request
  }

  test('one PUT, then finish: queued byte for byte, and no chunk over RPC', async () => {
    const { server, droppedFiles, queued } = setup()
    const append = mock(droppedFiles.append)
    const transport: DroppedFileTransport = {
      begin: (p) => server.begin(p),
      append,
      finish: (p) => droppedFiles.finish(p),
      cancel: (p) => droppedFiles.cancel(p),
      newUploadRequest: () => loopbackRequest(server.handle),
    }
    const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256)
    const progress: number[] = []
    const result = await uploadDroppedFile(
      fileOf(bytes, 'clip.wav'),
      transport,
      {
        onProgress: (sent) => progress.push(sent),
      }
    )
    expect(result).toEqual({ status: 'queued' })
    expect(append).not.toHaveBeenCalled()
    expect(progress[progress.length - 1]).toBe(300_000)
    expect(new Uint8Array(queued[0].bytes)).toEqual(bytes)
    expect(queued[0].fileName).toBe('clip.wav')
  })
})

describe('the port is open only while a dropped file is being received', () => {
  test('opens on begin, not before', async () => {
    const { events, listen } = recordingListeners()
    const { server } = setup(listen)
    expect(events).toEqual([])
    const { url } = await begin(server, 3)
    expect(events).toEqual(['open 5000'])
    expect(url).toBe('http://127.0.0.1:5000/dropped-files/up-1')
  })

  test('a refused begin opens nothing', async () => {
    const { events, listen } = recordingListeners()
    const { server } = setup(listen)
    await server.begin({ name: 'a.mov', size: -1 })
    expect(events).toEqual([])
  })

  test('two drops at once share one port, which closes after the last PUT is answered', async () => {
    const { events, listen } = recordingListeners()
    const { server } = setup(listen)
    const a = await begin(server, 3)
    const b = await begin(server, 3)
    expect(new URL(a.url).port).toBe('5000')
    expect(new URL(b.url).port).toBe('5000')
    expect((await server.handle(put(a.url, text('abc')))).status).toBe(200)
    expect(events).toEqual(['open 5000'])
    expect((await server.handle(put(b.url, text('abc')))).status).toBe(200)
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('closes after a refused PUT too', async () => {
    const { events, listen } = recordingListeners()
    const { server } = setup(listen)
    const { url } = await begin(server, 3)
    expect((await server.handle(put(url, text('abcdef')))).status).toBe(400)
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('a wrong token does not close it: the real PUT is still to come', async () => {
    const { events, listen } = recordingListeners()
    const { server } = setup(listen)
    const { url } = await begin(server, 3)
    const wrong = await server.handle(
      put(url, text('abc'), {
        [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: 'b'.repeat(64),
      })
    )
    expect(wrong.status).toBe(404)
    expect(events).toEqual(['open 5000'])
    expect((await server.handle(put(url, text('abc')))).status).toBe(200)
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('stays open while another upload is in flight, then closes', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    const streaming = await begin(server, 6)
    const idle = await begin(server, 3)
    const { stream, controller } = handFed()
    const pending = server.handle(put(streaming.url, stream))
    controller.enqueue(text('abc'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The other upload ends with no bytes: the request in flight keeps the port.
    expect(await droppedFiles.cancel({ uploadId: idle.uploadId })).toBe(true)
    expect(events).toEqual(['open 5000'])
    controller.enqueue(text('def'))
    controller.close()
    expect((await pending).status).toBe(200)
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('a cancel mid-stream closes it only once that request is answered', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    const { uploadId, url } = await begin(server, 10)
    const { stream, controller } = handFed()
    const pending = server.handle(put(url, stream))
    controller.enqueue(text('abc'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await droppedFiles.cancel({ uploadId })).toBe(true)
    expect(events).toEqual(['open 5000'])
    expect((await pending).status).toBe(400)
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('closes after a cancel with no bytes', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    const { uploadId } = await begin(server, 3)
    await droppedFiles.cancel({ uploadId })
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('closes when the page falls back to the RPC chunks and finishes', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    const { uploadId } = await begin(server, 3)
    await droppedFiles.append({
      uploadId,
      offset: 0,
      data: Buffer.from('abc').toString('base64'),
    })
    expect(events).toEqual(['open 5000'])
    expect(await droppedFiles.finish({ uploadId })).toEqual({ ok: true })
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('closes when an upload is abandoned, on the timer', async () => {
    const { events, listen } = recordingListeners()
    const { server, advance, fireTimers } = setup(listen)
    await begin(server, 3)
    fireTimers()
    expect(events).toEqual(['open 5000'])
    advance(ABANDONED_UPLOAD_MS)
    fireTimers()
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })

  test('a later drop opens a fresh port', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    const first = await begin(server, 3)
    await droppedFiles.cancel({ uploadId: first.uploadId })
    const second = await begin(server, 3)
    expect(events).toEqual(['open 5000', 'stop 5000', 'open 5001'])
    expect(second.url).toBe('http://127.0.0.1:5001/dropped-files/up-2')
    expect((await server.handle(put(second.url, text('abc')))).status).toBe(200)
    expect(events).toEqual(['open 5000', 'stop 5000', 'open 5001', 'stop 5001'])
  })

  test('quitting closes it whatever is in flight, and opens no other', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    await begin(server, 3)
    await begin(server, 3)
    server.stop()
    expect(events).toEqual(['open 5000', 'cut off 5000'])
    droppedFiles.removeAll()
    server.stop()
    expect(await server.begin({ name: 'late.mov', size: 3 })).toEqual({
      ok: true,
      uploadId: 'up-3',
      upload: null,
    })
    expect(events).toEqual(['open 5000', 'cut off 5000'])
  })

  test('removeAll alone releases it too', async () => {
    const { events, listen } = recordingListeners()
    const { server, droppedFiles } = setup(listen)
    await begin(server, 3)
    droppedFiles.removeAll()
    expect(events).toEqual(['open 5000', 'stop 5000'])
  })
})
