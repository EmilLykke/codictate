/**
 * The queue with every dependency faked: no spawn, no filesystem, no wall clock. Decoding
 * and transcribing are deferred promises the test settles, so ordering is exact.
 */

import { describe, expect, test } from 'bun:test'
import type {
  TranscriptionRequest,
  TranscriptionResult,
} from '../utils/whisper/engines/transcription'
import { failedTranscription } from '../utils/whisper/engines/transcription'
import { renderTranscript } from '../../shared/transcript-export'
import type { DecodeAudioResult } from './extract-audio'
import {
  createFileTranscriptionQueue,
  type FileTranscriptionDeps,
} from './queue'
import type {
  FileTranscriptionEvent,
  FileTranscriptionJob,
  FileTranscriptionRequest,
} from './types'

const HVISKE = 'hviske-v5-tiny-q5_0'
const EDDA = 'edda-v0.2-q5_0'
const PARAKEET = 'parakeet-tdt-0.6b-v3'
const LARGE_V3 = 'large-v3-q5_0'
const EKKO = 'ekko-v1-tiny-q5_0'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

/** Let every pending promise continuation run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface DecodeCall {
  input: string
  output: string
  signal: AbortSignal
  lowPriority: boolean
  done: Deferred<DecodeAudioResult>
}

interface TranscribeCall {
  request: TranscriptionRequest
  done: Deferred<TranscriptionResult>
}

function harness(
  options: {
    speechModelId?: string
    transcriptionLanguageId?: string
    translateToEnglish?: boolean
    translateDefaultLanguageId?: string
    installed?: (id: string) => boolean
    files?: Record<string, 'file' | 'missing' | 'not_a_file'>
    audioSeconds?: number | null
    addPunctuation?: boolean
    punctuationModelInstalled?: boolean
    /** The Punctuation Restorer's answers by input; any other input comes back unrestored. */
    punctuated?: Record<string, string>
  } = {}
) {
  let now = 1_000_000
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const decodes: DecodeCall[] = []
  const transcribes: TranscribeCall[] = []
  const created: string[] = []
  const removed: string[] = []
  const restored: string[] = []
  let installed = options.installed ?? (() => true)
  let translateToEnglish = options.translateToEnglish ?? false
  let addPunctuation = options.addPunctuation ?? false
  let punctuationModelInstalled = options.punctuationModelInstalled ?? true
  let heals = 0
  let jobCounter = 0

  const deps: FileTranscriptionDeps = {
    settings: {
      getFileTranscriptionSettings: () => ({
        speechModelId: options.speechModelId ?? HVISKE,
        transcriptionLanguageId: options.transcriptionLanguageId ?? 'auto',
        translateToEnglish,
      }),
      getTranslateDefaultLanguageId: () =>
        options.translateDefaultLanguageId ?? 'auto',
      getAddPunctuation: () => addPunctuation,
    },
    isModelAvailable: (id) => installed(id),
    isPunctuationModelInstalled: () => punctuationModelInstalled,
    // Like the app's heal pass: without the Punctuation Model, Add punctuation goes off.
    healSettings: () => {
      heals += 1
      if (!punctuationModelInstalled) addPunctuation = false
    },
    punctuationRestorer: {
      restore: (text) => {
        restored.push(text)
        const answer = options.punctuated?.[text]
        return Promise.resolve(
          answer === undefined
            ? { text, restored: false }
            : { text: answer, restored: true }
        )
      },
    },
    locations: {
      getModelPath: (id) => `/models/${id}.bin`,
      getParakeetInstallDir: (id) => `/models/${id}`,
    },
    inspectInput: (path) => options.files?.[path] ?? 'file',
    createWorkDir: () => {
      const dir = `/tmp/job-${created.length + 1}`
      created.push(dir)
      return dir
    },
    removeWorkDir: (dir) => {
      removed.push(dir)
    },
    decode: (input, output, { signal, lowPriority }) => {
      const done = deferred<DecodeAudioResult>()
      decodes.push({ input, output, signal, lowPriority, done })
      // Like the real helper: an abort kills it.
      signal.addEventListener('abort', () =>
        done.resolve({
          status: 'failed',
          code: 'cancelled',
          message: 'cancelled',
        })
      )
      return done.promise
    },
    wavDurationSeconds: () =>
      options.audioSeconds === undefined ? 61.2 : options.audioSeconds,
    transcribe: (request) => {
      const done = deferred<TranscriptionResult>()
      transcribes.push({ request, done })
      // Like the real adapters: an abort kills the engine, which exits non-zero.
      request.signal?.addEventListener('abort', () =>
        done.resolve(
          failedTranscription('engine_exited_nonzero', request.speechModelId)
        )
      )
      return done.promise
    },
    clock: {
      now: () => now,
      setInterval: (callback) => {
        const id = ++nextTimer
        timers.set(id, callback)
        return id
      },
      clearInterval: (handle) => {
        timers.delete(handle as number)
      },
    },
    newJobId: () => `job-${++jobCounter}`,
    log: () => {},
  }

  const queue = createFileTranscriptionQueue(deps)

  return {
    deps,
    queue,
    decodes,
    transcribes,
    created,
    removed,
    restored,
    timers,
    setInstalled(next: (id: string) => boolean) {
      installed = next
    },
    setTranslateToEnglish(next: boolean) {
      translateToEnglish = next
    },
    setPunctuationModelInstalled(next: boolean) {
      punctuationModelInstalled = next
    },
    get addPunctuation() {
      return addPunctuation
    },
    get heals() {
      return heals
    },
    /** Advance the clock by whole seconds, firing the progress timer once per second. */
    tick(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        now += 1000
        for (const callback of [...timers.values()]) callback()
      }
    },
    enqueue(
      filePath: string,
      extra: Partial<FileTranscriptionRequest> = {}
    ): { job: FileTranscriptionJob; events: FileTranscriptionEvent[] } {
      const job = queue.enqueue({
        filePath,
        origin: { kind: 'command-line', callerName: 'Terminal' },
        ...extra,
      })
      const events: FileTranscriptionEvent[] = []
      job.onEvent((event) => events.push(event))
      return { job, events }
    },
  }
}

