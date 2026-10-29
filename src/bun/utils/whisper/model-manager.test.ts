/**
 * The Speech Model store (`ModelManager`) for the ekko Speech Engine: ekko counts as
 * installed only with its GGUF *and* the Punctuation Model (ekko-pnc) on disk, its download
 * fetches both as one, and deleting it keeps ekko-pnc. Run on a temporary models directory
 * with a fake `fetch` and a small pinned Punctuation Model table, since the real files are
 * 152 MB; the real table and Mirror URLs are what the reachability manual check covers.
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
import { buildDictationPlan } from '../../../shared/dictation-plan'
import type { DictationAvailability } from '../../../shared/dictation-plan'
import { healDictationSettings } from '../../../shared/settings-heal'
import {
  DEFAULT_MODEL_ID,
  getSpeechModel,
  singleFileModelDownloadUrl,
} from '../../../shared/speech-models'
import type { PunctuationModelFile } from '../punctuation/punctuation-model-files'
import { ModelManager } from './model-manager'

const EKKO = 'ekko-v1-tiny-q5_0'
const HVISKE = 'hviske-v5-tiny-q5_0'
const ekko = getSpeechModel(EKKO)!
const ekkoUrl = singleFileModelDownloadUrl(ekko)

// sha256 of the ASCII strings, from `printf %s <text> | shasum -a 256`.
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const XYZ_SHA256 =
  '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282'

const PUNCTUATION_FILES: readonly PunctuationModelFile[] = [
  { path: 'pnc.int8.onnx', bytes: 3, sha256: ABC_SHA256, runtime: true },
  { path: 'config.json', bytes: 3, sha256: XYZ_SHA256, runtime: true },
  { path: 'LICENSES/NOTICE', bytes: 3, sha256: ABC_SHA256, runtime: false },
]
const PUNCTUATION_MIRROR: Record<string, string> = {
  'https://pnc.test/pnc.int8.onnx': 'abc',
  'https://pnc.test/config.json': 'xyz',
  'https://pnc.test/LICENSES/NOTICE': 'abc',
}

/** Stands in for the real GGUF: six bytes whose sha256 the store is told to expect. */
const GGUF_BODY = 'abcdef'
const GGUF_SHA256 =
  'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721'

/** Serves `files` by URL; a URL it does not hold is a 404. Records what was asked for. */
function fakeFetch(files: Record<string, string>) {
  const requested: string[] = []
  const fetch = async (url: string | URL | Request) => {
    requested.push(String(url))
    const body = files[String(url)]
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
let punctuationDir: string
beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'codictate-model-manager-'))
  punctuationDir = join(modelsDir, 'ekko-pnc')
})
afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
})

function store(files: Record<string, string>) {
  const { fetch, requested } = fakeFetch(files)
  const manager = new ModelManager({
    modelsDir,
    fetch,
    // The real entry's sha256 is the 128 MiB GGUF's; this one is GGUF_BODY's.
    speechModel: (id) =>
      id === EKKO ? { ...ekko, sha256: GGUF_SHA256 } : getSpeechModel(id),
    punctuationModel: {
      dir: punctuationDir,
      files: PUNCTUATION_FILES,
      urlFor: (file) => `https://pnc.test/${file.path}`,
    },
  })
  return { manager, requested }
}

const everything = { [ekkoUrl]: GGUF_BODY, ...PUNCTUATION_MIRROR }

function putGguf(): void {
  writeFileSync(join(modelsDir, ekko.artifactName), GGUF_BODY)
}

function putPunctuationModel(): void {
  mkdirSync(join(punctuationDir, 'LICENSES'), { recursive: true })
  writeFileSync(join(punctuationDir, 'pnc.int8.onnx'), 'abc')
  writeFileSync(join(punctuationDir, 'config.json'), 'xyz')
  writeFileSync(join(punctuationDir, 'LICENSES/NOTICE'), 'abc')
}

