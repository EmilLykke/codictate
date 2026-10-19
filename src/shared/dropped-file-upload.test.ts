import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DROPPED_FILE_UPLOAD_TOKEN_HEADER,
  uploadDroppedFile,
  type DroppedFileSource,
  type DroppedFileTransport,
  type DroppedFileUploadRequest,
} from './dropped-file-upload'

/**
 * The page's uploader against a scripted `XMLHttpRequest` and a scripted main process. The
 * real receiver behind the same calls is in
 * src/bun/window-file-transcriptions/dropped-file-server.test.ts.
 */

const URL = 'http://127.0.0.1:4321/dropped-files/up-1'
const TOKEN = 'f'.repeat(64)

const fileOf = (size: number, name = 'clip.mov'): DroppedFileSource => ({
  name,
  size,
  slice: (start, end) => ({
    arrayBuffer: async () => new Uint8Array(end - start).buffer,
  }),
})

/** One request, driven by the test: `progress`, `respond`, `fail`. */
class ScriptedRequest implements DroppedFileUploadRequest<DroppedFileSource> {
  status = 0
  responseText = ''
  opened: { method: string; url: string } | null = null
  headers: Record<string, string> = {}
  sent: DroppedFileSource | null = null
  aborted = false
  private listeners = new Map<string, () => void>()
  private onProgress: (event: { loaded: number }) => void = () => {}
  upload = {
    addEventListener: (
      _type: 'progress',
      listener: (event: { loaded: number }) => void
    ) => {
      this.onProgress = listener
    },
  }

  constructor(private script: (request: ScriptedRequest) => void) {}

  open(method: string, url: string) {
    this.opened = { method, url }
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }
  send(body: DroppedFileSource) {
    this.sent = body
    queueMicrotask(() => this.script(this))
  }
  abort() {
    this.aborted = true
    this.listeners.get('abort')?.()
  }

  progress(loaded: number) {
    this.onProgress({ loaded })
  }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.listeners.get('load')?.()
  }
  /** A network error: blocked, refused by CORS, or nothing listening. */
  fail() {
    this.status = 0
    this.listeners.get('error')?.()
  }
}

function transport(
  script: (request: ScriptedRequest) => void,
  options: { upload?: boolean } = {}
) {
  const calls: string[] = []
  const requests: ScriptedRequest[] = []
  let received = 0
  const t: DroppedFileTransport = {
    begin: async () => {
      calls.push('begin')
      received = 0
      return {
        ok: true,
        uploadId: 'up-1',
        upload: options.upload === false ? null : { url: URL, token: TOKEN },
      }
    },
    append: async ({ offset, data }) => {
      calls.push(`append ${offset}`)
      received = offset + Buffer.from(data, 'base64').length
      return { ok: true, received }
    },
    finish: async () => {
      calls.push('finish')
      return { ok: true }
    },
    cancel: async () => {
      calls.push('cancel')
      return true
    },
    newUploadRequest: () => {
      calls.push('put')
      const request = new ScriptedRequest(script)
      requests.push(request)
      return request
    },
  }
  return { transport: t, calls, requests }
}

const warn = spyOn(console, 'warn').mockImplementation(() => {})

afterEach(() => {
  warn.mockClear()
})

afterAll(() => {
  warn.mockRestore()
})

describe('uploading over HTTP', () => {
  test('PUTs the file itself with the token, reports progress, then finishes', async () => {
    const {
      transport: t,
      calls,
      requests,
    } = transport((r) => {
      r.progress(4000)
      r.progress(10_000)
      r.respond(200, { ok: true, received: 10_000 })
    })
    const file = fileOf(10_000)
    const progress: number[] = []
    expect(
      await uploadDroppedFile(file, t, {
        onProgress: (sent, size) => progress.push(sent / size),
      })
    ).toEqual({ status: 'queued' })
    expect(calls).toEqual(['begin', 'put', 'finish'])
    const [request] = requests
    expect(request.opened).toEqual({ method: 'PUT', url: URL })
    expect(request.headers).toEqual({
      [DROPPED_FILE_UPLOAD_TOKEN_HEADER]: TOKEN,
    })
    expect(request.sent).toBe(file)
    expect(progress).toEqual([0.4, 1, 1])
    expect(warn).not.toHaveBeenCalled()
  })

  test('a cancel aborts the request and tells the main process', async () => {
    const controller = new AbortController()
    const {
      transport: t,
      calls,
      requests,
    } = transport((r) => {
      r.progress(100)
      controller.abort()
    })
    expect(
      await uploadDroppedFile(fileOf(10_000), t, { signal: controller.signal })
    ).toEqual({ status: 'cancelled' })
    expect(requests[0].aborted).toBe(true)
    expect(calls).toEqual(['begin', 'put', 'cancel'])
  })

  test("a refusal is the main process's message, with no fallback", async () => {
    const message = "There isn't enough free space to add that file."
    const { transport: t, calls } = transport((r) =>
      r.respond(400, { ok: false, message })
    )
    expect(await uploadDroppedFile(fileOf(10), t)).toEqual({
      status: 'failed',
      message,
    })
    expect(calls).toEqual(['begin', 'put', 'cancel'])
    expect(warn).not.toHaveBeenCalled()
  })

  test('an answer that is not ours, or the wrong byte count, fails with no fallback', async () => {
    for (const script of [
      (r: ScriptedRequest) => r.respond(500, '<html>oops</html>'),
      (r: ScriptedRequest) => r.respond(200, { ok: true, received: 9 }),
    ]) {
      const { transport: t, calls } = transport(script)
      expect(await uploadDroppedFile(fileOf(10), t)).toEqual({
        status: 'failed',
        message: "Couldn't add that file.",
      })
      expect(calls).toEqual(['begin', 'put', 'cancel'])
    }
  })

  test('a network error after bytes went out fails, with no fallback', async () => {
    const { transport: t, calls } = transport((r) => {
      r.progress(5)
      r.fail()
    })
    expect(await uploadDroppedFile(fileOf(10), t)).toEqual({
      status: 'failed',
      message: "Couldn't add that file.",
    })
    expect(calls).toEqual(['begin', 'put', 'cancel'])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the RPC fallback', () => {
  test('a request that never got through goes over RPC instead, logged once per page', async () => {
    for (let i = 0; i < 2; i += 1) {
      const { transport: t, calls } = transport((r) => r.fail())
      expect(
        await uploadDroppedFile(fileOf(10_000), t, { chunkBytes: 4096 })
      ).toEqual({ status: 'queued' })
      expect(calls).toEqual([
        'begin',
        'put',
        'append 0',
        'append 4096',
        'append 8192',
        'finish',
      ])
    }
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('no upload URL (the main process could not listen) goes straight to RPC, silently', async () => {
    const { transport: t, calls } = transport(() => {}, { upload: false })
    expect(
      await uploadDroppedFile(fileOf(10), t, { chunkBytes: 4096 })
    ).toEqual({ status: 'queued' })
    expect(calls).toEqual(['begin', 'append 0', 'finish'])
    expect(warn).not.toHaveBeenCalled()
  })
})