const decoded: DecodeAudioResult = { status: 'ok' }

const harnessDeps = (): FileTranscriptionDeps => harness().deps
const transcript = (text: string): TranscriptionResult => ({
  status: 'ok',
  rawTranscript: text,
})

describe('one job', () => {
  test('decodes, transcribes and returns the Raw Transcript with the documented fields', async () => {
    const h = harness({ speechModelId: HVISKE })
    const { job, events } = h.enqueue('/files/memo.m4a')

    expect(events).toEqual([
      {
        type: 'progress',
        stage: 'decoding',
        elapsedSeconds: 0,
        audioSeconds: null,
      },
    ])
    expect(h.decodes).toHaveLength(1)
    expect(h.decodes[0]).toMatchObject({
      input: '/files/memo.m4a',
      output: '/tmp/job-1/audio.wav',
      lowPriority: true,
    })

    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(last(events)).toEqual({
      type: 'progress',
      stage: 'transcribing',
      elapsedSeconds: 0,
      audioSeconds: 61.2,
    })
    expect(h.transcribes).toHaveLength(1)
    expect(h.transcribes[0].request).toMatchObject({
      engineId: 'hviske',
      speechModelId: HVISKE,
      audioPath: '/tmp/job-1/audio.wav',
      languageCode: 'da',
      crispasrBackend: 'cohere',
      lowPriority: true,
      // 60 s fixed + 3x the audio, above the three-minute floor.
      timeoutMs: 60_000 + 61_200 * 3,
    })
    expect(h.transcribes[0].request.signal).toBeInstanceOf(AbortSignal)

    h.transcribes[0].done.resolve(transcript('Hej med dig'))
    expect(await job.result).toEqual({
      status: 'ok',
      filePath: '/files/memo.m4a',
      text: 'Hej med dig',
      language: 'da',
      speechModelId: HVISKE,
      engine: 'hviske',
      audioSeconds: 61.2,
      translated: false,
      processingSeconds: 0,
      timedTranscript: null,
    })
    expect(h.removed).toEqual(['/tmp/job-1'])
    expect(h.queue.snapshot()).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  test('reports progress about once a second, with the audio length once known', async () => {
    const h = harness()
    const { job, events } = h.enqueue('/files/a.wav')
    h.tick(2)
    expect(events.slice(1)).toEqual([
      {
        type: 'progress',
        stage: 'decoding',
        elapsedSeconds: 1,
        audioSeconds: null,
      },
      {
        type: 'progress',
        stage: 'decoding',
        elapsedSeconds: 2,
        audioSeconds: null,
      },
    ])
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.tick(1)
    expect(last(events)).toEqual({
      type: 'progress',
      stage: 'transcribing',
      elapsedSeconds: 3,
      audioSeconds: 61.2,
    })
    h.transcribes[0].done.resolve(transcript('x'))
    await job.result
  })

  test('silence is success with empty text', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/quiet.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(transcript(''))
    expect(await job.result).toMatchObject({ status: 'ok', text: '' })
  })

  test('a late subscriber is sent the current state', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.tick(4)
    const late: FileTranscriptionEvent[] = []
    job.onEvent((event) => late.push(event))
    expect(late).toEqual([
      {
        type: 'progress',
        stage: 'transcribing',
        elapsedSeconds: 4,
        audioSeconds: 61.2,
      },
    ])
  })
})

