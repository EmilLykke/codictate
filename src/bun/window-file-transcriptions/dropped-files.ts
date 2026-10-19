/**
 * Files dropped on Codictate's window, received as bytes.
 *
 * Neither WKWebView nor WebView2 tells the page where a dropped file is on disk, and
 * Electrobun 1.18 has no native file-drop API, so the page sends the file's bytes
 * (src/shared/dropped-file-upload.ts). They come in one HTTP `PUT` to a loopback-only
 * endpoint (dropped-file-server.ts), streamed into the copy by `receive`, because
 * Electrobun's RPC moves bytes one at a time through JSON, AES-GCM and base64 on both ends.
 * The RPC chunks (`append`) survive only as the page's fallback for when the webview cannot
 * reach that endpoint. Each upload gets its own temporary directory holding one file under
 * the original name, made safe for the file system, so the Media Native Helper still sees
 * the extension. When every byte is in, the copy is queued as a window File Transcription
 * with no source folder (`sourcePath: null`): Transcript Export and History never see the
 * temporary path.
 *
 * The copy is deleted, directory and all, when its File Transcription settles (done, failed
 * or cancelled), when the upload is cancelled or refused, when the page stops sending for
 * `ABANDONED_UPLOAD_MS`, and at quit (`removeAll`). Copies a crash left behind are swept at
 * the next boot, like the queue's work directories (file-transcription/work-dirs.ts).
 *
 * Same on macOS and Windows. On Windows an open file cannot be deleted, so the write handle
 * is always closed before its directory is removed.
 *
 * Tested hermetically against an isolated temp directory (dropped-files.test.ts).
 */

import { closeSync, mkdtempSync, rmSync } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { removeStaleDirs } from '../file-transcription/work-dirs'
import { MAX_DROPPED_FILE_CHUNK_BYTES } from '../../shared/dropped-file-upload'
import type {
  AppendDroppedFileChunkReply,
  FinishDroppedFileReply,
} from '../../shared/types'

export const DROPPED_FILE_DIR_PREFIX = 'codictate-dropped-file-'

/** `mkdtemp` appends six characters; anything else with the prefix is not ours. */
const DROPPED_FILE_DIR_NAME = /^codictate-dropped-file-[A-Za-z0-9]{6}$/

export function isDroppedFileDirName(name: string): boolean {
  return DROPPED_FILE_DIR_NAME.test(name)
}

/** Files being received at once. The page sends one at a time; this guards the disk. */
export const MAX_CONCURRENT_UPLOADS = 4

/**
 * An upload with no bytes for this long is taken as abandoned (the page reloaded or closed).
 * One being streamed in is never abandoned, however long it takes.
 */
export const ABANDONED_UPLOAD_MS = 2 * 60 * 1000

/** How often uploads are checked for abandonment while any exist. */
export const ABANDONED_CHECK_MS = 30 * 1000

const GONE = "That file isn't being added anymore."
const BUSY =
  'Codictate is already adding several files. Try again when they are in.'
const BROKEN = "That file didn't arrive in one piece. Try dropping it again."
const FAILED = "Couldn't add that file."
const NO_SPACE = "There isn't enough free space to add that file."

/** Used when a name has nothing usable left. */
const FALLBACK_NAME = 'Dropped file'
/** Bytes, well under the 255 both macOS and NTFS allow. */
const MAX_NAME_BYTES = 200
const MAX_EXTENSION_LENGTH = 16
/** Windows refuses these as file names, with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** The last path segment of `name`, with control characters dropped. */
function lastSegment(name: string): string {
  const segments = name.split(/[/\\]/)
  return Array.from(segments[segments.length - 1] ?? '')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
    .join('')
}

function truncateToBytes(text: string, maxBytes: number): string {
  let out = ''
  for (const char of text) {
    if (Buffer.byteLength(out + char) > maxBytes) break
    out += char
  }
  return out
}

/** The name the user knows the file by, for the page and History. */
export function droppedFileDisplayName(name: string): string {
  const shown = lastSegment(name).trim()
  return shown === '' ? FALLBACK_NAME : truncateToBytes(shown, 255)
}

/**
 * `name` as a file name both macOS and Windows accept, extension kept: only the last path
 * segment, no control characters or `<>:"|?*`, no trailing dots or spaces, never a Windows
 * device name, at most `MAX_NAME_BYTES`. Ordinary names come through unchanged.
 */
export function droppedFileName(name: string): string {
  let clean = lastSegment(name)
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
  if (clean === '') return FALLBACK_NAME
  if (WINDOWS_RESERVED_NAME.test(clean)) clean = `_${clean}`
  if (Buffer.byteLength(clean) > MAX_NAME_BYTES) {
    const dot = clean.lastIndexOf('.')
    const extension =
      dot > 0 && clean.length - dot <= MAX_EXTENSION_LENGTH
        ? clean.slice(dot)
        : ''
    const stem = clean.slice(0, clean.length - extension.length)
    clean =
      truncateToBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(extension)) +
      extension
  }
  return clean
}

