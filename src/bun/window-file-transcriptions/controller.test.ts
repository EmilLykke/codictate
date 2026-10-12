import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import type {
  FileTranscriptionJob,
  FileTranscriptionJobSnapshot,
  FileTranscriptionQueue,
  FileTranscriptionRequest,
  FileTranscriptionResult,
} from '../file-transcription'
import type { FileTranscriptionsState } from '../../shared/types'
import {
  createWindowFileTranscriptions,
  type WindowFileTranscriptionsDeps,
} from './controller'
import { queueItemsFromSnapshot } from './view'

/** A queue that runs nothing: the test settles each job by hand. */
function fakeQueue() {
  const jobs: {
    request: FileTranscriptionRequest
    id: string
    resolve: (result: FileTranscriptionResult) => void
  }[] = []
  const listeners = new Set<(jobs: FileTranscriptionJobSnapshot[]) => void>()
  const cancelled: string[] = []
  let next = 0
  const queue: FileTranscriptionQueue = {
    enqueue(request) {
      const id = `job-${++next}`
      let resolve!: (result: FileTranscriptionResult) => void
      const result = new Promise<FileTranscriptionResult>((r) => {
        resolve = r
      })
      jobs.push({ request, id, resolve })
      const job: FileTranscriptionJob = {
        id,
        result,
        onEvent: () => () => {},
        cancel: () => {},
      }
      return job
    },
    snapshot: () => [],
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    cancelAll: () => 0,
    cancel(jobId) {
      cancelled.push(jobId)
      return true
    },
  }
  return { queue, jobs, listeners, cancelled }
}

const ok = (filePath: string, text: string): FileTranscriptionResult => ({
  status: 'ok',
  filePath,
  text,
  language: null,
  speechModelId: 'large-v3-turbo-q5_0',
  engine: 'whisper',
  audioSeconds: 12.5,
})