describe('result fields', () => {
  test('Processing Time runs from the start of decoding, not from when the job was queued', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    // a: 2 s decoding, 3 s transcribing; b waits all 5 s of it.
    h.tick(2)
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.tick(3)
    h.transcribes[0].done.resolve(transcript('a'))
    expect(await a.job.result).toMatchObject({ processingSeconds: 5 })
    await flush()
    h.tick(1)
    h.decodes[1].done.resolve(decoded)
    await flush()
    h.tick(1)
    h.transcribes[1].done.resolve(transcript('b'))
    expect(await b.job.result).toMatchObject({ processingSeconds: 2 })
  })

  test('the Timed Transcript is passed through as the Speech Engine gave it', async () => {
    const timed = {
      text: 'Hej med dig',
      parts: [{ text: 'Hej med dig', start: 0.2, end: 1.4 }],
    }
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve({
      status: 'ok',
      rawTranscript: 'Hej med dig',
      timedTranscript: timed,
    })
    expect(await job.result).toMatchObject({ timedTranscript: timed })
  })

  test('no timings is null, never absent', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve({
      status: 'ok',
      rawTranscript: 'x',
      timedTranscript: null,
    })
    const result = await job.result
    expect(result.status === 'ok' && result.timedTranscript).toBeNull()
  })
})

