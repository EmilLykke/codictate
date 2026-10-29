/**
 * NDJSON protocol for a persistent Parakeet batch-transcription session.
 *
 * `transcribe-session <modelDir>` loads the Speech Model, writes `ready`, then answers each
 * `{id, audioPath}` line on stdin with a `final` line, and exits when stdin closes. A Batch
 * Dictation spawns one when its recording starts, so the model loads while the user speaks,
 * and sends it one request (`src/bun/utils/whisper/engines/parakeet-session.ts`). The
 * benchmark uses it to load once and answer several sequential Sample requests. The one-shot
 * `transcribe <wavPath> <modelDir>` stays for File Transcription and the command line.
 *
 * A `final` carries the same text (after inverse text normalization) and the same optional
 * `timing` as the one-shot `final`; `parseParakeetFinal` in `parakeet-output.ts` reads the
 * timing, so there is one reader for it.
 */

export const PARAKEET_TRANSCRIBE_SESSION_COMMAND = 'transcribe-session'

export interface ParakeetSessionRequest {
  /** Correlates a response with the request that produced it. */
  id: number
  audioPath: string
}

export type ParakeetSessionResponse =
  { kind: 'ready' } | { kind: 'final'; id: number; text: string }

export function encodeParakeetSessionRequest(
  request: ParakeetSessionRequest
): string {
  if (!Number.isSafeInteger(request.id) || request.id < 0) {
    throw new RangeError(
      'Parakeet session request id must be a non-negative safe integer'
    )
  }
  return JSON.stringify(request)
}

/** Parse one stdout line without accepting a response the session cannot correlate. */
export function parseParakeetSessionResponse(
  line: string
): ParakeetSessionResponse | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'ready') return { kind: 'ready' }
  if (
    record.kind === 'final' &&
    Number.isSafeInteger(record.id) &&
    (record.id as number) >= 0 &&
    typeof record.text === 'string'
  ) {
    return { kind: 'final', id: record.id as number, text: record.text }
  }
  return null
}