interface Progress {
  fraction: number
  done: boolean
  error?: string
}

async function download(manager: ModelManager, modelId = EKKO) {
  const events: Progress[] = []
  await manager.downloadModel(modelId, (fraction, done, error) =>
    events.push(
      error === undefined ? { fraction, done } : { fraction, done, error }
    )
  )
  return events
}

const last = (events: Progress[]) => events[events.length - 1]

function availabilityFrom(manager: ModelManager): DictationAvailability {
  return {
    isModelAvailable: (id) => manager.isModelAvailable(id),
    streamSupported: true,
    punctuationModelInstalled: manager.isPunctuationModelInstalled(),
  }
}

const settings = (speechModelId: string, addPunctuation = false) => ({
  speechModelId,
  transcriptionLanguageId: 'da',
  translateDefaultLanguageId: 'auto',
  translateToEnglish: false,
  streamMode: false,
  addPunctuation,
})

describe('ekko availability', () => {
  test('is installed with its GGUF and the Punctuation Model both on disk', () => {
    putGguf()
    putPunctuationModel()
    const { manager } = store({})
    expect(manager.isModelAvailable(EKKO)).toBe(true)
    expect(manager.getAvailabilityMap()[EKKO]).toBe(true)
  })

  test('is not installed with the GGUF alone', () => {
    putGguf()
    const { manager } = store({})
    expect(manager.isModelAvailable(EKKO)).toBe(false)
    expect(manager.getAvailabilityMap()[EKKO]).toBe(false)
  })

  test('is not installed with the Punctuation Model alone', () => {
    putPunctuationModel()
    const { manager } = store({})
    expect(manager.isModelAvailable(EKKO)).toBe(false)
  })

  test('without ekko-pnc an ekko Dictation is blocked as not installed, and the heal moves the selection', () => {
    putGguf()
    const { manager } = store({})
    const availability = availabilityFrom(manager)

    const plan = buildDictationPlan(settings(EKKO), availability)
    if (plan.status !== 'blocked') throw new Error('expected a blocked plan')
    expect(plan.reason).toBe('speech_model_not_installed')

    const healed = healDictationSettings(settings(EKKO), availability)
    expect(healed.settings.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(healed.announcements.map((a) => a.reason)).toEqual([
      'speech_model_not_installed',
    ])
  })
})

describe('deleting ekko', () => {
  test('removes the GGUF only: ekko-pnc stays, and a hviske Dictation keeps Add punctuation', () => {
    putGguf()
    putPunctuationModel()
    writeFileSync(join(modelsDir, getSpeechModel(HVISKE)!.artifactName), 'w')
    const { manager } = store({})

    expect(manager.deleteModel(EKKO)).toBe(true)

    expect(existsSync(join(modelsDir, ekko.artifactName))).toBe(false)
    expect(manager.isModelAvailable(EKKO)).toBe(false)
    expect(manager.isPunctuationModelInstalled()).toBe(true)

    const availability = availabilityFrom(manager)
    const hviske = settings(HVISKE, true)
    expect(healDictationSettings(hviske, availability).unchanged).toBe(true)
    const plan = buildDictationPlan(hviske, availability)
    if (plan.status !== 'runnable') throw new Error('expected a runnable plan')
    expect(plan.punctuationRestoration).toBe(true)
  })
})

describe('downloading ekko', () => {
  test('fetches the GGUF and then ekko-pnc as one download with one progress value', async () => {
    const { manager, requested } = store(everything)
    const events = await download(manager)

    // Weighted by bytes: the 6-byte GGUF, then ekko-pnc's three 3-byte files, out of 15.
    expect(events).toEqual([
      { fraction: 6 / 15, done: false },
      { fraction: 9 / 15, done: false },
      { fraction: 12 / 15, done: false },
      { fraction: 1, done: false },
      { fraction: 1, done: true },
    ])
    expect(requested).toEqual([
      ekkoUrl,
      'https://pnc.test/pnc.int8.onnx',
      'https://pnc.test/config.json',
      'https://pnc.test/LICENSES/NOTICE',
    ])
    expect(manager.isModelAvailable(EKKO)).toBe(true)
    expect(manager.isPunctuationModelInstalled()).toBe(true)
  })

  test('fetches only the GGUF when ekko-pnc is already installed', async () => {
    putPunctuationModel()
    const { manager, requested } = store(everything)
    const events = await download(manager)

    expect(requested).toEqual([ekkoUrl])
    expect(last(events)).toEqual({ fraction: 1, done: true })
    expect(manager.isModelAvailable(EKKO)).toBe(true)
  })

  test('a GGUF that fails its sha256 is never installed, and ekko-pnc is not fetched', async () => {
    const { manager, requested } = store({
      ...everything,
      [ekkoUrl]: 'abcdeF',
    })
    const events = await download(manager)

    expect(last(events)).toEqual({
      fraction: 0,
      done: true,
      error:
        'The downloaded file did not match the expected checksum. Try the download again.',
    })
    expect(requested).toEqual([ekkoUrl])
    expect(readdirSync(modelsDir)).toEqual([])
  })

  test('when ekko-pnc fails the verified GGUF stays, the error shows, and ekko is not installed', async () => {
    const { manager } = store({ [ekkoUrl]: GGUF_BODY })
    const events = await download(manager)

    expect(last(events)).toEqual({
      fraction: 0,
      done: true,
      error:
        'Could not download the Danish punctuation model from emillykkegrann/ekko-pnc-ONNX ' +
        '(HTTP 404 for https://pnc.test/pnc.int8.onnx). Check your connection and try again.',
    })
    expect(readFileSync(join(modelsDir, ekko.artifactName), 'utf8')).toBe(
      GGUF_BODY
    )
    expect(existsSync(punctuationDir)).toBe(false)
    expect(manager.isModelAvailable(EKKO)).toBe(false)
  })

  test('a retry after ekko-pnc failed fetches only ekko-pnc', async () => {
    await download(store({ [ekkoUrl]: GGUF_BODY }).manager)

    const { manager, requested } = store(everything)
    const events = await download(manager)

    expect(requested).toEqual([
      'https://pnc.test/pnc.int8.onnx',
      'https://pnc.test/config.json',
      'https://pnc.test/LICENSES/NOTICE',
    ])
    expect(events).toEqual([
      { fraction: 1 / 3, done: false },
      { fraction: 2 / 3, done: false },
      { fraction: 1, done: false },
      { fraction: 1, done: true },
    ])
    expect(manager.isModelAvailable(EKKO)).toBe(true)
  })

  test('a cancel during ekko-pnc reports Cancelled and keeps the GGUF', async () => {
    const { fetch: serve } = fakeFetch(everything)
    // The user presses Cancel the moment the GGUF is in and ekko-pnc starts.
    const cancel = { press: () => {} }
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://pnc.test/')) {
        cancel.press()
        init?.signal?.throwIfAborted()
      }
      return serve(url)
    }
    const manager = new ModelManager({
      modelsDir,
      fetch,
      speechModel: (id) =>
        id === EKKO ? { ...ekko, sha256: GGUF_SHA256 } : getSpeechModel(id),
      punctuationModel: {
        dir: punctuationDir,
        files: PUNCTUATION_FILES,
        urlFor: (file) => `https://pnc.test/${file.path}`,
      },
    })
    cancel.press = () => manager.cancelDownload(EKKO)
    const events = await download(manager)

    expect(last(events)).toEqual({
      fraction: 0,
      done: true,
      error: 'Cancelled',
    })
    expect(existsSync(join(modelsDir, ekko.artifactName))).toBe(true)
    expect(manager.isModelAvailable(EKKO)).toBe(false)
  })
})