describe('Punctuation Restoration', () => {
  /** Runs one job on hviske to the end, the Speech Engine giving `engine`. */
  async function punctuatedRun(
    options: Parameters<typeof harness>[0],
    engine: TranscriptionResult
  ) {
    const h = harness({ speechModelId: HVISKE, ...options })
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(engine)
    return { h, result: await job.result }
  }

  test('hviske with Add punctuation on comes back punctuated', async () => {
    const { result } = await punctuatedRun(
      {
        addPunctuation: true,
        punctuated: {
          'hej med dig hvordan går det': 'Hej med dig, hvordan går det?',
        },
      },
      transcript('hej med dig hvordan går det')
    )
    expect(result).toMatchObject({
      status: 'ok',
      text: 'Hej med dig, hvordan går det?',
    })
  })

  test.each([
    ['hviske with Add punctuation off', HVISKE, false],
    [
      'a Speech Model other than hviske, with Add punctuation on',
      LARGE_V3,
      true,
    ],
  ] as const)(
    '%s is left as the Speech Engine wrote it',
    async (_name, speechModelId, addPunctuation) => {
      const { h, result } = await punctuatedRun(
        {
          speechModelId,
          transcriptionLanguageId: 'da',
          addPunctuation,
          punctuated: { 'hej med dig': 'Hej med dig.' },
        },
        transcript('hej med dig')
      )
      expect(result).toMatchObject({ status: 'ok', text: 'hej med dig' })
      expect(h.restored).toEqual([])
    }
  )

  test('the Timed Transcript is rebuilt on the punctuated text, word for word', async () => {
    // hviske's parts can end inside a word (`køben` | `havn`), and its words can too
    // (`di` | `g`): a span keeps the punctuated form of each word it starts, and a span
    // left holding only the rest of a word is dropped, its time going to its neighbour.
    const raw = 'hej med dig jeg bor i københavn nu og det er dejligt'
    const punctuated = 'Hej med dig. Jeg bor i København, nu og det er dejligt.'
    const { result } = await punctuatedRun(
      { addPunctuation: true, punctuated: { [raw]: punctuated } },
      {
        status: 'ok',
        rawTranscript: raw,
        timedTranscript: {
          text: raw,
          parts: [
            {
              text: 'hej med dig',
              start: 0,
              end: 1,
              words: [
                { text: 'hej', start: 0, end: 0.3 },
                { text: 'med', start: 0.3, end: 0.6 },
                { text: 'di', start: 0.6, end: 0.8 },
                { text: 'g', start: 0.8, end: 1 },
              ],
            },
            {
              text: 'jeg bor i køben',
              start: 1,
              end: 2,
              words: [
                { text: 'jeg', start: 1, end: 1.3 },
                { text: 'bor', start: 1.3, end: 1.6 },
                { text: 'i', start: 1.6, end: 1.7 },
                { text: 'køben', start: 1.7, end: 2 },
              ],
            },
            {
              text: 'havn nu',
              start: 2,
              end: 2.5,
              words: [
                { text: 'havn', start: 2, end: 2.3 },
                { text: 'nu', start: 2.3, end: 2.5 },
              ],
            },
            {
              text: 'og det er dej',
              start: 2.5,
              end: 3.2,
              words: [
                { text: 'og', start: 2.5, end: 2.7 },
                { text: 'det', start: 2.7, end: 2.9 },
                { text: 'er', start: 2.9, end: 3 },
                { text: 'dej', start: 3, end: 3.2 },
              ],
            },
            {
              text: 'ligt',
              start: 3.2,
              end: 3.5,
              words: [{ text: 'ligt', start: 3.2, end: 3.5 }],
            },
          ],
        },
      }
    )
    expect(result).toMatchObject({ status: 'ok', text: punctuated })
    expect(result.status === 'ok' && result.timedTranscript).toEqual({
      text: punctuated,
      parts: [
        {
          text: 'Hej med dig.',
          start: 0,
          end: 1,
          words: [
            { text: 'Hej', start: 0, end: 0.3 },
            { text: 'med', start: 0.3, end: 0.6 },
            { text: 'dig.', start: 0.6, end: 1 },
          ],
        },
        {
          text: 'Jeg bor i København,',
          start: 1,
          end: 2,
          words: [
            { text: 'Jeg', start: 1, end: 1.3 },
            { text: 'bor', start: 1.3, end: 1.6 },
            { text: 'i', start: 1.6, end: 1.7 },
            { text: 'København,', start: 1.7, end: 2 },
          ],
        },
        {
          text: 'nu',
          start: 2,
          end: 2.5,
          words: [{ text: 'nu', start: 2, end: 2.5 }],
        },
        {
          text: 'og det er dejligt.',
          start: 2.5,
          end: 3.5,
          words: [
            { text: 'og', start: 2.5, end: 2.7 },
            { text: 'det', start: 2.7, end: 2.9 },
            { text: 'er', start: 2.9, end: 3 },
            { text: 'dejligt.', start: 3, end: 3.5 },
          ],
        },
      ],
    })
  })

  test('ekko comes back punctuated with Add punctuation off, its word times kept one to one', async () => {
    // ekko's shape: one part per slice, every word timed, lowercase with no punctuation.
    const raw = 'hej med dig jeg bor i københavn'
    const punctuated = 'Hej med dig. Jeg bor i København.'
    const { result } = await punctuatedRun(
      {
        speechModelId: EKKO,
        addPunctuation: false,
        punctuated: { [raw]: punctuated },
      },
      {
        status: 'ok',
        rawTranscript: raw,
        timedTranscript: {
          text: raw,
          parts: [
            {
              text: 'hej med dig',
              start: 0.48,
              end: 1.6,
              words: [
                { text: 'hej', start: 0.48, end: 0.8 },
                { text: 'med', start: 0.8, end: 1.12 },
                { text: 'dig', start: 1.12, end: 1.6 },
              ],
            },
            {
              text: 'jeg bor i københavn',
              start: 4.24,
              end: 6,
              words: [
                { text: 'jeg', start: 4.24, end: 4.48 },
                { text: 'bor', start: 4.48, end: 4.8 },
                { text: 'i', start: 4.8, end: 4.96 },
                { text: 'københavn', start: 5.2, end: 6 },
              ],
            },
          ],
        },
      }
    )
    expect(result).toMatchObject({ status: 'ok', text: punctuated })
    expect(result.status === 'ok' && result.timedTranscript).toEqual({
      text: punctuated,
      parts: [
        {
          text: 'Hej med dig.',
          start: 0.48,
          end: 1.6,
          words: [
            { text: 'Hej', start: 0.48, end: 0.8 },
            { text: 'med', start: 0.8, end: 1.12 },
            { text: 'dig.', start: 1.12, end: 1.6 },
          ],
        },
        {
          text: 'Jeg bor i København.',
          start: 4.24,
          end: 6,
          words: [
            { text: 'Jeg', start: 4.24, end: 4.48 },
            { text: 'bor', start: 4.48, end: 4.8 },
            { text: 'i', start: 4.8, end: 4.96 },
            { text: 'København.', start: 5.2, end: 6 },
          ],
        },
      ],
    })
  })

  test('ekko without a Timed Transcript still returns the punctuated text, and no Caption Files', async () => {
    const { result } = await punctuatedRun(
      {
        speechModelId: EKKO,
        punctuated: { 'hej med dig': 'Hej med dig.' },
      },
      { status: 'ok', rawTranscript: 'hej med dig', timedTranscript: null }
    )
    expect(result).toMatchObject({
      status: 'ok',
      text: 'Hej med dig.',
      timedTranscript: null,
    })
    if (result.status !== 'ok') return
    const source = {
      fileName: 'a.wav',
      speechModelId: EKKO,
      language: 'da',
      translated: false,
      audioSeconds: 61.2,
      processingSeconds: 1,
      text: result.text,
      timedTranscript: result.timedTranscript,
    }
    expect(renderTranscript('srt', source)).toMatchObject({ ok: false })
    expect(renderTranscript('vtt', source)).toMatchObject({ ok: false })
    expect(renderTranscript('txt', source)).toEqual({
      ok: true,
      content: 'Hej med dig.\n',
    })
  })

  test('a Timed Transcript that cannot be rebuilt sends the whole File Transcription back unpunctuated', async () => {
    const timed = {
      text: 'hej med dig',
      parts: [{ text: 'hej med dig', start: 0.2, end: 1.4 }],
    }
    const { result } = await punctuatedRun(
      // Two words where there were three: no word maps onto its times any more.
      { addPunctuation: true, punctuated: { 'hej med dig': 'Hej med-dig.' } },
      { status: 'ok', rawTranscript: 'hej med dig', timedTranscript: timed }
    )
    expect(result).toMatchObject({
      status: 'ok',
      text: 'hej med dig',
      timedTranscript: timed,
    })
  })

  test('Add punctuation on without the Punctuation Model is refused at once, in a sentence about the file', async () => {
    const h = harness({
      speechModelId: HVISKE,
      addPunctuation: true,
      punctuationModelInstalled: false,
    })
    const { job, events } = h.enqueue('/files/a.wav')
    const result = await job.result
    expect(result).toMatchObject({
      status: 'failed',
      code: 'model_not_installed',
    })
    if (result.status === 'failed') {
      expect(result.message).toContain('Add punctuation')
      expect(result.message).not.toContain('Dictation')
    }
    expect(events).toEqual([])
    expect(h.decodes).toHaveLength(0)
  })

  test('Add punctuation on without the Punctuation Model turns the switch off, so the next file runs', async () => {
    const h = harness({
      speechModelId: HVISKE,
      addPunctuation: true,
      punctuationModelInstalled: false,
    })
    const refused = await h.enqueue('/files/a.wav').job.result
    expect(refused).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Add punctuation has been turned off'),
    })
    expect(h.heals).toBe(1)
    expect(h.addPunctuation).toBe(false)

    h.enqueue('/files/b.wav')
    expect(h.decodes).toHaveLength(1)
  })

  test('the Punctuation Model deleted while the job waits turns the switch off too', async () => {
    const h = harness({ speechModelId: HVISKE, addPunctuation: true })
    const { job: first } = h.enqueue('/files/a.wav')
    const { job: waiting } = h.enqueue('/files/b.wav')
    h.setPunctuationModelInstalled(false)
    first.cancel()
    expect(await waiting.result).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Add punctuation has been turned off'),
    })
    expect(h.heals).toBe(1)
    expect(h.addPunctuation).toBe(false)
  })

  test('a Speech Model override that is not installed heals nothing', async () => {
    const h = harness({
      speechModelId: HVISKE,
      installed: (id) => id === HVISKE,
    })
    const result = await h.enqueue('/files/a.wav', { speechModelId: EDDA }).job
      .result
    expect(result).toMatchObject({ code: 'model_not_installed' })
    expect(h.heals).toBe(0)
  })

  test('a Punctuation Restorer that fails leaves the text and its timings as they were', async () => {
    const timed = {
      text: 'hej med dig',
      parts: [{ text: 'hej med dig', start: 0.2, end: 1.4 }],
    }
    const { result } = await punctuatedRun(
      { addPunctuation: true, punctuated: {} },
      { status: 'ok', rawTranscript: 'hej med dig', timedTranscript: timed }
    )
    expect(result).toMatchObject({
      status: 'ok',
      text: 'hej med dig',
      timedTranscript: timed,
    })
  })
})