/** Base64 as the page's `encodeBase64` writes it: padded, no whitespace. */
function isBase64(data: string): boolean {
  return data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
}

const MAX_CHUNK_BASE64_LENGTH = Math.ceil(MAX_DROPPED_FILE_CHUNK_BYTES / 3) * 4

/** Write all of `bytes` at `position`: a positional write may take only part of them. */
async function writeAt(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number
): Promise<void> {
  let written = 0
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written
    )
    if (bytesWritten <= 0) throw new Error('no bytes written')
    written += bytesWritten
  }
}

/** Constant time, so a wrong guess learns nothing about how close it came. */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

function writeFailureMessage(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : null
  return code === 'ENOSPC' ? NO_SPACE : FAILED
}

export interface DroppedFilesDeps {
  /** Where each upload gets its own directory: the system temp folder in production. */
  parentDir: string
  /**
   * Queue the finished copy as a window File Transcription with no source folder. Resolves
   * once that job has settled and History has had its say: the copy is deleted then.
   */
  transcribe(copy: { filePath: string; fileName: string }): Promise<void>
  now(): number
  log(message: string, data?: Record<string, unknown>): void
  /** Injected in tests. */
  newUploadId?(): string
  /** Injected in tests. 32 random bytes, hex, in production. */
  newToken?(): string
  /** Injected in tests. A one-shot timer that returns its cancel; `setTimeout` in production. */
  setTimer?(callback: () => void, ms: number): () => void
}

/**
 * A started upload. `token` is the secret its bytes must carry (`receive`): only the page,
 * which got it over the encrypted RPC, knows it.
 */
export type BegunDroppedFile =
  { ok: true; uploadId: string; token: string } | { ok: false; message: string }

/**
 * `unknown`: no such upload, or the wrong token, answered alike so a guess learns nothing;
 * the upload, if there is one, is left alone. `refused`: the upload has ended and its copy
 * is gone.
 */
export type ReceivedDroppedFile =
  | { ok: true; received: number }
  | { ok: false; reason: 'unknown' | 'refused'; message: string }

export interface DroppedFiles {
  begin(params: { name: string; size: number }): Promise<BegunDroppedFile>
  /**
   * Every byte of the file in one stream, from the first: the HTTP body of the page's `PUT`.
   * `declaredLength` is its `Content-Length`, when it had one. Refused unless exactly the
   * size given to `begin` arrives.
   */
  receive(params: {
    uploadId: string
    token: string
    declaredLength: number | null
    body: ReadableStream<Uint8Array> | null
  }): Promise<ReceivedDroppedFile>
  /** The next piece, base64, over RPC: the page's fallback when it cannot use `receive`. */
  append(params: {
    uploadId: string
    offset: number
    data: string
  }): Promise<AppendDroppedFileChunkReply>
  finish(params: { uploadId: string }): Promise<FinishDroppedFileReply>
  /** Stop receiving and delete what arrived. `false` when there is no such upload. */
  cancel(params: { uploadId: string }): Promise<boolean>
  /**
   * Delete every copy, being received or queued, synchronously: for quitting, after the
   * queue has cancelled its jobs. A copy Windows still holds open is left to the boot sweep.
   */
  removeAll(): void
  /**
   * Called, synchronously and once per upload, when an upload stops being received: finished,
   * cancelled, refused, abandoned or removed at quit. The upload server closes its port on it.
   */
  onUploadEnded(listener: (uploadId: string) => void): void
}

interface Upload {
  id: string
  token: string
  dir: string
  filePath: string
  fileName: string
  size: number
  received: number
  handle: FileHandle | null
  /** A write (or the open) is in flight. */
  busy: boolean
  /** Cancelled while busy: the in-flight request cleans up when it returns. */
  cancelled: boolean
  /** Stops a `receive` in flight, even one waiting for the page's next bytes. */
  stopStream: (() => void) | null
  lastActivity: number
}

