/**
 * Sending a file dropped on the window to the main process, from the page.
 *
 * Neither WKWebView (macOS) nor WebView2 (Windows) tells a page where a dropped file is on
 * disk, and Electrobun 1.18 has no native file-drop API. Both do hand the page a `File`, so
 * the page sends its bytes; the main process writes them to a temporary copy and queues that
 * (src/bun/window-file-transcriptions/dropped-files.ts).
 *
 * `beginDroppedFile` (RPC) answers with a loopback URL and a per-upload token, and the page
 * `PUT`s the `File` itself there with `XMLHttpRequest`: the webview streams it from disk, and
 * upload progress comes from `xhr.upload`. Then `finishDroppedFile` (RPC) queues the copy.
 * The bytes stay off the RPC because Electrobun moves every message through JSON, AES-GCM
 * and a byte-at-a-time base64 loop on both ends, which made a video take minutes.
 *
 * Fallback: when the `PUT` never gets through (blocked by the webview, nothing listening),
 * the file goes over the RPC in base64 chunks instead, one awaited at a time, as it all did
 * before. That path is kept only because the `PUT` is unverified in a real WebView2; delete
 * `sendInChunks` and its one branch in `uploadDroppedFile` once it is.
 *
 * No DOM or Node APIs beyond `Blob` and `btoa`, which the webviews and Bun all have; the
 * request is injected (`newUploadRequest`, an `XMLHttpRequest` in the page), so it is tested
 * in Bun (dropped-file-upload.test.ts).
 */

import type {
  AppendDroppedFileChunkReply,
  BeginDroppedFileReply,
  DroppedFileUploadTarget,
  FinishDroppedFileReply,
} from './types'

/** Where the main process takes uploads: `http://127.0.0.1:<port>/dropped-files/<uploadId>`. */
export const DROPPED_FILE_UPLOAD_PATH = '/dropped-files/'

/** Carries the upload's token. A custom header also makes the request preflighted. */
export const DROPPED_FILE_UPLOAD_TOKEN_HEADER = 'X-Codictate-Upload-Token'

/**
 * Bytes per chunk on the fallback path. 2 MiB keeps the round trips few on a large video
 * while Electrobun's per-message encryption (a byte-at-a-time base64 loop in its preload)
 * stays well inside the RPC request timeout (`maxRequestTime` in src/mainview/rpc.ts).
 */
export const DROPPED_FILE_CHUNK_BYTES = 2 * 1024 * 1024

/** The most the main process accepts in one chunk, decoded. */
export const MAX_DROPPED_FILE_CHUNK_BYTES = 4 * 1024 * 1024

/** When the page cannot read the file or reach the main process. */
export const DROPPED_FILE_READ_FAILED =
  "Couldn't read that file. It may have moved."
export const DROPPED_FILE_SEND_FAILED = "Couldn't add that file."