describe('Translate to English', () => {
  test('follows the File Transcription Settings, and says so in the result', async () => {
    const h = harness({
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    })
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(h.transcribes[0].request).toMatchObject({
      translateToEnglish: true,
      languageCode: 'da',
    })
    h.transcribes[0].done.resolve(transcript('Hello with you'))
    expect(await job.result).toMatchObject({
      status: 'ok',
      text: 'Hello with you',
      language: 'da',
      translated: true,
    })
  })

  test('the request forces it off, or on, for this call only', async () => {
    const h = harness({
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    })
    const off = h.enqueue('/files/a.wav', { translateToEnglish: false })
    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(h.transcribes[0].request).toMatchObject({
      translateToEnglish: false,
    })
    h.transcribes[0].done.resolve(transcript('Hej'))
    expect(await off.job.result).toMatchObject({ translated: false })

    h.setTranslateToEnglish(false)
    const on = h.enqueue('/files/b.wav', { translateToEnglish: true })
    await flush()
    h.decodes[1].done.resolve(decoded)
    await flush()
    h.transcribes[1].done.resolve(transcript('Hello'))
    expect(await on.job.result).toMatchObject({ translated: true })
  })

  test('the settings are read when the job is queued, not when it starts', async () => {
    const h = harness({
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'da',
    })
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    h.setTranslateToEnglish(true)
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(transcript('a'))
    await a.job.result
    await flush()
    h.decodes[1].done.resolve(decoded)
    await flush()
    expect(h.transcribes[1].request).toMatchObject({
      translateToEnglish: false,
    })
    h.transcribes[1].done.resolve(transcript('b'))
    expect(await b.job.result).toMatchObject({ translated: false })
  })

  test('a Speech Model that cannot translate is refused at once, never queued', async () => {
    const h = harness({ speechModelId: HVISKE, translateToEnglish: true })
    const { job, events } = h.enqueue('/files/a.wav')
    expect(await job.result).toMatchObject({
      status: 'failed',
      code: 'cannot_translate',
    })
    expect(events).toEqual([])
    expect(h.decodes).toHaveLength(0)
    expect(h.queue.snapshot()).toEqual([])
  })
})

