/**
 * Is the Punctuation Model fully on disk with its pinned hashes. Exercised on a temporary
 * folder with a small pinned table of its own, since the real weights are 22 MB and not in
 * the repo; the real table is checked against the Mirror doc instead.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PUNCTUATION_MODEL_FILES,
  PUNCTUATION_MODEL_MIRROR_REPO_ID,
  PUNCTUATION_MODEL_MIRROR_REVISION,
  isPunctuationModelInstalled,
  punctuationModelFileUrl,
  type PunctuationModelFile,
} from './punctuation-model-files'

// sha256 of the ASCII strings, from `printf %s <text> | shasum -a 256`.
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const XYZ_SHA256 =
  '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282'

const TABLE: readonly PunctuationModelFile[] = [
  { path: 'pnc.int8.onnx', bytes: 3, sha256: ABC_SHA256, runtime: true },
  { path: 'config.json', bytes: 3, sha256: XYZ_SHA256, runtime: true },
  { path: 'NOTICE', bytes: 3, sha256: ABC_SHA256, runtime: false },
]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codictate-pnc-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function installAll(): void {
  writeFileSync(join(dir, 'pnc.int8.onnx'), 'abc')
  writeFileSync(join(dir, 'config.json'), 'xyz')
  writeFileSync(join(dir, 'NOTICE'), 'abc')
}

describe('isPunctuationModelInstalled', () => {
  test('is true when every runtime file is there with its pinned hash', () => {
    installAll()
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
  })

  test('is false when there is no folder at all', () => {
    expect(isPunctuationModelInstalled(join(dir, 'missing'), TABLE)).toBe(false)
  })

  test('is false when a runtime file is missing', () => {
    writeFileSync(join(dir, 'pnc.int8.onnx'), 'abc')
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(false)
  })

  test('is false when a runtime file has the right size and the wrong bytes', () => {
    installAll()
    writeFileSync(join(dir, 'config.json'), 'abc')
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(false)
  })

  test('is false when a runtime file has the wrong size', () => {
    installAll()
    writeFileSync(join(dir, 'config.json'), 'xyz!')
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(false)
  })

  /** The licence files ship in the app bundle; Punctuation Restoration does not read them. */
  test('does not need the files the runtime never reads', () => {
    writeFileSync(join(dir, 'pnc.int8.onnx'), 'abc')
    writeFileSync(join(dir, 'config.json'), 'xyz')
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
  })

  test('notices a file replaced after it was found good', () => {
    installAll()
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
    writeFileSync(join(dir, 'pnc.int8.onnx'), 'xyz')
    utimesSync(join(dir, 'pnc.int8.onnx'), new Date(1), new Date(1))
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(false)
  })
})

describe('the pinned table', () => {
  test('is the ekko-pnc Mirror at the commit and hashes docs/EKKO_MIRROR.md records', () => {
    const doc = readFileSync(
      join(import.meta.dir, '../../../../docs/EKKO_MIRROR.md'),
      'utf8'
    )
    expect(doc).toContain(`**\`${PUNCTUATION_MODEL_MIRROR_REPO_ID}\`**`)
    expect(doc).toContain(
      `Mirror commit: \`${PUNCTUATION_MODEL_MIRROR_REVISION}\``
    )
    const rows = [
      ...doc.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gm),
    ].map(([, path, bytes, sha256]) => ({
      path,
      bytes: Number(bytes),
      sha256,
    }))
    expect(
      PUNCTUATION_MODEL_FILES.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      }))
    ).toEqual(rows)
  })

  test('marks exactly the files the loader reads as needed at run time', () => {
    expect(
      PUNCTUATION_MODEL_FILES.filter((file) => file.runtime)
        .map((file) => file.path)
        .sort()
    ).toEqual(['config.json', 'pnc.int8.onnx', 'tokenizer.json'])
  })

  test('downloads from the pinned Mirror commit, never main', () => {
    expect(punctuationModelFileUrl(PUNCTUATION_MODEL_FILES[0])).toBe(
      'https://huggingface.co/emillykkegrann/ekko-pnc-ONNX/resolve/44b0483333423a31d36907f1d71dee7e71045a42/pnc.int8.onnx'
    )
  })
})
