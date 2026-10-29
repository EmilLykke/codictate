/**
 * Where the Punctuation Model (ekko-pnc) lives, what it is pinned to, and whether it is
 * fully on disk.
 *
 * The weights come from Codictate's own Mirror (docs/EKKO_MIRROR.md) at a pinned commit, and
 * every file has a pinned size and sha256, like Parakeet's pinned files: the table is the
 * download list, so a file it does not name is never fetched, and a file that fails its hash
 * is never installed. They install into a folder of their own under the models directory.
 * The Punctuation Model is not a Speech Model: it has no catalog entry, no list entry and no
 * delete button.
 *
 * Availability is a question, not a write (AGENTS.md): `isPunctuationModelInstalled` reads
 * and changes nothing. It is asked inside every `getSettings()` and every Dictation Plan
 * build, so a file's sha256 is computed once per (size, mtime, inode) and remembered for the
 * life of the process, not on every ask.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MODELS_DIR } from '../../platform/runtime'
import {
  PUNCTUATION_MODEL_FILES,
  PUNCTUATION_MODEL_MIRROR_REPO_ID,
  PUNCTUATION_MODEL_MIRROR_REVISION,
  type PunctuationModelFile,
} from '../../../shared/punctuation-model-files'

// The pinned table is plain data in `shared/`, so the window can size the download from it.
export {
  PUNCTUATION_MODEL_FILES,
  PUNCTUATION_MODEL_MIRROR_REPO_ID,
  PUNCTUATION_MODEL_MIRROR_REVISION,
  type PunctuationModelFile,
}

/** The Punctuation Model's own folder under the models directory. */
export const PUNCTUATION_MODEL_DIR = join(MODELS_DIR, 'ekko-pnc')

/** Where a pinned file downloads from: the Mirror at its pinned commit. */
export function punctuationModelFileUrl(file: PunctuationModelFile): string {
  return `https://huggingface.co/${PUNCTUATION_MODEL_MIRROR_REPO_ID}/resolve/${PUNCTUATION_MODEL_MIRROR_REVISION}/${file.path}`
}

/**
 * Whether every runtime file is in `dir` with its pinned size and sha256. Never throws, never
 * writes. A size is checked on every ask; a hash only when the file is new to this process
 * or its size, mtime or inode moved.
 */
export function isPunctuationModelInstalled(
  dir: string = PUNCTUATION_MODEL_DIR,
  files: readonly PunctuationModelFile[] = PUNCTUATION_MODEL_FILES
): boolean {
  return files
    .filter((file) => file.runtime)
    .every((file) => fileMatches(join(dir, file.path), file))
}

interface HashedFile {
  size: number
  mtimeMs: number
  ino: number
  sha256: string
}

const hashed = new Map<string, HashedFile>()

function fileMatches(path: string, file: PunctuationModelFile): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== file.bytes) return false
    let known = hashed.get(path)
    if (
      known === undefined ||
      known.size !== stat.size ||
      known.mtimeMs !== stat.mtimeMs ||
      known.ino !== stat.ino
    ) {
      known = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }
      hashed.set(path, known)
    }
    return known.sha256 === file.sha256
  } catch {
    return false
  }
}