describe('the queue', () => {
  test('runs one job at a time, first in first out, and tells waiting jobs their position', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav', { origin: { kind: 'window' } })
    const c = h.enqueue('/files/c.wav')

    expect(a.events.map((e) => e.type)).toEqual(['progress'])
    expect(b.events).toEqual([{ type: 'queued', position: 1 }])
    expect(c.events).toEqual([{ type: 'queued', position: 2 }])
    expect(h.decodes).toHaveLength(1)
    expect(h.queue.snapshot()).toMatchObject([
      {
        id: a.job.id,
        fileName: 'a.wav',
        state: 'decoding',
        startedAt: 1_000_000,
      },
      {
        id: b.job.id,
        fileName: 'b.wav',
        state: 'queued',
        startedAt: null,
        origin: { kind: 'window' },
      },
      { id: c.job.id, state: 'queued' },
    ])

    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(transcript('a'))
    await a.job.result
    await flush()

    expect(h.decodes).toHaveLength(2)
    expect(h.decodes[1].input).toBe('/files/b.wav')
    expect(last(b.events)).toMatchObject({
      type: 'progress',
      stage: 'decoding',
    })
    expect(c.events).toEqual([
      { type: 'queued', position: 2 },
      { type: 'queued', position: 1 },
    ])
  })

  test('announces every change with a fresh snapshot', async () => {
    const h = harness()
    const seen: string[][] = []
    h.queue.onChange((jobs) =>
      seen.push(jobs.map((j) => `${j.fileName}:${j.state}`))
    )
    const a = h.enqueue('/files/a.wav')
    h.enqueue('/files/b.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(transcript('a'))
    await a.job.result
    expect(seen).toEqual([
      ['a.wav:decoding'],
      ['a.wav:decoding', 'b.wav:queued'],
      ['a.wav:transcribing', 'b.wav:queued'],
      ['b.wav:decoding'],
    ])
  })

  test('a job that throws fails as internal, never rejects, and the next one still runs', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.promise.catch(() => {})
    // Replace the engine's answer with a throw.
    const call = h.transcribes[0]
    call.done.resolve(Promise.reject(new Error('boom')) as never)
    expect(await a.job.result).toMatchObject({
      status: 'failed',
      code: 'internal',
    })
    await flush()
    expect(h.decodes[1].input).toBe('/files/b.wav')
    expect(h.removed).toEqual(['/tmp/job-1'])
    b.job.cancel()
    await b.job.result
  })
})

