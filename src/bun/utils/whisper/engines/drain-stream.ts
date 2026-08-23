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
  stream: ReadableStream<Uint8Array> | undefined
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(value)
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
