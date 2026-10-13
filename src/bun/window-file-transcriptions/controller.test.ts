import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import type {
  FileTranscriptionJob,
  FileTranscriptionJobSnapshot,
  FileTranscriptionQueue,
  FileTranscriptionRequest,
  FileTranscriptionResult,
} from '../file-transcription'
import type {
  FileTranscriptionsState,
  TranscriptExportResult,
} from '../../shared/types'
import type { FileTranscriptionHistoryRecord } from '../utils/history/history-manager'
import type { TimedTranscript } from '../../shared/timed-transcript'
import type {
  RenderedTranscript,
  TranscriptExportFormat,
  TranscriptExportSource,
} from '../../shared/transcript-export'
import {
  createWindowFileTranscriptions,
  type WindowFileTranscriptionsDeps,
} from './controller'
import type { SaveDialogRequest } from './paths'
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

const ok = (
  filePath: string,
  text: string,
  timedTranscript: TimedTranscript | null = null
): FileTranscriptionResult => ({
  status: 'ok',
  filePath,
  text,
  language: null,
  speechModelId: 'large-v3-turbo-q5_0',
  engine: 'whisper',
  audioSeconds: 12.5,
  translated: false,
  processingSeconds: 3.2,
  timedTranscript,
})

const timed = (text: string): TimedTranscript => ({
  text,
  parts: [{ text, start: 0, end: 1.5 }],
})

/** Stands in for the shared renderer: captions need timings, like the real one. */
function fakeRender(
  format: TranscriptExportFormat,
  source: TranscriptExportSource
): RenderedTranscript {
  if ((format === 'srt' || format === 'vtt') && !source.timedTranscript) {
    return {
      ok: false,
      reason: 'no_timed_transcript',
      message: 'No timings.',
    }
  }
  return { ok: true, content: `${format}:${source.text}` }
}

function fakeFileName(
  sourceFileName: string,
  format: TranscriptExportFormat
): string {
  const dot = sourceFileName.lastIndexOf('.')
  const stem = dot > 0 ? sourceFileName.slice(0, dot) : sourceFileName
  return `${stem}.${format}`
}

