/**
 * Sending a file dropped on the window to the main process, from the page.
 *
 * Neither WKWebView (macOS) nor WebView2 (Windows) tells a page where a dropped file is on
 * disk, and Electrobun 1.18 has no native file-drop API. Both do hand the page a `File`, so
 * the page reads it in pieces and sends the bytes over RPC; the main process writes them to a
 * temporary copy and queues that (src/bun/window-file-transcriptions/dropped-files.ts).
 *
 * One chunk at a time: each `appendDroppedFileChunk` is awaited before the next is read, so
 * neither side ever holds more than one chunk of a large video. Electrobun's RPC is JSON,
 * so a chunk travels as base64.
 *
 * No DOM or Node APIs beyond `Blob` and `btoa`, which the webviews and Bun all have, so it
 * is tested in Bun (dropped-file-upload.test.ts).
 */

import type {
  AppendDroppedFileChunkReply,
  BeginDroppedFileReply,
  FinishDroppedFileReply,
} from './types'

/**
 * Bytes per chunk the page sends. 2 MiB keeps the round trips few on a large video while
 * Electrobun's per-message encryption (a byte-at-a-time base64 loop in its preload) stays
 * well inside the RPC request timeout (`maxRequestTime` in src/mainview/rpc.ts).
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

/** The four `bun` requests, as the page's RPC bridge exposes them. */
export interface DroppedFileTransport {
  begin(params: { name: string; size: number }): Promise<BeginDroppedFileReply>
  append(params: {
    uploadId: string
    offset: number
    data: string
  }): Promise<AppendDroppedFileChunkReply>
  finish(params: { uploadId: string }): Promise<FinishDroppedFileReply>
  cancel(params: { uploadId: string }): Promise<boolean>
}

/** What `uploadDroppedFile` reads of a `File`. */
export interface DroppedFileSource {
  name: string
  size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

export type DroppedFileUploadResult =
  /** Every byte arrived and the copy is queued as a window File Transcription. */
  | { status: 'queued' }
  | { status: 'cancelled' }
  /** `message` is one finished sentence for the user. */
  | { status: 'failed'; message: string }

/**
 * Send `file` to the main process and have it queued. Never throws: every failure is a
 * `failed` result, and the main process's copy is gone by the time it resolves (it removes
 * the copy itself when it refuses a request; the page asks it to when the page gives up).
 */
export async function uploadDroppedFile(
  file: DroppedFileSource,
  transport: DroppedFileTransport,
  options: {
    signal?: AbortSignal
    /** After each chunk the main process acknowledged. */
    onProgress?: (sent: number, size: number) => void
    chunkBytes?: number
  } = {}
): Promise<DroppedFileUploadResult> {
  const chunkBytes = Math.min(
    options.chunkBytes ?? DROPPED_FILE_CHUNK_BYTES,
    MAX_DROPPED_FILE_CHUNK_BYTES
  )
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

  let offset = 0
  while (offset < file.size) {
    if (aborted()) return giveUp({ status: 'cancelled' })
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
