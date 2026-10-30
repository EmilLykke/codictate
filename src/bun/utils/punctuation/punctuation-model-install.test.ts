/**
 * Installing the Punctuation Model from the Mirror, on a temporary models directory with a
 * small pinned table of its own and a fake `fetch`, since the real weights are 22 MB.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPunctuationModelInstalled,
  type PunctuationModelFile,
} from './punctuation-model-files'
import { installPunctuationModel } from './punctuation-model-install'

// sha256 of the ASCII strings, from `printf %s <text> | shasum -a 256`.
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const XYZ_SHA256 =
  '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282'

const TABLE: readonly PunctuationModelFile[] = [
  { path: 'pnc.int8.onnx', bytes: 3, sha256: ABC_SHA256, runtime: true },
  { path: 'config.json', bytes: 3, sha256: XYZ_SHA256, runtime: true },
  { path: 'LICENSES/NOTICE', bytes: 3, sha256: ABC_SHA256, runtime: false },
]

const MIRROR: Record<string, string> = {
  'pnc.int8.onnx': 'abc',
  'config.json': 'xyz',
  'LICENSES/NOTICE': 'abc',
}

const urlFor = (file: PunctuationModelFile) =>
  `https://mirror.test/${file.path}`

/** Serves `files` by path; a path it does not hold is a 404. */
function fakeFetch(files: Record<string, string>) {
  const requested: string[] = []
  const fetch = async (url: string | URL | Request) => {
    const path = String(url).replace('https://mirror.test/', '')
    requested.push(path)
    const body = files[path]
    if (body === undefined) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' })
    }
    return new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(body.length) },
    })
  }
  return { fetch, requested }
}

let modelsDir: string
let dir: string
beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'codictate-pnc-install-'))
  dir = join(modelsDir, 'ekko-pnc')
})
afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
})

describe('installPunctuationModel', () => {
  test('installs every pinned file, and nothing else is left in the models directory', async () => {
    const { fetch } = fakeFetch(MIRROR)
    await installPunctuationModel({ dir, files: TABLE, urlFor, fetch })

    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
    expect(readFileSync(join(dir, 'LICENSES/NOTICE'), 'utf8')).toBe('abc')
    expect(readdirSync(modelsDir)).toEqual(['ekko-pnc'])
  })

  test('a file that fails its hash is never installed, and nothing is left behind', async () => {
    const { fetch } = fakeFetch({ ...MIRROR, 'config.json': 'xyZ' })
    await expect(
      installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    ).rejects.toThrow('did not match the expected checksum')

    expect(existsSync(dir)).toBe(false)
    expect(readdirSync(modelsDir)).toEqual([])
  })

  test('a file the Mirror does not serve fails with the repo and status named', async () => {
    const { fetch } = fakeFetch({ 'pnc.int8.onnx': 'abc' })
    await expect(
      installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    ).rejects.toThrow(
      'HTTP 404 for https://mirror.test/config.json). Check your connection and try again.'
    )
    expect(readdirSync(modelsDir)).toEqual([])
  })

  test('a failed attempt leaves an earlier install as it was', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'pnc.int8.onnx'), 'abc')
    const { fetch } = fakeFetch({})
    await expect(
      installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    ).rejects.toThrow('HTTP 404')
    expect(readdirSync(dir)).toEqual(['pnc.int8.onnx'])
  })

  test('a verified set replaces an incomplete earlier install', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'pnc.int8.onnx'), 'stale')
    writeFileSync(join(dir, 'leftover'), 'x')
    const { fetch } = fakeFetch(MIRROR)
    await installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
    expect(existsSync(join(dir, 'leftover'))).toBe(false)
  })

  test('reports progress as a fraction of the pinned bytes, ending at 1', async () => {
    const { fetch } = fakeFetch(MIRROR)
    const fractions: number[] = []
    await installPunctuationModel({
      dir,
      files: TABLE,
      urlFor,
      fetch,
      onProgress: (f) => fractions.push(f),
    })
    expect(fractions).toEqual([1 / 3, 2 / 3, 1])
  })

  test('two installs at once share one download: both resolve and the set is installed', async () => {
    const { fetch: serve, requested } = fakeFetch(MIRROR)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetch = async (url: string) => {
      await gate
      return serve(url)
    }
    const first = installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    const second = installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    release()
    await Promise.all([first, second])

    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
    expect(requested).toEqual([
      'pnc.int8.onnx',
      'config.json',
      'LICENSES/NOTICE',
    ])
    expect(readdirSync(modelsDir)).toEqual(['ekko-pnc'])
  })

  test('an install waiting on another one that fails tries again itself', async () => {
    const { fetch: serve, requested } = fakeFetch(MIRROR)
    let calls = 0
    const fetch = async (url: string) => {
      calls += 1
      if (calls === 1) {
        await Promise.resolve()
        return new Response('Not Found', { status: 404 })
      }
      return serve(url)
    }
    const first = installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    const second = installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    await expect(first).rejects.toThrow('HTTP 404')
    await second

    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
    expect(requested).toEqual([
      'pnc.int8.onnx',
      'config.json',
      'LICENSES/NOTICE',
    ])
  })

  test('an install cancelled while it waits on another one rejects and leaves that one running', async () => {
    const { fetch: serve } = fakeFetch(MIRROR)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetch = async (url: string) => {
      await gate
      return serve(url)
    }
    const first = installPunctuationModel({ dir, files: TABLE, urlFor, fetch })
    const controller = new AbortController()
    const second = installPunctuationModel({
      dir,
      files: TABLE,
      urlFor,
      fetch,
      signal: controller.signal,
    }).catch((e: unknown) => e)
    controller.abort()
    expect(((await second) as Error).name).toBe('AbortError')
    release()
    await first
    expect(isPunctuationModelInstalled(dir, TABLE)).toBe(true)
  })

  test('a cancelled download rejects and installs nothing', async () => {
    const controller = new AbortController()
    const fetch = async (_url: string, init?: RequestInit) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      return new Response('abc')
    }
    const err = await installPunctuationModel({
      dir,
      files: TABLE,
      urlFor,
      fetch,
      signal: controller.signal,
    }).catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
    expect(readdirSync(modelsDir)).toEqual([])
  })
})
