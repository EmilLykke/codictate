/**
 * Read a subprocess pipe to completion.
 *
 * Must run concurrently with `proc.exited` or the child can deadlock once the pipe buffer
 * fills - Core ML / FluidAudio is verbose on stderr, and crispasr is verbose on both.
 *
 * One copy. This was written twice, character-identical, in the app's transcribe path and
 * in the benchmark's, which is the duplication ADR-0006 is about: the benchmark
 * re-implemented four pieces of the engine invocation because it could not reuse any of it.
 */
export async function drainReadableStream(
  stream: ReadableStream<Uint8Array> | undefined,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const aborted = Symbol('aborted')
  let resolveAbort: ((value: typeof aborted) => void) | undefined
  const abortPromise = new Promise<typeof aborted>((resolve) => {
    resolveAbort = resolve
  })
  const onAbort = () => resolveAbort?.(aborted)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (!signal?.aborted) {
      const read = reader.read()
      const next = signal
        ? await Promise.race([read, abortPromise])
        : await read
      if (next === aborted) break
      if (next.done) break
      if (next.value?.length) chunks.push(next.value)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted) {
      // A Bun pipe normally settles its pending read when cancelled. Do not await that
      // contract here: an uncooperative stream is exactly what process supervision has to
      // make bounded, and cancellation itself is allowed to return a pending promise.
      try {
        void reader.cancel().catch(() => {})
      } catch {
        // The reader may already have released itself as the process exited.
      }
    }
    try {
      reader.releaseLock()
    } catch {
      // A pending read can retain the lock until cancellation settles. Nothing else uses
      // this process pipe, so retaining it is preferable to waiting without a bound.
    }
  }
  const len = chunks.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/**
 * Decode engine stdout, or `null` when the bytes are not UTF-8.
 *
 * Fatal on purpose. Both adapters force `LC_ALL`/`LANG` to `en_US.UTF-8` precisely so the
 * engine prints UTF-8, and the whole stream is concatenated before decoding, so there is no
 * chunk boundary to blame: invalid bytes here mean the engine is not producing the text it
 * was asked for. Replacing them with `U+FFFD` and pasting the result is the same class of
 * quiet wrongness as pasting a crashed engine's empty stdout.
 */
export function decodeEngineStdout(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Decode engine stderr for the log. Lenient: log noise is not worth failing a Dictation over. */
export function decodeEngineStderr(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * The last few lines of engine stderr, for a failure's `diagnostic`.
 *
 * The tail rather than the head: crispasr and the Parakeet Native Helper both print progress
 * before they print what went wrong, so the first 500 bytes are model-load chatter and the
 * last few lines are the reason.
 */
export function stderrTail(stderrText: string, maxChars = 600): string {
  const trimmed = stderrText.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `...${trimmed.slice(-maxChars)}`
}
