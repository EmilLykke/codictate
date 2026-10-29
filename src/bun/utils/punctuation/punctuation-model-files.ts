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

export const PUNCTUATION_MODEL_MIRROR_REPO_ID = 'emillykkegrann/ekko-pnc-ONNX'

/** The Mirror commit, never `main`. Moving it is a new model: regenerate the parity fixture. */
export const PUNCTUATION_MODEL_MIRROR_REVISION =
  '44b0483333423a31d36907f1d71dee7e71045a42'

/** The Punctuation Model's own folder under the models directory. */
export const PUNCTUATION_MODEL_DIR = join(MODELS_DIR, 'ekko-pnc')

export interface PunctuationModelFile {
  /** Path inside the Mirror repo, and inside `PUNCTUATION_MODEL_DIR`. */
  path: string
  bytes: number
  sha256: string
  /**
   * Read by Punctuation Restoration (`ekko-pnc-model.ts`), so the Punctuation Model counts as
   * installed only with it. The rest are the Mirror's licence and notice files: installed
   * beside the weights, but the app bundle carries its own copies for attribution, and
   * `tokenizer_config.json` is a file the Python reference does not read either.
   */
  runtime: boolean
}

/**
 * Every file of the Mirror except its generated README, at `PUNCTUATION_MODEL_MIRROR_REVISION`.
 * Sizes and sha256 as docs/EKKO_MIRROR.md records them (a test holds the two together).
 */
export const PUNCTUATION_MODEL_FILES: readonly PunctuationModelFile[] = [
  {
    path: 'pnc.int8.onnx',
    bytes: 22424741,
    sha256: '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
    runtime: true,
  },
  {
    path: 'tokenizer.json',
    bytes: 2301084,
    sha256: 'a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502',
    runtime: true,
  },
  {
    path: 'tokenizer_config.json',
    bytes: 1269,
    sha256: '69661a09d8db6efe1114ad1247626d362b710d8ddd16ffe015aad74017ad5e81',
    runtime: false,
  },
  {
    path: 'config.json',
    bytes: 1062,
    sha256: 'dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca',
    runtime: true,
  },
  {
    path: 'NOTICE',
    bytes: 445,
    sha256: 'bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d',
    runtime: false,
  },
  {
    path: 'MODEL_LICENSE.md',
    bytes: 502,
    sha256: '590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa',
    runtime: false,
  },
  {
    path: 'LICENSES/CC-BY-4.0.txt',
    bytes: 18657,
    sha256: '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411',
    runtime: false,
  },
  {
    path: 'LICENSES/CC0-1.0.txt',
    bytes: 7048,
    sha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
    runtime: false,
  },
  {
    path: 'LICENSES/CORAL-LICENSE',
    bytes: 14112,
    sha256: 'ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd',
    runtime: false,
  },
  {
    path: 'LICENSES/FTSPEECH-LICENSE.md',
    bytes: 486,
    sha256: '39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a',
    runtime: false,
  },
]

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
