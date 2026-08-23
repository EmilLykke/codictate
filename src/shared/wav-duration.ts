/**
 * WAV duration read straight from the header chunks.
 *
 * The recorder and the benchmark manifest builder both need it, and the
 * benchmark's copy carried a comment admitting it duplicated the app. Two
 * walks over the same byte layout can only drift, so there is one.
 *
 * Takes bytes rather than a path because both callers already hold the file,
 * and because a pure function over a `Uint8Array` is testable without a disk.
 */

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) {
    // Node's 'ascii' decoding masks the high bit; match it so a byte over 0x7f
    // can never spell a chunk id it should not.
    out += String.fromCharCode(bytes[i] & 0x7f)
  }
  return out
}

/**
 * Duration in seconds, or `null` when the bytes are not a WAV whose length can
 * be derived: too short, wrong magic, a truncated `fmt ` chunk, or no `data`.
 */
export function estimateWavDurationSecFromBytes(
  bytes: Uint8Array
): number | null {
  if (bytes.length < 44) return null
  if (readAscii(bytes, 0, 4) !== 'RIFF') return null
  if (readAscii(bytes, 8, 12) !== 'WAVE') return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let off = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataSize = 0

  while (off + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, off, off + 4)
    const chunkSize = view.getUint32(off + 4, true)
    const dataStart = off + 8
    // Chunks are word aligned, so an odd size is followed by a pad byte.
    off += 8 + chunkSize + (chunkSize % 2)
    if (chunkId === 'fmt ') {
      if (dataStart + 16 > bytes.length) return null
      channels = view.getUint16(dataStart + 2, true)
      sampleRate = view.getUint32(dataStart + 4, true)
      bitsPerSample = view.getUint16(dataStart + 14, true)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return null
  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!bytesPerFrame || !Number.isInteger(bytesPerFrame)) return null
  return dataSize / bytesPerFrame / sampleRate
}

/**
 * The same duration in whole milliseconds, which is what the short-capture
 * check compares against.
 */
export function estimateWavDurationMsFromBytes(
  bytes: Uint8Array
): number | null {
  const seconds = estimateWavDurationSecFromBytes(bytes)
  return seconds === null ? null : Math.floor(seconds * 1000)
}
