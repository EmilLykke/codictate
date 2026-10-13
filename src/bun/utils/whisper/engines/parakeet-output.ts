/**
 * The Parakeet Native Helper's batch output: NDJSON on stdout, one object per
 * line, of which only `{"kind":"final","text":...}` carries the transcript.
 * Everything else on that stream - progress objects, log noise from the model
 * runtime - is skipped rather than trusted to be JSON at all.
 *
 * The app and the benchmark both spawn that helper, so the protocol is read in
 * one place. Pure over the stdout string: no spawn, no path, no decoder.
 */

/** One timed item of a `final` line's `timing`, in seconds from the start of the audio. */
export interface ParakeetTimedItem {
  text: string
  start: number
  end: number
}

/**
 * The optional `timing` of a batch `final` line (`src/shared/command-line-protocol.ts`):
 * - `spoken-word` (macOS): the words as the model spoke them, before inverse text
 *   normalization, so they need lining up with the written Raw Transcript;
 * - `sentence` (Windows): spans of the Raw Transcript as written.
 */
export interface ParakeetTiming {
  unit: 'spoken-word' | 'sentence'
  items: ParakeetTimedItem[]
}

export interface ParakeetFinal {
  text: string
  /** `null` when the line had none, or one this reader does not understand. */
  timing: ParakeetTiming | null
}

/** One parsed object per line that is JSON; noise lines are skipped. */
function* jsonLines(stdout: string): Generator<unknown> {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed) as unknown
    } catch {
      // ignore non-JSON
    }
  }
}

function finalTextOf(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null) return null
  const { kind, text } = obj as { kind?: unknown; text?: unknown }
  return kind === 'final' && typeof text === 'string' ? text : null
}

function isTimedItem(value: unknown): value is ParakeetTimedItem {
  if (typeof value !== 'object' || value === null) return false
  const { text, start, end } = value as Record<string, unknown>
  return (
    typeof text === 'string' &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end)
  )
}

/** The `timing` field, or `null` when it is absent or not a shape this reader knows. */
function timingOf(obj: object): ParakeetTiming | null {
  const timing = (obj as { timing?: unknown }).timing
  if (typeof timing !== 'object' || timing === null) return null
  const { unit, items } = timing as { unit?: unknown; items?: unknown }
  if (unit !== 'spoken-word' && unit !== 'sentence') return null
  if (!Array.isArray(items) || !items.every(isTimedItem)) return null
  return {
    unit,
    items: items.map(({ text, start, end }) => ({ text, start, end })),
  }
}

/**
 * The text of the first `final` line, or `null` when the stream had none.
 *
 * `null` is not the empty string. A helper that finished and heard nothing
 * emits `final` with an empty text, which is a silent Dictation; a helper that
 * emitted no `final` at all died or changed protocol, which is a failure.
 */
export function parseParakeetFinalText(stdout: string): string | null {
  return parseParakeetFinal(stdout)?.text ?? null
}

/**
 * The first `final` line with its optional `timing`, or `null` when the stream had none
 * (the same `null` as `parseParakeetFinalText`). A `timing` that is missing, from an older
 * helper, or malformed reads as `timing: null`: the transcript still counts, only untimed.
 */
export function parseParakeetFinal(stdout: string): ParakeetFinal | null {
  for (const obj of jsonLines(stdout)) {
    const text = finalTextOf(obj)
    if (text !== null) return { text, timing: timingOf(obj as object) }
  }
  return null
}
