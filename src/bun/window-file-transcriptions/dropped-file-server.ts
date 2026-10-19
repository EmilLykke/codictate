/**
 * The loopback endpoint a file dropped on the window is uploaded to.
 *
 * Electrobun's RPC is the wrong pipe for a video: every message is JSON, AES-GCM encrypted
 * and base64'd with a byte-at-a-time loop in the page, then decoded the same way in Bun,
 * so a large file took hundreds of slow round trips. Instead the page `PUT`s the `File`
 * itself as one request body (src/shared/dropped-file-upload.ts), which WebKit and WebView2
 * stream from disk, and `dropped-files.ts` streams it into the copy.
 *
 * - **Loopback only.** Bound to `127.0.0.1` on a port the OS picks, started on the first
 *   drop and stopped at quit. Nothing off this machine can connect.
 * - **One secret per upload.** `begin` (over the encrypted RPC) hands the page the URL and a
 *   32-byte token, which the request carries in `DROPPED_FILE_UPLOAD_TOKEN_HEADER`. Another
 *   local process can reach the port but cannot add or spoil a file without it. An unknown
 *   upload and a wrong token get the same 404, and nothing from the request is echoed.
 * - **CORS.** The page's origin is `views://` (or Vite's `http://localhost:5173` under HMR),
 *   so the token header makes the request preflighted. Any origin is allowed, since the
 *   token is the check; `Access-Control-Allow-Private-Network` answers WebView2's (Chromium's)
 *   Private Network Access preflight.
 *
 * Same on macOS and Windows: Bun's server and the webviews' `XMLHttpRequest`, no native
 * code. Windows caveat: whether WebView2 lets a `views://` page reach `127.0.0.1` depends on
 * its Private Network Access rules, unverified on real hardware; the page falls back to the
 * RPC chunks when the request never gets through.
 *
 * `handle` is a plain `Request -> Response` over the dropped-files state, and `listen` is
 * injected, so it is tested with no socket (dropped-file-server.test.ts).
 */

import {
  DROPPED_FILE_UPLOAD_PATH,
  DROPPED_FILE_UPLOAD_TOKEN_HEADER,
} from '../../shared/dropped-file-upload'
import type { BeginDroppedFileReply } from '../../shared/types'
import type { DroppedFiles } from './dropped-files'

/** A running server: the port it got, and how to stop it. */
export interface DroppedFileListener {
  port: number
  stop(): void
}

export interface DroppedFileServerDeps {
  droppedFiles: DroppedFiles
  /** `listenOnLoopback` in production. Throws when it cannot listen. */
  listen(handle: (request: Request) => Promise<Response>): DroppedFileListener
  log(message: string, data?: Record<string, unknown>): void
}

export interface DroppedFileServer {
  /** `droppedFiles.begin`, plus where to send the bytes; `upload: null` when not listening. */
  begin(params: { name: string; size: number }): Promise<BeginDroppedFileReply>
  handle(request: Request): Promise<Response>
  /** For quitting. A request in flight is cut off; `removeAll` deletes its copy. */
  stop(): void
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
} as const

const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  'Access-Control-Allow-Methods': 'PUT',
  'Access-Control-Allow-Headers': `${DROPPED_FILE_UPLOAD_TOKEN_HEADER}, content-type`,
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
} as const

const NOT_FOUND = "That file isn't being added anymore."

function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extra,
    },
  })
}

/** `Content-Length` as a byte count; `null` when absent (a chunked body) or not a number. */
function declaredLength(request: Request): number | null {
  const value = request.headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return null
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : null
}

export function createDroppedFileServer(
  deps: DroppedFileServerDeps
): DroppedFileServer {
  let listener: DroppedFileListener | null = null

  /** Started on first use, so a session with no drops opens no port. */
  function port(): number | null {
    if (listener === null) {
      try {
        listener = deps.listen(handle)
        deps.log('dropped file uploads listening', { port: listener.port })
      } catch (err) {
        deps.log('could not listen for dropped files', { err: String(err) })
        return null
      }
    }
    return listener.port
  }

  async function begin(params: {
    name: string
    size: number
  }): Promise<BeginDroppedFileReply> {
    const begun = await deps.droppedFiles.begin(params)
    if (!begun.ok) return begun
    const at = port()
    return {
      ok: true,
      uploadId: begun.uploadId,
      upload:
        at === null
          ? null
          : {
              url: `http://127.0.0.1:${at}${DROPPED_FILE_UPLOAD_PATH}${encodeURIComponent(begun.uploadId)}`,
              token: begun.token,
            },
    }
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (!pathname.startsWith(DROPPED_FILE_UPLOAD_PATH)) {
      return json(404, { ok: false, message: NOT_FOUND })
    }
    let uploadId: string
    try {
      uploadId = decodeURIComponent(
        pathname.slice(DROPPED_FILE_UPLOAD_PATH.length)
      )
    } catch {
      return json(404, { ok: false, message: NOT_FOUND })
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS })
    }
    if (request.method !== 'PUT') {
      return json(
        405,
        { ok: false, message: NOT_FOUND },
        { Allow: 'PUT, OPTIONS' }
      )
    }
    const received = await deps.droppedFiles.receive({
      uploadId,
      token: request.headers.get(DROPPED_FILE_UPLOAD_TOKEN_HEADER) ?? '',
      declaredLength: declaredLength(request),
      body: request.body,
    })
    if (received.ok) return json(200, received)
    return json(received.reason === 'unknown' ? 404 : 400, {
      ok: false,
      message: received.message,
    })
  }

  function stop(): void {
    listener?.stop()
    listener = null
  }

  return { begin, handle, stop }
}

/**
 * Bun's HTTP server on `127.0.0.1` only, at a port the OS picks. Never bind a wider address.
 * Bun refuses bodies over 128 MB by default; the size check is the upload's own, so the limit
 * is lifted. `idleTimeout` (seconds, Bun's maximum is 255) is how long a stalled page may go
 * without sending before its connection is dropped and its copy deleted.
 */
export function listenOnLoopback(
  handle: (request: Request) => Promise<Response>
): DroppedFileListener {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    idleTimeout: 60,
    fetch: handle,
    error: () =>
      new Response(null, { status: 500, headers: { ...CORS_HEADERS } }),
  })
  if (server.port === undefined) {
    void server.stop(true)
    throw new Error('no port')
  }
  return { port: server.port, stop: () => void server.stop(true) }
}