function setup(overrides: Partial<WindowFileTranscriptionsDeps> = {}) {
  const fake = fakeQueue()
  const pushes: FileTranscriptionsState[] = []
  const history: FileTranscriptionHistoryRecord[] = []
  const written = new Map<string, string>()
  const exports: TranscriptExportResult[] = []
  const saveAsks: SaveDialogRequest[] = []
  const writes: string[] = []
  const remembered: string[] = []
  const revealed: string[] = []
  let lastExportFolder: string | null = null
  const deps: WindowFileTranscriptionsDeps = {
    queue: fake.queue,
    chooseFiles: async () => [],
    saveToHistory: async (record) => {
      history.push(record)
      return true
    },
    // Stands in for the user keeping the offered name and saving in ~/Exports.
    chooseSaveLocation: async (request) => {
      saveAsks.push(request)
      return `/Users/me/Exports/${request.defaultName}`
    },
    lastExportFolder: () => lastExportFolder,
    rememberExportFolder: async (folder) => {
      remembered.push(folder)
      lastExportFolder = folder
    },
    loadHistoryExportSource: async () => null,
    pushExportResult: (result) => exports.push(result),
    isDirectory: (path) =>
      ['/a', '/Users/me', '/Users/me/Exports'].includes(path),
    homeFolder: () => '/Users/me',
    writeFile(path, text) {
      writes.push(path)
      written.set(path, text)
    },
    reveal: (path) => revealed.push(path),
    now: () => 1_000,
    onChange: (state) => pushes.push(state),
    log: () => {},
    renderTranscript: fakeRender,
    transcriptExportFileName: fakeFileName,
    ...overrides,
  }
  const controller = createWindowFileTranscriptions(deps)
  return {
    controller,
    fake,
    pushes,
    history,
    written,
    exports,
    saveAsks,
    writes,
    remembered,
    revealed,
  }
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
    fake.jobs[0].resolve(ok('/a/one.m4a', 'hello there', timed('hello there')))
    await settled()

    expect(history).toEqual([
      {
        transcript: 'hello there',
        fileName: 'one.m4a',
        filePath: '/a/one.m4a',
        durationMs: 12_500,
        processingSeconds: 3.2,
        speechModelId: 'large-v3-turbo-q5_0',
        language: null,
        translated: false,
        timedTranscript: timed('hello there'),
      },
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
        processingSeconds: 3.2,
        language: null,
        translated: false,
        hasTimedTranscript: true,
        lastExport: null,
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

  test('export asks in the Save dialog, offering the original name, and writes where the user says', async () => {
    const { controller, fake, written, writes, exports, saveAsks, remembered } =
      setup()
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'first line', timed('first line')))
    await settled()

    const target = { kind: 'window', id: 'job-1' } as const
    expect(await controller.exportTranscript(target, 'srt')).toEqual({
      target,
      status: 'saved',
      format: 'srt',
      path: '/Users/me/Exports/talk.srt',
    })
    // The same name again: the dialog asked before replacing, so the file is replaced.
    await controller.exportTranscript(target, 'srt')
    expect(writes).toEqual([
      '/Users/me/Exports/talk.srt',
      '/Users/me/Exports/talk.srt',
    ])
    expect(written.get('/Users/me/Exports/talk.srt')).toBe('srt:first line')
    expect(exports.map((r) => r.status)).toEqual(['saved', 'saved'])
    // First the file's own folder, then the folder last saved to.
    expect(saveAsks).toEqual([
      { defaultName: 'talk.srt', directory: '/a', extension: 'srt' },
      {
        defaultName: 'talk.srt',
        directory: '/Users/me/Exports',
        extension: 'srt',
      },
    ])
    expect(remembered).toEqual(['/Users/me/Exports', '/Users/me/Exports'])
    expect(controller.state().finished[0]).toMatchObject({
      lastExport: { format: 'srt', path: '/Users/me/Exports/talk.srt' },
    })
  })

  test('a name and folder changed in the dialog are used as they are', async () => {
    const { controller, fake, writes, remembered, revealed } = setup({
      chooseSaveLocation: async () => '/Users/me/Talks/board notes.txt',
    })
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'x'))
    await settled()
    const target = { kind: 'window', id: 'job-1' } as const
    expect(await controller.exportTranscript(target, 'txt')).toMatchObject({
      status: 'saved',
      path: '/Users/me/Talks/board notes.txt',
    })
    expect(writes).toEqual(['/Users/me/Talks/board notes.txt'])
    expect(remembered).toEqual(['/Users/me/Talks'])
    controller.revealExport(target)
    expect(revealed).toEqual(['/Users/me/Talks/board notes.txt'])
  })

  test('the dialog starts at home when neither folder is still there', async () => {
    const { controller, fake, saveAsks } = setup({
      lastExportFolder: () => '/Volumes/Gone',
    })
    controller.transcribe(['/Volumes/Card/clip.mov'])
    fake.jobs[0].resolve(ok('/Volumes/Card/clip.mov', 'x'))
    await settled()
    await controller.exportTranscript({ kind: 'window', id: 'job-1' }, 'txt')
    expect(saveAsks.map((ask) => ask.directory)).toEqual(['/Users/me'])
  })

  test('a cancelled dialog writes nothing and says cancelled', async () => {
    const { controller, fake, written, exports, remembered } = setup({
      chooseSaveLocation: async () => null,
    })
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'x'))
    await settled()
    const target = { kind: 'window', id: 'job-1' } as const
    expect(await controller.exportTranscript(target, 'txt')).toEqual({
      target,
      status: 'cancelled',
    })
    expect(written.size).toBe(0)
    expect(remembered).toEqual([])
    expect(exports).toEqual([{ target, status: 'cancelled' }])
  })

  test('a Save dialog that fails says so and writes nothing', async () => {
    const { controller, fake, writes, exports, remembered } = setup({
      chooseSaveLocation: async () => {
        throw new Error('The Save dialog gave no answer: ')
      },
    })
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'x'))
    await settled()
    const target = { kind: 'window', id: 'job-1' } as const
    expect(await controller.exportTranscript(target, 'txt')).toEqual({
      target,
      status: 'failed',
      format: 'txt',
      message: "Couldn't save the file.",
    })
    expect(writes).toEqual([])
    expect(remembered).toEqual([])
    expect(exports).toHaveLength(1)
  })

  test('an unwritable folder asks for another one; other errors say so plainly', async () => {
    for (const [code, message] of [
      ['EACCES', "Codictate can't save in that folder. Choose another folder."],
      ['EPERM', "Codictate can't save in that folder. Choose another folder."],
      ['EROFS', "Codictate can't save in that folder. Choose another folder."],
      ['EIO', "Couldn't save the file."],
    ]) {
      const { controller, fake, remembered } = setup({
        writeFile() {
          throw Object.assign(new Error('nope'), { code })
        },
      })
      controller.transcribe(['/a/talk.m4a'])
      fake.jobs[0].resolve(ok('/a/talk.m4a', 'x'))
      await settled()
      const target = { kind: 'window', id: 'job-1' } as const
      expect(await controller.exportTranscript(target, 'json')).toEqual({
        target,
        status: 'failed',
        format: 'json',
        message,
      })
      expect(remembered).toEqual([])
    }
  })

  test('captions without timings are refused before the dialog opens', async () => {
    const { controller, fake, saveAsks, exports } = setup()
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'no timings here'))
    await settled()
    expect(controller.state().finished[0]).toMatchObject({
      hasTimedTranscript: false,
    })
    const target = { kind: 'window', id: 'job-1' } as const
    expect(await controller.exportTranscript(target, 'vtt')).toEqual({
      target,
      status: 'failed',
      format: 'vtt',
      message: 'No timings.',
    })
    expect(saveAsks).toEqual([])
    expect(exports).toHaveLength(1)
    // JSON is always on offer.
    expect((await controller.exportTranscript(target, 'json')).status).toBe(
      'saved'
    )
  })

  test('a History entry exports from History, and Show finds it', async () => {
    const source: TranscriptExportSource = {
      fileName: 'old memo.m4a',
      speechModelId: null,
      language: null,
      translated: false,
      audioSeconds: 30,
      processingSeconds: null,
      text: 'from history',
      timedTranscript: null,
    }
    const asked: string[] = []
    const { controller, written, saveAsks, revealed } = setup({
      loadHistoryExportSource: async (id) => {
        asked.push(id)
        return id === 'h1'
          ? { source, filePath: '/Users/me/old memo.m4a' }
          : null
      },
    })
    const target = { kind: 'history', id: 'h1' } as const
    expect(await controller.exportTranscript(target, 'txt')).toMatchObject({
      status: 'saved',
      path: '/Users/me/Exports/old memo.txt',
    })
    expect(written.get('/Users/me/Exports/old memo.txt')).toBe(
      'txt:from history'
    )
    expect(saveAsks).toEqual([
      { defaultName: 'old memo.txt', directory: '/Users/me', extension: 'txt' },
    ])
    controller.revealExport(target)
    expect(revealed).toEqual(['/Users/me/Exports/old memo.txt'])

    expect(
      await controller.exportTranscript({ kind: 'history', id: 'gone' }, 'txt')
    ).toMatchObject({
      status: 'failed',
      message: "That transcript isn't here anymore.",
    })
    expect(asked).toEqual(['h1', 'gone'])
  })

  test('Show reveals the last export of a window result; a dismissed one is gone', async () => {
    const { controller, fake, revealed } = setup()
    controller.transcribe(['/a/talk.m4a'])
    fake.jobs[0].resolve(ok('/a/talk.m4a', 'x', timed('x')))
    await settled()
    const target = { kind: 'window', id: 'job-1' } as const
    controller.revealExport(target)
    expect(revealed).toEqual([])
    await controller.exportTranscript(target, 'vtt')
    controller.revealExport(target)
    expect(revealed).toEqual(['/Users/me/Exports/talk.vtt'])

    controller.dismiss('job-1')
    expect(await controller.exportTranscript(target, 'txt')).toMatchObject({
      status: 'failed',
    })
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
