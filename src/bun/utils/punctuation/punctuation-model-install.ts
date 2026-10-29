/**
 * Downloads the Punctuation Model (ekko-pnc) from Codictate's Mirror and installs it.
 *
 * Every file in the pinned table is fetched at the pinned Mirror commit into a temporary
 * folder beside the install folder, hashed while it streams, and checked against its pinned
 * size and sha256. Only when every file has passed is the temporary folder renamed into
 * place, so the install folder only ever holds a complete, verified set: a download that
 * fails, is cancelled or is killed half way never looks installed, and a file that fails its
 * hash is never installed. Same shape as Parakeet's pinned files in `model-manager.ts`.
 *
 * The rename stays within one parent folder, which is atomic on macOS and Windows alike.
 * Windows refuses to rename a folder onto an existing one, so an old install (a set the
 * availability check no longer accepts) is removed first, as Parakeet's install does.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PUNCTUATION_MODEL_DIR,
  PUNCTUATION_MODEL_FILES,
  PUNCTUATION_MODEL_MIRROR_REPO_ID,
  punctuationModelFileUrl,
  type PunctuationModelFile,
} from './punctuation-model-files'

export const PUNCTUATION_MODEL_CHECKSUM_MISMATCH_MESSAGE =
  'The downloaded file did not match the expected checksum. Try the download again.'

export interface PunctuationModelInstallOptions {
  dir?: string
  files?: readonly PunctuationModelFile[]
  urlFor?: (file: PunctuationModelFile) => string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  signal?: AbortSignal
  /** Fraction of the pinned bytes received so far, 0 to 1. */
  onProgress?: (fraction: number) => void
}

/**
 * Resolves once the verified set is in `dir`. Rejects with a message the user can act on,
 * or with the `AbortError` of `signal`; either way nothing is left behind but what was
 * installed before.
 */
export async function installPunctuationModel(
  options: PunctuationModelInstallOptions = {}
): Promise<void> {
  const dir = options.dir ?? PUNCTUATION_MODEL_DIR
  const files = options.files ?? PUNCTUATION_MODEL_FILES
  const urlFor = options.urlFor ?? punctuationModelFileUrl
  const fetchFile = options.fetch ?? fetch
  const tempDir = `${dir}.tmp`

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  let receivedBytes = 0
  const received = (bytes: number) => {
    receivedBytes += bytes
    if (totalBytes > 0) {
      options.onProgress?.(Math.min(1, receivedBytes / totalBytes))
    }
  }

  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })
  try {
    for (const file of files) {
      await downloadVerified(
        file,
        urlFor(file),
        join(tempDir, file.path),
        fetchFile,
        options.signal,
        received
      )
    }
    rmSync(dir, { recursive: true, force: true })
    renameSync(tempDir, dir)
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true })
    throw err
  }
}

async function downloadVerified(
  file: PunctuationModelFile,
  url: string,
  destPath: string,
  fetchFile: (url: string, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal | undefined,
  received: (bytes: number) => void
): Promise<void> {
  const response = await fetchFile(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download the Danish punctuation model from ${PUNCTUATION_MODEL_MIRROR_REPO_ID} ` +
        `(HTTP ${response.status} for ${url}). Check your connection and try again.`
    )
  }

  mkdirSync(dirname(destPath), { recursive: true })
  const out = createWriteStream(destPath)
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      bytes += value.length
      await new Promise<void>((resolve, reject) => {
        out.write(value, (err) => (err ? reject(err) : resolve()))
      })
      received(value.length)
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  const sha256 = hash.digest('hex')
  if (bytes !== file.bytes || sha256 !== file.sha256) {
    throw new Error(PUNCTUATION_MODEL_CHECKSUM_MISMATCH_MESSAGE)
  }
}