describe('cancel', () => {
  test('a queued job leaves the queue without decoding, and the positions behind it move up', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    const c = h.enqueue('/files/c.wav')

    expect(h.queue.cancel(b.job.id)).toBe(true)
    expect(await b.job.result).toMatchObject({
      status: 'failed',
      code: 'cancelled',
    })
    expect(last(c.events)).toEqual({ type: 'queued', position: 1 })
    expect(h.queue.snapshot().map((j) => j.fileName)).toEqual([
      'a.wav',
      'c.wav',
    ])
    expect(h.queue.cancel(b.job.id)).toBe(false)

    a.job.cancel()
    await a.job.result
    await flush()
    expect(h.decodes.map((d) => d.input)).toEqual([
      '/files/a.wav',
      '/files/c.wav',
    ])
    c.job.cancel()
    await c.job.result
  })

  test('a running decode is stopped and its temp directory removed', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    expect(h.queue.cancel(a.job.id)).toBe(true)
    expect(h.decodes[0].signal.aborted).toBe(true)
    expect(await a.job.result).toMatchObject({ code: 'cancelled' })
    expect(h.removed).toEqual(['/tmp/job-1'])
    await flush()
    expect(h.decodes[1].input).toBe('/files/b.wav')
    b.job.cancel()
    await b.job.result
  })

  test('a running engine killed by the cancel is cancelled, not engine_failed', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    job.cancel()
    expect(h.transcribes[0].request.signal?.aborted).toBe(true)
    expect(await job.result).toMatchObject({
      status: 'failed',
      code: 'cancelled',
    })
    expect(h.removed).toEqual(['/tmp/job-1'])
    expect(h.timers.size).toBe(0)
  })

  test('a finished job ignores it', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(transcript('done'))
    await job.result
    job.cancel()
    expect(h.queue.cancel(job.id)).toBe(false)
    expect(await job.result).toMatchObject({ status: 'ok', text: 'done' })
  })
})

describe('cancelAll', () => {
  test('aborts the running job synchronously, empties the queue, starts nothing else', async () => {
    const h = harness()
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    const c = h.enqueue('/files/c.wav')

    expect(h.queue.cancelAll()).toBe(3)
    // Before any await: the running decoder's controller is already aborted and its work
    // directory gone, since the app may exit before the run cleans up.
    expect(h.decodes[0].signal.aborted).toBe(true)
    expect(h.removed).toEqual(['/tmp/job-1'])
    expect(h.queue.snapshot().map((j) => j.fileName)).toEqual(['a.wav'])

    for (const { job } of [a, b, c]) {
      expect(await job.result).toMatchObject({
        status: 'failed',
        code: 'cancelled',
      })
    }
    await flush()
    expect(h.decodes.map((d) => d.input)).toEqual(['/files/a.wav'])
    expect(h.removed).toEqual(['/tmp/job-1'])
    expect(h.queue.snapshot()).toEqual([])
  })

  test('aborts a running engine too', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(h.queue.cancelAll()).toBe(1)
    expect(h.transcribes[0].request.signal?.aborted).toBe(true)
    expect(await job.result).toMatchObject({ code: 'cancelled' })
  })

  test('an idle queue has nothing to cancel', () => {
    expect(harness().queue.cancelAll()).toBe(0)
  })
})

describe('stale work directories', () => {
  test('are swept once, when the queue is created', () => {
    let sweeps = 0
    const queue = createFileTranscriptionQueue({
      ...harnessDeps(),
      removeStaleWorkDirs: () => {
        sweeps += 1
      },
    })
    expect(sweeps).toBe(1)
    queue.snapshot()
    expect(sweeps).toBe(1)
  })

  test('a failing sweep does not stop the queue', () => {
    const queue = createFileTranscriptionQueue({
      ...harnessDeps(),
      removeStaleWorkDirs: () => {
        throw new Error('EACCES')
      },
    })
    expect(queue.snapshot()).toEqual([])
  })
})