function setup(overrides: Partial<WindowFileTranscriptionsDeps> = {}) {
  const fake = fakeQueue()
  const pushes: FileTranscriptionsState[] = []
  const history: {
    transcript: string
    fileName: string
    durationMs: number
  }[] = []
  const written = new Map<string, string>()
  const deps: WindowFileTranscriptionsDeps = {
    queue: fake.queue,
    chooseFiles: async () => [],
    saveToHistory: async (entry) => {
      history.push(entry)
      return true
    },
    writeNewFile(path, text) {
      if (written.has(path)) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
      written.set(path, text)
    },
    fallbackFolder: () => '/Users/me/Downloads',
    reveal: () => {},
    now: () => 1_000,
    onChange: (state) => pushes.push(state),
    log: () => {},
    ...overrides,
  }
  const controller = createWindowFileTranscriptions(deps)
  return { controller, fake, pushes, history, written }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('window File Transcriptions', () => {
  test('each file is its own window job, using the selected Speech Model', () => {
    const { controller, fake } = setup()
    expect(controller.transcribe(['/a/one.m4a', '', '/a/two.wav'])).toBe(2)
    expect(fake.jobs.map((job) => job.request)).toEqual([
      { filePath: '/a/one.m4a', origin: { kind: 'window' } },
      { filePath: '/a/two.wav', origin: { kind: 'window' } },
    ])
  })

  test('a finished transcript is kept for the session and saved to History', async () => {
    const { controller, fake, history, pushes } = setup()
    controller.transcribe(['/a/one.m4a'])
    fake.jobs[0].resolve(ok('/a/one.m4a', 'hello there'))
    await settled()

    expect(history).toEqual([
      { transcript: 'hello there', fileName: 'one.m4a', durationMs: 12_500 },
    ])
    expect(controller.state().finished).toEqual([
      {
        id: 'job-1',
        fileName: 'one.m4a',
        filePath: '/a/one.m4a',
        finishedAt: 1_000,
        status: 'ok',
        text: 'hello there',
        audioSeconds: 12.5,
        speechModelId: 'large-v3-turbo-q5_0',
        savedToHistory: true,
        savedTextPath: null,
      },
    ])
    expect(pushes[pushes.length - 1]?.finished[0]).toMatchObject({
      savedToHistory: true,
    })
  })

  test('silence and failures never reach History; History off says not saved', async () => {
    const { controller, fake, history } = setup()
    controller.transcribe(['/a/quiet.wav', '/a/broken.mov'])
    fake.jobs[0].resolve(ok('/a/quiet.wav', '   '))
    fake.jobs[1].resolve({
      status: 'failed',
      code: 'no_audio',
      message: 'The file has no audio track: /a/broken.mov',
    })
    await settled()
    expect(history).toEqual([])
    expect(controller.state().finished.map((o) => o.status)).toEqual([
      'failed',
      'ok',
    ])

    const off = setup({ saveToHistory: async () => false })
    off.controller.transcribe(['/a/x.m4a'])
    off.fake.jobs[0].resolve(ok('/a/x.m4a', 'words'))
    await settled()
    expect(off.controller.state().finished[0]).toMatchObject({
      savedToHistory: false,
    })
  })

  test('save as text writes beside the original and never overwrites', async () => {
    const { controller, fake, written } = setup()
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'first line'))
    await settled()

    expect(controller.saveAsText('job-1')).toEqual({
      ok: true,
      path: '/a/talk.txt',
      location: 'source-folder',
    })
    expect(controller.saveAsText('job-1')).toEqual({
      ok: true,
      path: '/a/talk 2.txt',
      location: 'source-folder',
    })
    expect(written.get('/a/talk.txt')).toBe('first line\n')
    expect(controller.state().finished[0]).toMatchObject({
      savedTextPath: '/a/talk 2.txt',
    })
  })

  test('save as text falls back when the folder cannot be written', async () => {
    const { controller, fake } = setup({
      writeNewFile(path) {
        if (path.startsWith('/Volumes/')) {
          throw Object.assign(new Error('read-only'), { code: 'EROFS' })
        }
      },
    })
    controller.transcribe(['/Volumes/Card/clip.mov'])
    fake.jobs[0].resolve(ok('/Volumes/Card/clip.mov', 'x'))
    await settled()
    expect(controller.saveAsText('job-1')).toEqual({
      ok: true,
      path: '/Users/me/Downloads/clip.txt',
      location: 'fallback-folder',
    })
    expect(controller.saveAsText('nope')).toMatchObject({ ok: false })
  })

  test('cancel goes to the shared queue; dismiss forgets a finished card', async () => {
    const { controller, fake } = setup()
    expect(controller.cancel('cli-7')).toBe(true)
    expect(fake.cancelled).toEqual(['cli-7'])

    controller.transcribe(['/a/one.m4a'])
    fake.jobs[0].resolve(ok('/a/one.m4a', 'x'))
    await settled()
    expect(controller.dismiss('job-1')).toBe(true)
    expect(controller.dismiss('job-1')).toBe(false)
    expect(controller.state().finished).toEqual([])
  })

  test('the dialog opens where the last file came from', async () => {
    const asked: (string | null)[] = []
    const { controller } = setup({
      chooseFiles: async (folder) => {
        asked.push(folder)
        return ['/b/next.m4a']
      },
    })
    expect(await controller.chooseAndTranscribe()).toBe(1)
    expect(await controller.chooseAndTranscribe()).toBe(1)
    expect(asked).toEqual([null, '/b'])
  })

  test('queue changes are pushed, command-line jobs included', () => {
    const { fake, pushes } = setup()
    for (const listener of fake.listeners) listener([])
    expect(pushes).toHaveLength(1)
  })
})

describe('queueItemsFromSnapshot', () => {
  const job = (
    id: string,
    state: FileTranscriptionJobSnapshot['state'],
    origin: FileTranscriptionJobSnapshot['origin']
  ): FileTranscriptionJobSnapshot => ({
    id,
    fileName: basename(`/x/${id}.m4a`),
    filePath: `/x/${id}.m4a`,
    origin,
    state,
    enqueuedAt: 1,
    startedAt: state === 'queued' ? null : 2,
    audioSeconds: state === 'transcribing' ? 60 : null,
  })

  test('running first with no position, then places in line, with the caller', () => {
    expect(
      queueItemsFromSnapshot([
        job('a', 'transcribing', {
          kind: 'command-line',
          callerName: 'Terminal',
        }),
        job('b', 'queued', { kind: 'window' }),
        job('c', 'queued', { kind: 'command-line', callerName: null }),
      ])
    ).toEqual([
      {
        id: 'a',
        fileName: 'a.m4a',
        origin: 'command-line',
        callerName: 'Terminal',
        state: 'transcribing',
        position: null,
        startedAt: 2,
        audioSeconds: 60,
      },
      {
        id: 'b',
        fileName: 'b.m4a',
        origin: 'window',
        callerName: null,
        state: 'queued',
        position: 1,
        startedAt: null,
        audioSeconds: null,
      },
      {
        id: 'c',
        fileName: 'c.m4a',
        origin: 'command-line',
        callerName: null,
        state: 'queued',
        position: 2,
        startedAt: null,
        audioSeconds: null,
      },
    ])
  })
})