export function createDroppedFiles(deps: DroppedFilesDeps): DroppedFiles {
  const newUploadId = deps.newUploadId ?? (() => randomUUID())
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'))
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return () => clearTimeout(timer)
    })
  /** Being received. */
  const uploads = new Map<string, Upload>()
  /** Finished and queued: the directories to delete once their jobs settle. */
  const queued = new Set<string>()
  const endedListeners: ((uploadId: string) => void)[] = []
  /** Cancels the pending abandonment check; `null` when none is pending. */
  let cancelCheck: (() => void) | null = null

  try {
    const removed = removeStaleDirs(deps.parentDir, isDroppedFileDirName, {
      now: deps.now(),
    })
    if (removed.length > 0) {
      deps.log('removed stale dropped files', { count: removed.length })
    }
  } catch (err) {
    deps.log('could not remove stale dropped files', { err: String(err) })
  }

  async function removeDir(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      deps.log('could not remove a dropped file', { err: String(err) })
    }
  }

  /** Stop receiving `upload`, telling the listeners the first time only. */
  function end(upload: Upload): void {
    if (uploads.get(upload.id) !== upload) return
    uploads.delete(upload.id)
    if (uploads.size === 0) {
      cancelCheck?.()
      cancelCheck = null
    }
    for (const listener of endedListeners) listener(upload.id)
  }

  async function discard(upload: Upload, reason: string): Promise<void> {
    end(upload)
    const handle = upload.handle
    upload.handle = null
    try {
      await handle?.close()
    } catch {
      /* already closed */
    }
    await removeDir(upload.dir)
    deps.log('dropped file discarded', {
      reason,
      received: upload.received,
      size: upload.size,
    })
  }

  function sweepAbandoned(): void {
    const now = deps.now()
    for (const upload of [...uploads.values()]) {
      if (!upload.busy && now - upload.lastActivity >= ABANDONED_UPLOAD_MS) {
        void discard(upload, 'abandoned')
      }
    }
  }

  /**
   * Check for abandoned uploads every `ABANDONED_CHECK_MS` while any exist, so one the page
   * left behind ends without waiting for the next drop.
   */
  function watchForAbandoned(): void {
    if (cancelCheck !== null || uploads.size === 0) return
    cancelCheck = setTimer(() => {
      cancelCheck = null
      sweepAbandoned()
      watchForAbandoned()
    }, ABANDONED_CHECK_MS)
  }

  async function begin({
    name,
    size,
  }: {
    name: string
    size: number
  }): Promise<BegunDroppedFile> {
    sweepAbandoned()
    if (typeof name !== 'string' || !Number.isSafeInteger(size) || size < 0) {
      return { ok: false, message: FAILED }
    }
    if (uploads.size >= MAX_CONCURRENT_UPLOADS) {
      return { ok: false, message: BUSY }
    }
    let dir: string
    try {
      dir = mkdtempSync(join(deps.parentDir, DROPPED_FILE_DIR_PREFIX))
    } catch (err) {
      deps.log('could not make a dropped file directory', { err: String(err) })
      return { ok: false, message: writeFailureMessage(err) }
    }
    // Hold the slot while the file opens, so concurrent begins respect the cap.
    const upload: Upload = {
      id: newUploadId(),
      token: newToken(),
      dir,
      filePath: join(dir, droppedFileName(name)),
      fileName: droppedFileDisplayName(name),
      size,
      received: 0,
      handle: null,
      busy: true,
      cancelled: false,
      stopStream: null,
      lastActivity: deps.now(),
    }
    uploads.set(upload.id, upload)
    watchForAbandoned()
    try {
      upload.handle = await open(upload.filePath, 'wx')
    } catch (err) {
      await discard(upload, 'open failed')
      return { ok: false, message: writeFailureMessage(err) }
    }
    upload.busy = false
    if (upload.cancelled) {
      await discard(upload, 'cancelled')
      return { ok: false, message: GONE }
    }
    deps.log('dropped file started', { size })
    return { ok: true, uploadId: upload.id, token: upload.token }
  }

  async function receive({
    uploadId,
    token,
    declaredLength,
    body,
  }: {
    uploadId: string
    token: string
    declaredLength: number | null
    body: ReadableStream<Uint8Array> | null
  }): Promise<ReceivedDroppedFile> {
    const upload = uploads.get(uploadId)
    if (
      upload === undefined ||
      typeof token !== 'string' ||
      !tokenMatches(upload.token, token)
    ) {
      return { ok: false, reason: 'unknown', message: GONE }
    }
    const refuse = async (
      reason: string,
      message: string
    ): Promise<ReceivedDroppedFile> => {
      await discard(upload, reason)
      return { ok: false, reason: 'refused', message }
    }
    // Like `append`, every refusal ends the upload: a copy that went wrong once is not trusted.
    if (upload.busy || upload.received !== 0) {
      return refuse('second stream', BROKEN)
    }
    if (declaredLength !== null && declaredLength !== upload.size) {
      return refuse('wrong length', BROKEN)
    }

    upload.busy = true
    const reader = body?.getReader() ?? null
    upload.stopStream = () => void reader?.cancel().catch(() => {})
    let failure: { reason: string; message: string } | null = null
    while (reader !== null && !upload.cancelled) {
      // A throw is the page going away mid-file (closed, reloaded, or `xhr.abort()`).
      const next = await reader.read().catch(() => null)
      if (next === null) {
        failure = { reason: 'stream broke', message: BROKEN }
        break
      }
      if (next.done) break
      const bytes = next.value
      if (upload.received + bytes.length > upload.size) {
        failure = { reason: 'oversize', message: BROKEN }
        break
      }
      try {
        await writeAt(upload.handle!, bytes, upload.received)
      } catch (err) {
        failure = upload.cancelled
          ? null
          : { reason: 'write failed', message: writeFailureMessage(err) }
        break
      }
      upload.received += bytes.length
      upload.lastActivity = deps.now()
    }
    upload.busy = false
    upload.stopStream = null

    if (
      upload.cancelled ||
      failure !== null ||
      upload.received !== upload.size
    ) {
      // Stop reading what is left; Bun answers once this returns.
      void reader?.cancel().catch(() => {})
      if (upload.cancelled) return refuse('cancelled', GONE)
      return failure !== null
        ? refuse(failure.reason, failure.message)
        : refuse('short', BROKEN)
    }
    return { ok: true, received: upload.received }
  }

  async function append({
    uploadId,
    offset,
    data,
  }: {
    uploadId: string
    offset: number
    data: string
  }): Promise<AppendDroppedFileChunkReply> {
    const upload = uploads.get(uploadId)
    if (upload === undefined) return { ok: false, message: GONE }
    // Every refusal ends the upload: the page sends in order, so one wrong chunk means the
    // copy can no longer be trusted.
    if (upload.busy || offset !== upload.received) {
      await discard(upload, 'wrong offset')
      return { ok: false, message: BROKEN }
    }
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > MAX_CHUNK_BASE64_LENGTH ||
      !isBase64(data)
    ) {
      await discard(upload, 'bad chunk')
      return { ok: false, message: BROKEN }
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0 || upload.received + bytes.length > upload.size) {
      await discard(upload, 'oversize')
      return { ok: false, message: BROKEN }
    }
    upload.busy = true
    try {
      await writeAt(upload.handle!, bytes, offset)
    } catch (err) {
      upload.busy = false
      const cancelled = upload.cancelled
      await discard(upload, cancelled ? 'cancelled' : 'write failed')
      return {
        ok: false,
        message: cancelled ? GONE : writeFailureMessage(err),
      }
    }
    upload.busy = false
    if (upload.cancelled) {
      await discard(upload, 'cancelled')
      return { ok: false, message: GONE }
    }
    upload.received += bytes.length
    upload.lastActivity = deps.now()
    return { ok: true, received: upload.received }
  }

  async function finish({
    uploadId,
  }: {
    uploadId: string
  }): Promise<FinishDroppedFileReply> {
    const upload = uploads.get(uploadId)
    if (upload === undefined) return { ok: false, message: GONE }
    if (upload.busy || upload.received !== upload.size) {
      await discard(upload, 'incomplete')
      return { ok: false, message: BROKEN }
    }
    end(upload)
    const handle = upload.handle
    upload.handle = null
    try {
      await handle?.close()
    } catch (err) {
      await removeDir(upload.dir)
      deps.log('could not close a dropped file', { err: String(err) })
      return { ok: false, message: writeFailureMessage(err) }
    }
    queued.add(upload.dir)
    const forget = () => {
      queued.delete(upload.dir)
      return removeDir(upload.dir)
    }
    let settled: Promise<void>
    try {
      settled = deps.transcribe({
        filePath: upload.filePath,
        fileName: upload.fileName,
      })
    } catch (err) {
      deps.log('could not queue a dropped file', { err: String(err) })
      await forget()
      return { ok: false, message: FAILED }
    }
    void settled
      .catch((err) => deps.log('dropped file job failed', { err: String(err) }))
      .then(forget)
    deps.log('dropped file queued', { size: upload.size })
    return { ok: true }
  }

  async function cancel({ uploadId }: { uploadId: string }): Promise<boolean> {
    const upload = uploads.get(uploadId)
    if (upload === undefined) return false
    if (upload.busy) {
      // The request in flight sees this and cleans up when it returns.
      upload.cancelled = true
      end(upload)
      upload.stopStream?.()
      return true
    }
    await discard(upload, 'cancelled')
    return true
  }

  function removeAll(): void {
    const dirs = [...queued]
    for (const upload of uploads.values()) {
      if (upload.handle !== null) {
        try {
          closeSync(upload.handle.fd)
        } catch {
          /* already closed */
        }
      }
      dirs.push(upload.dir)
    }
    for (const upload of [...uploads.values()]) end(upload)
    queued.clear()
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* still open (Windows): the next boot's sweep removes it */
      }
    }
  }

  function onUploadEnded(listener: (uploadId: string) => void): void {
    endedListeners.push(listener)
  }

  return { begin, receive, append, finish, cancel, removeAll, onUploadEnded }
}
