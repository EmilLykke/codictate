/**
 * NDJSON protocol for a persistent Parakeet batch-transcription session.
 *
 * The ordinary `transcribe <wavPath> <modelDir>` command stays one-shot for Dictation.
 * The benchmark uses `transcribe-session <modelDir>` so one Native Helper can load the
 * Speech Model once and answer several sequential Sample requests.
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
