/**
 * Turns the bytes of one command-line connection into NDJSON lines.
 *
 * A socket chunk can end anywhere: mid-line, or in the middle of a multi-byte UTF-8
 * character. The streaming decoder holds back an incomplete character and the buffer holds
 * back an incomplete line, so neither reaches the session half-read.
 */

/** No request or control line comes close; a peer that sends this much without a newline is not the client. */
export const MAX_LINE_BYTES = 1024 * 1024

export class LineTooLongError extends Error {
  constructor() {
    super(`A line is longer than ${MAX_LINE_BYTES} bytes`)
  }
}

export class NdjsonLineSplitter {
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''

  constructor(private readonly maxLineLength = MAX_LINE_BYTES) {}

  /** The complete lines in this chunk, without their `\n` (or `\r\n`). Blank lines are dropped. */
  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === 'string'
        ? chunk
        : this.decoder.decode(chunk, { stream: true })
    const lines: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length > 0) lines.push(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = ''
      throw new LineTooLongError()
    }
    return lines
  }
}
