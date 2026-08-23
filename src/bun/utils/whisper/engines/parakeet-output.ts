/**
 * The Parakeet Native Helper's batch output: NDJSON on stdout, one object per
 * line, of which only `{"kind":"final","text":...}` carries the transcript.
 * Everything else on that stream - progress objects, log noise from the model
 * runtime - is skipped rather than trusted to be JSON at all.
 *
 * The app and the benchmark both spawn that helper, so the protocol is read in
 * one place. Pure over the stdout string: no spawn, no path, no decoder.
 */

/**
 * The text of the first `final` line, or `null` when the stream had none.
 *
 * `null` is not the empty string. A helper that finished and heard nothing
 * emits `final` with an empty text, which is a silent Dictation; a helper that
 * emitted no `final` at all died or changed protocol, which is a failure.
 */
export function parseParakeetFinalText(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { kind?: string; text?: string }
      if (obj.kind === 'final' && typeof obj.text === 'string') {
        return obj.text
      }
    } catch {
      // ignore non-JSON
    }
  }
  return null
}