/** Base64 of `bytes`, in slices so a 2 MiB chunk never builds a huge argument list. */
export function encodeBase64(bytes: Uint8Array): string {
  const step = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** A dropped `File`, as far as the upload reads it. */
export interface DroppedFileSource {
  readonly name: string
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** The part of `XMLHttpRequest` the upload uses. `F` is what it sends: a `File` in the page. */
export interface DroppedFileUploadRequest<F extends DroppedFileSource> {
  open(method: 'PUT', url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: F): void
  abort(): void
  addEventListener(
    type: 'load' | 'error' | 'abort' | 'timeout',
    listener: () => void
  ): void
  readonly upload: {
    addEventListener(
      type: 'progress',
      listener: (event: { loaded: number }) => void
    ): void
  }
  readonly status: number
  readonly responseText: string
}

/** How the page reaches the main process: the four `bun` requests, and an HTTP request. */
export interface DroppedFileTransport<
  F extends DroppedFileSource = DroppedFileSource,
> {
  begin(params: { name: string; size: number }): Promise<BeginDroppedFileReply>
  append(params: {
    uploadId: string
    offset: number
    data: string
  }): Promise<AppendDroppedFileChunkReply>
  finish(params: { uploadId: string }): Promise<FinishDroppedFileReply>
  cancel(params: { uploadId: string }): Promise<boolean>
  newUploadRequest(): DroppedFileUploadRequest<F>
}

export type DroppedFileUploadResult =
  /** Every byte arrived and the copy is queued as a window File Transcription. */
  | { status: 'queued' }
  | { status: 'cancelled' }
  /** `message` is one finished sentence for the user. */
  | { status: 'failed'; message: string }

interface UploadOptions {
  signal?: AbortSignal
  /** Bytes sent so far: as the webview sends them, or after each acknowledged chunk. */
  onProgress?: (sent: number, size: number) => void
  /** Fallback chunk size. */
  chunkBytes?: number
}

type PutResult =
  | { status: 'received'; received: number }
  /** The main process answered no; `message` is for the user. */
  | { status: 'refused'; message: string }
  | { status: 'cancelled' }
  /** No answer: blocked by the webview, refused by CORS, or nothing listening. */
  | { status: 'unreachable'; sent: number }

function answer(status: number, text: string): PutResult {
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    /* not ours */
  }
  const reply = (body ?? {}) as {
    ok?: unknown
    received?: unknown
    message?: unknown
  }
  if (
    status === 200 &&
    reply.ok === true &&
    typeof reply.received === 'number'
  ) {
    return { status: 'received', received: reply.received }
  }
  return {
    status: 'refused',
    message:
      reply.ok === false && typeof reply.message === 'string'
        ? reply.message
        : DROPPED_FILE_SEND_FAILED,
  }
}

/** One `PUT` of the whole file. Never throws. */
function put<F extends DroppedFileSource>(
  file: F,
  target: DroppedFileUploadTarget,
  request: DroppedFileUploadRequest<F>,
  options: UploadOptions
): Promise<PutResult> {
  return new Promise((resolve) => {
    let sent = 0
    let settled = false
    const abort = () => request.abort()
    const settle = (result: PutResult) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    request.upload.addEventListener('progress', ({ loaded }) => {
      sent = loaded
      options.onProgress?.(loaded, file.size)
    })
    request.addEventListener('load', () =>
      settle(
        request.status === 0
          ? { status: 'unreachable', sent }
          : answer(request.status, request.responseText)
      )
    )
    request.addEventListener('error', () =>
      settle({ status: 'unreachable', sent })
    )
    request.addEventListener('timeout', () =>
      settle({ status: 'unreachable', sent })
    )
    request.addEventListener('abort', () => settle({ status: 'cancelled' }))
    try {
      request.open('PUT', target.url)
      request.setRequestHeader(DROPPED_FILE_UPLOAD_TOKEN_HEADER, target.token)
      options.signal?.addEventListener('abort', abort)
      request.send(file)
    } catch {
      settle({ status: 'unreachable', sent: 0 })
    }
  })
}

let warnedFallback = false

/**
 * Send `file` to the main process and have it queued. Never throws: every failure is a
 * `failed` result, and the main process's copy is gone by the time it resolves (it removes
 * the copy itself when it refuses a request; the page asks it to when the page gives up).
 */
export async function uploadDroppedFile<F extends DroppedFileSource>(
  file: F,
  transport: DroppedFileTransport<F>,
  options: UploadOptions = {}
): Promise<DroppedFileUploadResult> {
  const aborted = () => options.signal?.aborted === true
  if (aborted()) return { status: 'cancelled' }

  let begun: BeginDroppedFileReply
  try {
    begun = await transport.begin({ name: file.name, size: file.size })
  } catch {
    return { status: 'failed', message: DROPPED_FILE_SEND_FAILED }
  }
  if (!begun.ok) return { status: 'failed', message: begun.message }
  const { uploadId } = begun

  /** Best effort: a copy the main process cannot be told about is swept at its next boot. */
  const giveUp = async (result: DroppedFileUploadResult) => {
    try {
      await transport.cancel({ uploadId })
    } catch {
      /* the main process is gone or busy; its stale sweep removes the copy */
    }
    return result
  }

  if (aborted()) return giveUp({ status: 'cancelled' })
  let sentOverHttp = false
  if (begun.upload !== null) {
    const result = await put(
      file,
      begun.upload,
      transport.newUploadRequest(),
      options
    )
    switch (result.status) {
      case 'received':
        if (result.received !== file.size) {
          return giveUp({ status: 'failed', message: DROPPED_FILE_SEND_FAILED })
        }
        options.onProgress?.(file.size, file.size)
        sentOverHttp = true
        break
      case 'cancelled':
        return giveUp({ status: 'cancelled' })
      case 'refused':
        // The main process has already ended the upload; the cancel is for a wrong token.
        return giveUp({ status: 'failed', message: result.message })
      case 'unreachable':
        if (result.sent > 0) {
          return giveUp({ status: 'failed', message: DROPPED_FILE_SEND_FAILED })
        }
        break
    }
  }

  if (!sentOverHttp) {
    // Fallback, for a webview that will not let this page reach 127.0.0.1 (or a main process
    // that could not listen): the old RPC chunks. Nothing went over HTTP, so the copy is still
    // empty and expects its first byte. Delete this branch with `sendInChunks`.
    if (begun.upload !== null && !warnedFallback) {
      warnedFallback = true
      console.warn(
        'Dropped file upload could not reach the main process over HTTP; sending it over RPC.'
      )
    }
    const stopped = await sendInChunks(
      file,
      transport,
      uploadId,
      giveUp,
      options
    )
    if (stopped !== null) return stopped
  }

  if (aborted()) return giveUp({ status: 'cancelled' })
  let finished: FinishDroppedFileReply
  try {
    finished = await transport.finish({ uploadId })
  } catch {
    return giveUp({ status: 'failed', message: DROPPED_FILE_SEND_FAILED })
  }
  return finished.ok
    ? { status: 'queued' }
    : { status: 'failed', message: finished.message }
}

/**
 * The fallback: every byte over RPC, base64, one chunk awaited at a time. `null` once all are
 * in; otherwise the result to return, the main process's copy already gone.
 */
async function sendInChunks(
  file: DroppedFileSource,
  transport: Pick<DroppedFileTransport, 'append'>,
  uploadId: string,
  giveUp: (result: DroppedFileUploadResult) => Promise<DroppedFileUploadResult>,
  options: UploadOptions
): Promise<DroppedFileUploadResult | null> {
  const chunkBytes = Math.min(
    options.chunkBytes ?? DROPPED_FILE_CHUNK_BYTES,
    MAX_DROPPED_FILE_CHUNK_BYTES
  )
  let offset = 0
  while (offset < file.size) {
    if (options.signal?.aborted === true) return giveUp({ status: 'cancelled' })
    const end = Math.min(offset + chunkBytes, file.size)
    let data: string
    try {
      data = encodeBase64(
        new Uint8Array(await file.slice(offset, end).arrayBuffer())
      )
    } catch {
      return giveUp({ status: 'failed', message: DROPPED_FILE_READ_FAILED })
    }
    let reply: AppendDroppedFileChunkReply
    try {
      reply = await transport.append({ uploadId, offset, data })
    } catch {
      return giveUp({ status: 'failed', message: DROPPED_FILE_SEND_FAILED })
    }
    // A refusal has already ended the upload in the main process.
    if (!reply.ok) return { status: 'failed', message: reply.message }
    if (reply.received !== end) {
      return giveUp({ status: 'failed', message: DROPPED_FILE_SEND_FAILED })
    }
    offset = end
    options.onProgress?.(offset, file.size)
  }
  return null
}