describe('failures', () => {
  test('refused at once, never queued: unknown Speech Model, unknown language, missing file, missing weights', async () => {
    const h = harness({
      files: { '/files/gone.wav': 'missing', '/files/dir': 'not_a_file' },
      installed: (id) => id !== LARGE_V3,
    })
    const cases: [Partial<FileTranscriptionRequest>, string][] = [
      [{ speechModelId: 'large-v9' }, 'unknown_model'],
      [{ languageId: 'klingon' }, 'unknown_language'],
      [{ filePath: '/files/gone.wav' }, 'input_unreadable'],
      [{ filePath: '/files/dir' }, 'input_unreadable'],
      [{ filePath: 'relative.wav' }, 'internal'],
      [{ speechModelId: LARGE_V3 }, 'model_not_installed'],
    ]
    for (const [extra, code] of cases) {
      const { job, events } = h.enqueue('/files/a.wav', extra)
      expect(await job.result).toMatchObject({ status: 'failed', code })
      expect(events).toEqual([])
    }
    expect(h.decodes).toHaveLength(0)
    expect(h.queue.snapshot()).toEqual([])
  })

  test('weights removed while the job waited are reported when it starts', async () => {
    const h = harness({ speechModelId: LARGE_V3 })
    const a = h.enqueue('/files/a.wav')
    const b = h.enqueue('/files/b.wav')
    h.setInstalled(() => false)
    a.job.cancel()
    await a.job.result
    expect(await b.job.result).toMatchObject({
      status: 'failed',
      code: 'model_not_installed',
    })
    expect(h.decodes).toHaveLength(1)
  })

  test.each([
    ['input_unreadable', 'not a readable audio or video file'],
    ['no_audio', 'the file has no audio track'],
    ['internal', 'CodictateMediaHelper failed (exit 5)'],
  ] as const)(
    'a decode that fails with %s keeps its code',
    async (code, message) => {
      const h = harness()
      const { job } = h.enqueue('/files/a.mov')
      h.decodes[0].done.resolve({ status: 'failed', code, message })
      const result = await job.result
      expect(result).toMatchObject({ status: 'failed', code })
      if (result.status === 'failed') expect(result.message).toContain(message)
      expect(h.transcribes).toHaveLength(0)
      expect(h.removed).toEqual(['/tmp/job-1'])
    }
  )

  test('an unreadable decoded WAV is internal', async () => {
    const h = harness({ audioSeconds: null })
    const { job } = h.enqueue('/files/a.mov')
    h.decodes[0].done.resolve(decoded)
    expect(await job.result).toMatchObject({ code: 'internal' })
  })

  test('an engine failure is engine_failed, naming the Speech Model and not the Dictation sentence', async () => {
    const h = harness()
    const { job } = h.enqueue('/files/a.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    h.transcribes[0].done.resolve(
      failedTranscription('engine_exited_nonzero', HVISKE, 'exit 1: ggml')
    )
    const result = await job.result
    expect(result).toMatchObject({ status: 'failed', code: 'engine_failed' })
    if (result.status === 'failed') {
      expect(result.message).toContain('Hviske V5 Tiny Q5')
      expect(result.message).toContain('exit 1: ggml')
      expect(result.message).not.toContain('pasted')
    }
  })
})

describe('per-call overrides', () => {
  test('a Speech Model override runs that Speech Model, and its language is coerced', async () => {
    const h = harness({
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'fr',
    })
    const { job } = h.enqueue('/files/a.wav', {
      speechModelId: PARAKEET,
      languageId: 'da',
    })
    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(h.transcribes[0].request).toMatchObject({
      engineId: 'whisperkit',
      speechModelId: PARAKEET,
      modelDir: `/models/${PARAKEET}`,
    })
    h.transcribes[0].done.resolve(transcript('hello'))
    expect(await job.result).toMatchObject({
      speechModelId: PARAKEET,
      engine: 'parakeet',
      language: null,
    })
  })

  test('a language override applies to this call only', async () => {
    const h = harness({
      speechModelId: LARGE_V3,
      transcriptionLanguageId: 'fr',
    })
    const first = h.enqueue('/files/a.wav', { languageId: 'de' })
    const second = h.enqueue('/files/b.wav')
    h.decodes[0].done.resolve(decoded)
    await flush()
    expect(h.transcribes[0].request).toMatchObject({ languageCode: 'de' })
    h.transcribes[0].done.resolve(transcript('a'))
    expect(await first.job.result).toMatchObject({ language: 'de' })
    await flush()
    h.decodes[1].done.resolve(decoded)
    await flush()
    expect(h.transcribes[1].request).toMatchObject({ languageCode: 'fr' })
    h.transcribes[1].done.resolve(transcript('b'))
    expect(await second.job.result).toMatchObject({
      language: 'fr',
      engine: 'whisper',
    })
  })
})
