import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_VERSION,
  type CommandName,
  type CommandRequestOf,
  type ProgressLikeEvent,
  type ServerEvent,
} from '../../shared/command-line-protocol'
import {
  CURATED_SPEECH_MODELS,
  DEFAULT_MODEL_ID,
  SPEECH_MODELS,
} from '../../shared/speech-models'
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../shared/transcription-languages'
import type {
  FileTranscriptionEvent,
  FileTranscriptionJob,
  FileTranscriptionJobSnapshot,
  FileTranscriptionRequest,
  FileTranscriptionResult,
} from '../file-transcription/types'
import { selectFileTranscription } from '../file-transcription/plan'
import {
  DOWNLOAD_EVENT_INTERVAL_MS,
  createCommandHandlers,
  createDownloadEventThrottle,
  deferredCommandHandlers,
  type CommandLineDeps,
} from './handlers'
import type {
  ModelDownload,
  ModelDownloadOutcome,
  ModelDownloadRequester,
} from '../model-operations'
import type { TranscriptionSettingsPatch } from '../../shared/types'
import type {
  TranscriptExportFormat,
  TranscriptExportSource,
} from '../../shared/transcript-export'
import type { TimedTranscript } from '../../shared/timed-transcript'
import { speechModelSelectionPatch } from '../../shared/speech-model-selection'
import { createCommandLineSession, type HandlerContext } from './session'
import type {
  CommandLineDictationControl,
  CommandLineDictationOptions,
  CommandLineDictationResult,
  CommandLineDictationStart,
} from '../dictation/command-line-dictation'
import {
  blockedDictationPlan,
  type RunnableDictationPlan,
} from '../../shared/dictation-plan'

const HVISKE_ID = SPEECH_MODELS.find((m) => m.engine === 'hviske')!.id
const EDDA_ID = 'edda-v0.2-q5_0'
const SMALL_ID = 'small-q5_1'
const PARAKEET_ID = 'parakeet-tdt-0.6b-v3'
const NON_CURATED_ID = SPEECH_MODELS.find((m) => !m.curated && !m.bundled)!.id

class FakeJob implements FileTranscriptionJob {
  readonly id = 'job-1'
  readonly listeners = new Set<(event: FileTranscriptionEvent) => void>()
  cancelled = 0
  settle!: (result: FileTranscriptionResult) => void
  readonly result = new Promise<FileTranscriptionResult>((resolve) => {
    this.settle = resolve
  })
  onEvent(listener: (event: FileTranscriptionEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: FileTranscriptionEvent) {
    for (const listener of this.listeners) listener(event)
  }
  cancel() {
    this.cancelled += 1
    this.settle({
      status: 'failed',
      code: 'cancelled',
      message: 'The File Transcription was cancelled.',
    })
  }
}

/** Downloads and removals that touch no disk: each outcome is settled by the test. */
class FakeModels {
  downloads: { id: string; requester: ModelDownloadRequester }[] = []
  removes: string[] = []
  removeAnswer = true
  released = 0
  readonly listeners = new Set<(fraction: number) => void>()
  settle: (outcome: ModelDownloadOutcome) => void = () => {}

  download(id: string, requester: ModelDownloadRequester): ModelDownload {
    this.downloads.push({ id, requester })
    const result = new Promise<ModelDownloadOutcome>((resolve) => {
      this.settle = resolve
    })
    return {
      onProgress: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      result,
      release: () => {
        this.released += 1
      },
    }
  }
  async remove(id: string) {
    this.removes.push(id)
    return this.removeAnswer
  }
  progress(fraction: number) {
    for (const listener of this.listeners) listener(fraction)
  }
}

/** A recording module that records nothing: each start is scripted by the test. */
class FakeDictation implements CommandLineDictationControl {
  starts: CommandLineDictationOptions[] = []
  stops = 0
  cancels = 0
  stopAnyAnswer = false
  active: ReturnType<CommandLineDictationControl['getActiveDictation']> = {
    active: false,
    startedBy: null,
  }
  /** What the next start answers with; `started` hands back a controllable handle. */
  nextStart: Exclude<CommandLineDictationStart, { status: 'started' }> | null =
    null
  settle: (result: CommandLineDictationResult) => void = () => {}

  async startCommandLineDictation(options: CommandLineDictationOptions) {
    this.starts.push(options)
    if (this.nextStart !== null) return this.nextStart
    const result = new Promise<CommandLineDictationResult>((resolve) => {
      this.settle = resolve
    })
    return {
      status: 'started' as const,
      stop: () => {
        this.stops += 1
      },
      cancel: () => {
        this.cancels += 1
      },
      result,
    }
  }
  stopAnyDictation() {
    return this.stopAnyAnswer
  }
  getActiveDictation() {
    return this.active
  }
}

function fakeDeps(overrides: Partial<CommandLineDeps> = {}) {
  const enqueued: FileTranscriptionRequest[] = []
  const jobs: FakeJob[] = []
  let shown = 0
  let snapshot: FileTranscriptionJobSnapshot[] = []
  const dictation = new FakeDictation()
  const models = new FakeModels()
  const notifications: { title: string; body: string }[] = []
  const writes: TranscriptionSettingsPatch[] = []
  const renders: [TranscriptExportFormat, TranscriptExportSource][] = []
  const deps: CommandLineDeps = {
    app: { version: '0.0.62', channel: 'stable', identifier: 'app.codictate' },
    isOnboardingCompleted: () => true,
    getMicrophone: () => 'granted',
    getCommandLineControl: () => false,
    isMicrophoneGranted: () => true,
    dictation,
    notify: (n) => notifications.push(n),
    getSpeechModelId: () => DEFAULT_MODEL_ID,
    getTranscriptionLanguageId: () => 'auto',
    isModelAvailable: (id) =>
      SPEECH_MODELS.find((m) => m.id === id)?.bundled === true ||
      id === NON_CURATED_ID,
    fileTranscriptions: {
      enqueue: (request) => {
        enqueued.push(request)
        const job = new FakeJob()
        jobs.push(job)
        return job
      },
      snapshot: () => snapshot,
    },
    fileSettings: {
      getFileTranscriptionSettings: () => ({
        speechModelId: SMALL_ID,
        transcriptionLanguageId: 'auto',
        translateToEnglish: false,
      }),
    },
    renderTranscript: (format, source) => {
      renders.push([format, source])
      return { ok: true, content: `<${format}>${source.text}</${format}>\n` }
    },
    showMainWindow: () => {
      shown += 1
    },
    getStreamMode: () => false,
    updateTranscriptionSettings: async (patch) => {
      writes.push(patch)
      return true
    },
    models,
    ...overrides,
  }
  return {
    deps,
    dictation,
    models,
    writes,
    notifications,
    enqueued,
    jobs,
    renders,
    get shown() {
      return shown
    },
    setSnapshot: (jobs: FileTranscriptionJobSnapshot[]) => {
      snapshot = jobs
    },
  }
}

function context(emitted: ProgressLikeEvent[] = []): {
  ctx: HandlerContext
  abort: AbortController
} {
  const abort = new AbortController()
  return {
    abort,
    ctx: {
      emit: (e) => emitted.push(e),
      signal: abort.signal,
      onStop: () => {},
    },
  }
}

function req<C extends CommandName>(
  command: C,
  args: CommandRequestOf<C>['args'],
  callerName: string | null = 'Terminal'
): CommandRequestOf<C> {
  return {
    contractVersion: CONTRACT_VERSION,
    command,
    args,
    caller: { name: callerName, pid: 1 },
  }
}

const snapshotJob = (
  state: FileTranscriptionJobSnapshot['state']
): FileTranscriptionJobSnapshot => ({
  id: state,
  fileName: 'a.wav',
  filePath: '/a.wav',
  origin: { kind: 'window' },
  state,
  enqueuedAt: 0,
  startedAt: null,
  audioSeconds: null,
})

describe('status', () => {
  test('has the docs/CLI.md shape', async () => {
    const f = fakeDeps()
    f.setSnapshot([
      snapshotJob('transcribing'),
      snapshotJob('queued'),
      snapshotJob('queued'),
    ])
    const h = createCommandHandlers(f.deps)
    const result = await h.status(req('status', {}), context().ctx)
    const model = SPEECH_MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!
    expect(result).toEqual({
      type: 'result',
      contractVersion: 1,
      app: {
        version: '0.0.62',
        channel: 'stable',
        identifier: 'app.codictate',
      },
      onboardingCompleted: true,
      microphone: 'granted',
      commandLineControl: false,
      dictation: { active: false, startedBy: null },
      speechModel: {
        id: DEFAULT_MODEL_ID,
        label: model.label,
        engine: 'whisper',
        installed: true,
      },
      transcriptionLanguage: {
        id: 'auto',
        label: TRANSCRIPTION_LANGUAGE_OPTIONS[0].label,
      },
      fileTranscriptions: { running: 1, queued: 2 },
    })
  })

  test('reports a running Dictation and a Danish-only Speech Model', async () => {
    const f = fakeDeps({
      getSpeechModelId: () => HVISKE_ID,
      getTranscriptionLanguageId: () => 'da',
    })
    f.dictation.active = { active: true, startedBy: 'shortcut' }
    const result = await createCommandHandlers(f.deps).status(
      req('status', {}),
      context().ctx
    )
    expect(result).toMatchObject({
      dictation: { active: true, startedBy: 'shortcut' },
      speechModel: { id: HVISKE_ID, engine: 'hviske', installed: false },
      transcriptionLanguage: { id: 'da', label: 'Danish' },
    })
  })
})

describe('models.list', () => {
  test('curated plus installed by default', async () => {
    const f = fakeDeps()
    const result = await createCommandHandlers(f.deps)['models.list'](
      req('models.list', { all: false }),
      context().ctx
    )
    if (result.type !== 'result') throw new Error('expected a result')
    const ids = result.models.map((m) => m.id)
    expect(ids).toEqual(
      SPEECH_MODELS.filter(
        (m) => m.curated || m.bundled || m.id === NON_CURATED_ID
      ).map((m) => m.id)
    )
    for (const curated of CURATED_SPEECH_MODELS)
      expect(ids).toContain(curated.id)
    const selected = result.models.filter((m) => m.selected)
    expect(selected.map((m) => m.id)).toEqual([DEFAULT_MODEL_ID])
    const extra = result.models.find((m) => m.id === NON_CURATED_ID)!
    expect(extra).toMatchObject({
      installed: true,
      curated: false,
      bundled: false,
    })
    expect(Object.keys(extra).sort()).toEqual(
      [
        'bundled',
        'curated',
        'downloadSizeMB',
        'engine',
        'id',
        'installed',
        'label',
        'selected',
      ].sort()
    )
  })

  test('all lists every Speech Model with public engine names', async () => {
    const result = await createCommandHandlers(fakeDeps().deps)['models.list'](
      req('models.list', { all: true }),
      context().ctx
    )
    if (result.type !== 'result') throw new Error('expected a result')
    expect(result.models).toHaveLength(SPEECH_MODELS.length)
    for (const model of result.models) {
      expect(['whisper', 'parakeet', 'hviske']).toContain(model.engine)
    }
  })
})

describe('languages.list', () => {
  test('every Transcription Language, allowed for the selected Speech Model', async () => {
    const f = fakeDeps({
      getSpeechModelId: () => HVISKE_ID,
      getTranscriptionLanguageId: () => 'da',
    })
    const result = await createCommandHandlers(f.deps)['languages.list'](
      req('languages.list', {}),
      context().ctx
    )
    if (result.type !== 'result') throw new Error('expected a result')
    expect(result.languages).toHaveLength(TRANSCRIPTION_LANGUAGE_OPTIONS.length)
    const allowed = result.languages.filter((l) => l.allowed).map((l) => l.id)
    expect(allowed).toEqual(['auto', 'da'])
    expect(result.languages.filter((l) => l.selected).map((l) => l.id)).toEqual(
      ['da']
    )
  })
})

describe('transcribe', () => {
  test('enqueues with a command-line origin and forwards events and the result', async () => {
    const f = fakeDeps()
    const emitted: ProgressLikeEvent[] = []
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', {
        file: '/abs/memo.m4a',
        speechModelId: HVISKE_ID,
        languageId: null,
        translate: null,
        format: null,
      }),
      context(emitted).ctx
    )
    expect(f.enqueued).toEqual([
      {
        filePath: '/abs/memo.m4a',
        speechModelId: HVISKE_ID,
        languageId: null,
        translateToEnglish: false,
        origin: { kind: 'command-line', callerName: 'Terminal' },
      },
    ])
    const job = f.jobs[0]
    job.emit({ type: 'queued', position: 2 })
    job.emit({
      type: 'progress',
      stage: 'transcribing',
      elapsedSeconds: 1,
      audioSeconds: 61.2,
    })
    job.settle({
      status: 'ok',
      filePath: '/abs/memo.m4a',
      text: 'hej',
      language: 'da',
      speechModelId: HVISKE_ID,
      engine: 'hviske',
      audioSeconds: 61.2,
      translated: false,
      processingSeconds: 4.8,
      timedTranscript: null,
    })
    expect(await running).toEqual({
      type: 'result',
      file: '/abs/memo.m4a',
      text: 'hej',
      language: 'da',
      speechModelId: HVISKE_ID,
      engine: 'hviske',
      audioSeconds: 61.2,
      processingSeconds: 4.8,
      translated: false,
    })
    expect(f.renders).toEqual([])
    expect(emitted).toEqual([
      { type: 'queued', position: 2 },
      {
        type: 'progress',
        stage: 'transcribing',
        elapsedSeconds: 1,
        audioSeconds: 61.2,
      },
    ])
    expect(job.listeners.size).toBe(0)
  })

  test('a failed File Transcription is the error event with its code', async () => {
    const f = fakeDeps()
    const running = createCommandHandlers(f.deps).transcribe(
      req(
        'transcribe',
        {
          file: '/x.mov',
          speechModelId: null,
          languageId: null,
          translate: null,
          format: null,
        },
        null
      ),
      context().ctx
    )
    expect(f.enqueued[0].origin).toEqual({
      kind: 'command-line',
      callerName: null,
    })
    f.jobs[0].settle({
      status: 'failed',
      code: 'no_audio',
      message: 'x.mov has no audio track.',
    })
    expect(await running).toEqual({
      type: 'error',
      code: 'no_audio',
      message: 'x.mov has no audio track.',
    })
  })

  test('a relative path is a usage error and nothing is queued', async () => {
    const f = fakeDeps()
    const result = await createCommandHandlers(f.deps).transcribe(
      req('transcribe', {
        file: 'memo.m4a',
        speechModelId: null,
        languageId: null,
        translate: null,
        format: null,
      }),
      context().ctx
    )
    expect(result).toMatchObject({ type: 'error', code: 'usage' })
    expect(f.enqueued).toHaveLength(0)
  })

  test('a disconnect mid-run cancels the job', async () => {
    const f = fakeDeps()
    const sent: ServerEvent[] = []
    const session = createCommandLineSession(createCommandHandlers(f.deps), {
      send: (e) => sent.push(e),
      end: () => {},
    })
    session.receiveLine(
      JSON.stringify({
        contractVersion: 1,
        command: 'transcribe',
        args: { file: '/abs/memo.m4a' },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.jobs[0].emit({ type: 'queued', position: 1 })
    session.disconnected()
    expect(f.jobs[0].cancelled).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([{ type: 'queued', position: 1 }])
  })

  test('a cancel line cancels the job and answers cancelled', async () => {
    const f = fakeDeps()
    const sent: ServerEvent[] = []
    const session = createCommandLineSession(createCommandHandlers(f.deps), {
      send: (e) => sent.push(e),
      end: () => {},
    })
    session.receiveLine(
      JSON.stringify({
        contractVersion: 1,
        command: 'transcribe',
        args: { file: '/abs/memo.m4a' },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.receiveLine('{"type":"cancel"}')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.jobs[0].cancelled).toBe(1)
    expect(sent).toEqual([
      { type: 'error', code: 'cancelled', message: 'Cancelled' },
    ])
  })
})

const finished = (
  extra: Partial<Extract<FileTranscriptionResult, { status: 'ok' }>> = {}
): FileTranscriptionResult => ({
  status: 'ok',
  filePath: '/abs/clips/memo.m4a',
  text: 'Hello there.',
  language: null,
  speechModelId: SMALL_ID,
  engine: 'whisper',
  audioSeconds: 3.2,
  translated: false,
  processingSeconds: 1.4,
  timedTranscript: null,
  ...extra,
})

function transcribeArgs(
  extra: Partial<CommandRequestOf<'transcribe'>['args']> = {}
): CommandRequestOf<'transcribe'>['args'] {
  return {
    file: '/abs/clips/memo.m4a',
    speechModelId: null,
    languageId: null,
    translate: null,
    format: null,
    ...extra,
  }
}

describe('transcribe: Translate to English', () => {
  test('--translate turns it on; --no-translate and no flag leave it off', async () => {
    for (const [translate, expected] of [
      [true, true],
      [false, false],
      [null, false],
    ] as const) {
      const f = fakeDeps()
      const running = createCommandHandlers(f.deps).transcribe(
        req('transcribe', transcribeArgs({ translate })),
        context().ctx
      )
      expect(f.enqueued[0].translateToEnglish).toBe(expected)
      f.jobs[0].settle(finished({ translated: expected }))
      expect(await running).toMatchObject({
        type: 'result',
        translated: expected,
      })
    }
  })

  test('the File Transcription Settings turning translate on does not translate a call without --translate', async () => {
    const settings = {
      getFileTranscriptionSettings: () => ({
        speechModelId: SMALL_ID,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      }),
      getTranslateDefaultLanguageId: () => 'da',
      getAddPunctuation: () => false,
    }
    const f = fakeDeps({ fileSettings: settings })
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', transcribeArgs({ speechModelId: PARAKEET_ID })),
      context().ctx
    )
    expect(f.enqueued[0].translateToEnglish).toBe(false)
    const selected = selectFileTranscription(settings, f.enqueued[0])
    expect(selected).toMatchObject({
      status: 'ok',
      selection: { speechModelId: PARAKEET_ID, translateToEnglish: false },
    })
    f.jobs[0].settle(finished({ speechModelId: PARAKEET_ID }))
    expect(await running).toMatchObject({ type: 'result', translated: false })
  })

  test('cannot_translate passes through unchanged', async () => {
    const message =
      "Large V3 Turbo can't translate to English. Choose a Whisper Small or Large Speech Model, or turn off Translate to English."
    const f = fakeDeps()
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', transcribeArgs({ translate: true })),
      context().ctx
    )
    f.jobs[0].settle({ status: 'failed', code: 'cannot_translate', message })
    expect(await running).toEqual({
      type: 'error',
      code: 'cannot_translate',
      message,
    })
  })
})

describe('transcribe: --format', () => {
  test('txt and json are rendered from the result, with its facts, into formatted', async () => {
    const timed: TimedTranscript = {
      text: 'Hello there.',
      parts: [{ text: 'Hello there.', start: 0.1, end: 1.3 }],
    }
    for (const format of ['txt', 'json'] as const) {
      const f = fakeDeps()
      const running = createCommandHandlers(f.deps).transcribe(
        req('transcribe', transcribeArgs({ format })),
        context().ctx
      )
      f.jobs[0].settle(finished({ timedTranscript: timed, translated: true }))
      expect(await running).toEqual({
        type: 'result',
        file: '/abs/clips/memo.m4a',
        text: 'Hello there.',
        language: null,
        speechModelId: SMALL_ID,
        engine: 'whisper',
        audioSeconds: 3.2,
        processingSeconds: 1.4,
        translated: true,
        formatted: `<${format}>Hello there.</${format}>\n`,
      })
      expect(f.renders).toEqual([
        [
          format,
          {
            fileName: 'memo.m4a',
            speechModelId: SMALL_ID,
            language: null,
            translated: true,
            audioSeconds: 3.2,
            processingSeconds: 1.4,
            text: 'Hello there.',
            timedTranscript: timed,
          },
        ],
      ])
    }
  })

  test('srt and vtt render too when the Speech Model times its transcript', async () => {
    for (const format of ['srt', 'vtt'] as const) {
      const f = fakeDeps()
      const running = createCommandHandlers(f.deps).transcribe(
        req('transcribe', transcribeArgs({ format })),
        context().ctx
      )
      f.jobs[0].settle(finished())
      expect(await running).toMatchObject({
        type: 'result',
        formatted: `<${format}>Hello there.</${format}>\n`,
      })
    }
  })

  test('captions with a Speech Model that never times its transcript are refused before anything is queued', async () => {
    const viaSettings = fakeDeps({
      fileSettings: {
        getFileTranscriptionSettings: () => ({
          speechModelId: EDDA_ID,
          transcriptionLanguageId: 'da',
          translateToEnglish: false,
        }),
      },
    })
    const viaOverride = fakeDeps()
    for (const [f, speechModelId] of [
      [viaSettings, null],
      [viaOverride, EDDA_ID],
    ] as const) {
      for (const format of ['srt', 'vtt'] as const) {
        const result = await createCommandHandlers(f.deps).transcribe(
          req('transcribe', transcribeArgs({ format, speechModelId })),
          context().ctx
        )
        expect(result).toMatchObject({
          type: 'error',
          code: 'captions_unavailable',
        })
        if (result.type === 'error') {
          expect(result.message).toContain('cannot make captions')
          expect(result.message).not.toContain('—')
        }
      }
      expect(f.enqueued).toEqual([])
    }
  })

  test('the same Speech Model can still make text and JSON', async () => {
    const f = fakeDeps()
    const running = createCommandHandlers(f.deps).transcribe(
      req(
        'transcribe',
        transcribeArgs({ format: 'json', speechModelId: EDDA_ID })
      ),
      context().ctx
    )
    expect(f.enqueued).toHaveLength(1)
    f.jobs[0].settle(finished({ speechModelId: EDDA_ID, language: 'da' }))
    expect(await running).toMatchObject({
      type: 'result',
      formatted: expect.any(String),
    })
  })

  test('an unknown Speech Model is left to the queue, which says unknown_model', async () => {
    const f = fakeDeps()
    void createCommandHandlers(f.deps).transcribe(
      req(
        'transcribe',
        transcribeArgs({ format: 'srt', speechModelId: 'nope' })
      ),
      context().ctx
    )
    expect(f.enqueued).toHaveLength(1)
  })

  test('a renderer that cannot make captions from this result is captions_unavailable', async () => {
    const f = fakeDeps({
      renderTranscript: () => ({
        ok: false,
        reason: 'no_timed_transcript',
        message: 'There are no timings to make captions from.',
      }),
    })
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', transcribeArgs({ format: 'srt' })),
      context().ctx
    )
    f.jobs[0].settle(finished())
    expect(await running).toEqual({
      type: 'error',
      code: 'captions_unavailable',
      message: 'There are no timings to make captions from.',
    })
  })

  test('a renderer that throws is internal, never a result without formatted', async () => {
    const f = fakeDeps({
      renderTranscript: () => {
        throw new Error('boom')
      },
    })
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', transcribeArgs({ format: 'txt' })),
      context().ctx
    )
    f.jobs[0].settle(finished())
    expect(await running).toMatchObject({ type: 'error', code: 'internal' })
  })

  test('a failed File Transcription is its error, and nothing is rendered', async () => {
    const f = fakeDeps()
    const running = createCommandHandlers(f.deps).transcribe(
      req('transcribe', transcribeArgs({ format: 'srt' })),
      context().ctx
    )
    f.jobs[0].settle({ status: 'failed', code: 'no_audio', message: 'x' })
    expect(await running).toMatchObject({ type: 'error', code: 'no_audio' })
    expect(f.renders).toEqual([])
  })
})

describe('the rest', () => {
  test('app.show shows the window', async () => {
    const f = fakeDeps()
    const result = await createCommandHandlers(f.deps)['app.show'](
      req('app.show', {}),
      context().ctx
    )
    expect(result).toEqual({ type: 'result' })
    expect(f.shown).toBe(1)
  })

  test('deferred handlers wait for the real ones', async () => {
    const f = fakeDeps()
    let ready!: (h: ReturnType<typeof createCommandHandlers>) => void
    const deferred = deferredCommandHandlers(
      new Promise((resolve) => {
        ready = resolve
      })
    )
    let settled = false
    const running = Promise.resolve(
      deferred['app.show'](req('app.show', {}), context().ctx)
    ).then((r) => {
      settled = true
      return r
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    ready(createCommandHandlers(f.deps))
    expect(await running).toEqual({ type: 'result' })
    expect(f.shown).toBe(1)
  })
})

// ── dictate / stop ───────────────────────────────────────────────────────

const DICTATE_ARGS: CommandRequestOf<'dictate'>['args'] = {
  output: 'stdout',
  raw: false,
  until: 'enter',
  maxSeconds: null,
  speechModelId: null,
  languageId: null,
  formattingModeId: null,
}

const BATCH_PLAN: RunnableDictationPlan = {
  status: 'runnable',
  mode: 'batch',
  speechModelId: DEFAULT_MODEL_ID,
  engineId: 'whisper_cpp',
  crispasrBackend: null,
  transcriptionLanguageId: 'auto',
  languageCode: null,
  translateToEnglish: false,
  punctuationRestoration: false,
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function allowed(overrides: Partial<CommandLineDeps> = {}) {
  return fakeDeps({ getCommandLineControl: () => true, ...overrides })
}

describe('dictate: the checks, in order', () => {
  test('Command-Line Control off comes first, with a notification naming the caller', async () => {
    const f = fakeDeps({
      isOnboardingCompleted: () => false,
      isMicrophoneGranted: () => false,
    })
    f.dictation.nextStart = { status: 'busy' }
    const result = await createCommandHandlers(f.deps).dictate(
      req('dictate', { ...DICTATE_ARGS, formattingModeId: 'nope' }, 'Raycast'),
      context().ctx
    )
    expect(result).toMatchObject({
      type: 'error',
      code: 'command_line_control_off',
    })
    expect(f.notifications).toEqual([
      {
        title: 'Command-Line Control is off',
        body: 'Raycast tried to start a dictation from the command line. To allow that, turn on Command-Line Control in Settings > Command Line.',
      },
    ])
    expect(f.dictation.starts).toHaveLength(0)
  })

  test('an unknown caller is "An app", and a failing notification does not change the answer', async () => {
    const f = fakeDeps({
      notify: () => {
        throw new Error('no notifications here')
      },
    })
    const result = await createCommandHandlers(f.deps).dictate(
      req('dictate', DICTATE_ARGS, null),
      context().ctx
    )
    expect(result).toMatchObject({ code: 'command_line_control_off' })

    const g = fakeDeps()
    await createCommandHandlers(g.deps).stop(
      req('stop', {}, null),
      context().ctx
    )
    expect(g.notifications[0].body).toStartWith(
      'An app tried to stop a dictation'
    )
  })

  test('then onboarding, then the microphone', async () => {
    const onboarding = allowed({
      isOnboardingCompleted: () => false,
      isMicrophoneGranted: () => false,
    })
    expect(
      await createCommandHandlers(onboarding.deps).dictate(
        req('dictate', DICTATE_ARGS),
        context().ctx
      )
    ).toMatchObject({
      code: 'not_ready',
      message: expect.stringContaining('set up'),
    })

    const mic = allowed({ isMicrophoneGranted: async () => false })
    expect(
      await createCommandHandlers(mic.deps).dictate(
        req('dictate', DICTATE_ARGS),
        context().ctx
      )
    ).toMatchObject({
      code: 'not_ready',
      message: expect.stringContaining('microphone'),
    })
    expect(mic.dictation.starts).toHaveLength(0)
    expect(mic.notifications).toHaveLength(0)
  })

  test('then the arguments, before anything starts', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, formattingModeId: 'poem' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_formatting_mode' })
    expect(
      await h.dictate(
        req('dictate', {
          ...DICTATE_ARGS,
          raw: true,
          formattingModeId: 'email',
        }),
        context().ctx
      )
    ).toMatchObject({ code: 'usage' })
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, speechModelId: 'large-v9' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_model' })
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, languageId: 'klingon' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_language' })
    expect(f.dictation.starts).toHaveLength(0)
  })

  test('then busy', async () => {
    const f = allowed()
    f.dictation.nextStart = { status: 'busy' }
    expect(
      await createCommandHandlers(f.deps).dictate(
        req('dictate', DICTATE_ARGS),
        context().ctx
      )
    ).toMatchObject({ type: 'error', code: 'busy' })
  })

  test('then a blocked plan, as its own error code and never a fallback', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    f.dictation.nextStart = {
      status: 'blocked',
      plan: blockedDictationPlan(
        'batch',
        'speech_model_not_installed',
        'large-v3-q5_0'
      ),
      fromOverrides: true,
    }
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, speechModelId: 'large-v3-q5_0' }),
        context().ctx
      )
    ).toEqual({
      type: 'error',
      code: 'model_not_installed',
      message:
        "Speech Model large-v3-q5_0 is not installed. Download it in Codictate's Settings, or run codictate models download large-v3-q5_0.",
    })

    f.dictation.nextStart = {
      status: 'blocked',
      plan: blockedDictationPlan(
        'live',
        'model_cannot_stream',
        DEFAULT_MODEL_ID
      ),
      fromOverrides: true,
    }
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, output: 'cursor' }),
        context().ctx
      )
    ).toMatchObject({ code: 'usage' })

    f.dictation.nextStart = {
      status: 'unsupported',
      message: '--until silence does not work with live transcription.',
    }
    expect(
      await h.dictate(
        req('dictate', { ...DICTATE_ARGS, until: 'silence' }),
        context().ctx
      )
    ).toMatchObject({ code: 'usage' })
  })
})

describe('dictate: the Punctuation Model gone', () => {
  test('says the Dictation stopped and Add punctuation is off, in command-line words', async () => {
    const f = allowed()
    f.dictation.nextStart = {
      status: 'blocked',
      plan: blockedDictationPlan(
        'batch',
        'punctuation_model_not_installed',
        'hviske-v5-tiny-q5_0'
      ),
      fromOverrides: true,
    }
    expect(
      await createCommandHandlers(f.deps).dictate(
        req('dictate', {
          ...DICTATE_ARGS,
          speechModelId: 'hviske-v5-tiny-q5_0',
        }),
        context().ctx
      )
    ).toEqual({
      type: 'error',
      code: 'model_not_installed',
      message:
        'Dictation stopped because Add punctuation is on and its Danish punctuation model is no longer installed. Add punctuation has been turned off, so the next dictation works.',
    })
  })
})

describe('dictate: running', () => {
  test('passes the request through, with overrides checked and coerced', async () => {
    const f = allowed()
    void createCommandHandlers(f.deps).dictate(
      req('dictate', {
        output: 'cursor',
        raw: false,
        until: 'silence',
        maxSeconds: 30,
        speechModelId: null,
        languageId: 'DA',
        formattingModeId: 'email',
      }),
      context().ctx
    )
    await tick()
    expect(f.dictation.starts[0]).toMatchObject({
      output: 'cursor',
      raw: false,
      until: 'silence',
      maxSeconds: 30,
      speechModelId: DEFAULT_MODEL_ID,
      transcriptionLanguageId: 'da',
      formattingModeId: 'email',
    })

    void createCommandHandlers(f.deps).dictate(
      req('dictate', DICTATE_ARGS),
      context().ctx
    )
    await tick()
    // No overrides: the user's settings, untouched.
    expect(f.dictation.starts[1]).toMatchObject({
      speechModelId: null,
      transcriptionLanguageId: null,
    })
  })

  test('forwards recording and transcribing, then the docs/CLI.md result', async () => {
    const f = allowed()
    const emitted: ProgressLikeEvent[] = []
    const running = createCommandHandlers(f.deps).dictate(
      req('dictate', DICTATE_ARGS),
      context(emitted).ctx
    )
    await tick()
    const { onEvent } = f.dictation.starts[0]
    onEvent({ type: 'recording' })
    onEvent({ type: 'transcribing' })
    f.dictation.settle({
      status: 'ok',
      text: 'Hi Anna,\n\nSee you at noon.',
      rawText: 'hi anna see you at noon',
      formattingModeId: 'email',
      pasted: false,
      live: false,
      plan: {
        ...BATCH_PLAN,
        transcriptionLanguageId: 'da',
        languageCode: 'da',
      },
      audioSeconds: 4.2,
    })
    expect(await running).toEqual({
      type: 'result',
      text: 'Hi Anna,\n\nSee you at noon.',
      rawText: 'hi anna see you at noon',
      formattingMode: 'email',
      pasted: false,
      live: false,
      language: 'da',
      speechModelId: DEFAULT_MODEL_ID,
      engine: 'whisper',
      audioSeconds: 4.2,
    })
    expect(emitted).toEqual([{ type: 'recording' }, { type: 'transcribing' }])
  })

  test('a Live Transcription has no text, and an auto language is null', async () => {
    const f = allowed()
    const running = createCommandHandlers(f.deps).dictate(
      req('dictate', { ...DICTATE_ARGS, output: 'cursor' }),
      context().ctx
    )
    await tick()
    f.dictation.settle({
      status: 'ok',
      text: '',
      rawText: '',
      formattingModeId: null,
      pasted: true,
      live: true,
      plan: {
        ...BATCH_PLAN,
        mode: 'live',
        speechModelId: 'parakeet-tdt-0.6b-v3',
        engineId: 'whisperkit',
      },
      audioSeconds: 3,
    })
    expect(await running).toMatchObject({
      text: '',
      live: true,
      pasted: true,
      language: null,
      engine: 'parakeet',
      formattingMode: null,
    })
  })

  test('an engine failure is engine_failed, a cancel is cancelled', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    const failing = h.dictate(req('dictate', DICTATE_ARGS), context().ctx)
    await tick()
    f.dictation.settle({
      status: 'failed',
      failure: {
        status: 'failed',
        reason: 'engine_exited_nonzero',
        message: 'Dictation failed',
      },
      plan: BATCH_PLAN,
    })
    expect(await failing).toMatchObject({ code: 'engine_failed' })

    const cancelled = h.dictate(req('dictate', DICTATE_ARGS), context().ctx)
    await tick()
    f.dictation.settle({ status: 'cancelled' })
    expect(await cancelled).toMatchObject({ code: 'cancelled' })
  })

  test('a stop line stops it, even one that arrives while it is starting', async () => {
    const f = allowed()
    const sent: ServerEvent[] = []
    const session = createCommandLineSession(createCommandHandlers(f.deps), {
      send: (e) => sent.push(e),
      end: () => {},
    })
    session.receiveLine(
      JSON.stringify({
        contractVersion: 1,
        command: 'dictate',
        args: DICTATE_ARGS,
      })
    )
    // The handler is past its checks and waiting on the start.
    session.receiveLine('{"type":"stop"}')
    await tick()
    expect(f.dictation.stops).toBe(1)
    session.receiveLine('{"type":"stop"}')
    expect(f.dictation.stops).toBe(2)
    expect(f.dictation.cancels).toBe(0)
  })

  test('a cancel line or a disconnect cancels it', async () => {
    for (const end of ['cancel', 'disconnect'] as const) {
      const f = allowed()
      const sent: ServerEvent[] = []
      const session = createCommandLineSession(createCommandHandlers(f.deps), {
        send: (e) => sent.push(e),
        end: () => {},
      })
      session.receiveLine(
        JSON.stringify({
          contractVersion: 1,
          command: 'dictate',
          args: DICTATE_ARGS,
        })
      )
      await tick()
      if (end === 'cancel') session.receiveLine('{"type":"cancel"}')
      else session.disconnected()
      expect(f.dictation.cancels).toBe(1)
      expect(f.dictation.stops).toBe(0)
      expect(sent).toEqual(
        end === 'cancel'
          ? [{ type: 'error', code: 'cancelled', message: 'Cancelled' }]
          : []
      )
    }
  })
})

describe('stop', () => {
  test('needs Command-Line Control', async () => {
    const f = fakeDeps()
    f.dictation.stopAnyAnswer = true
    expect(
      await createCommandHandlers(f.deps).stop(req('stop', {}), context().ctx)
    ).toMatchObject({ code: 'command_line_control_off' })
    expect(f.notifications).toHaveLength(1)
  })

  test('says whether there was a Dictation to stop', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(await h.stop(req('stop', {}), context().ctx)).toEqual({
      type: 'result',
      stopped: false,
    })
    f.dictation.stopAnyAnswer = true
    expect(await h.stop(req('stop', {}), context().ctx)).toEqual({
      type: 'result',
      stopped: true,
    })
  })
})

// ── models use / download / remove, languages use ────────────────────────

const BUNDLED_ID = SPEECH_MODELS.find((m) => m.bundled)!.id
const NOT_INSTALLED_ID = SPEECH_MODELS.find(
  (m) => !m.bundled && m.id !== NON_CURATED_ID
)!.id

describe('settings and weights commands need Command-Line Control', () => {
  test('each is refused with a notification, and nothing changes', async () => {
    const f = fakeDeps()
    const h = createCommandHandlers(f.deps)
    const results = [
      await h['models.use'](
        req('models.use', { id: NON_CURATED_ID }),
        context().ctx
      ),
      await h['models.download'](
        req('models.download', { id: NOT_INSTALLED_ID }),
        context().ctx
      ),
      await h['models.remove'](
        req('models.remove', { id: NON_CURATED_ID }),
        context().ctx
      ),
      await h['languages.use'](
        req('languages.use', { id: 'da' }, 'Raycast'),
        context().ctx
      ),
    ]
    for (const result of results) {
      expect(result).toMatchObject({ code: 'command_line_control_off' })
    }
    expect(f.notifications).toHaveLength(4)
    expect(f.notifications[3]!.body).toStartWith('Raycast tried to change')
    expect(f.writes).toEqual([])
    expect(f.models.downloads).toEqual([])
    expect(f.models.removes).toEqual([])
  })
})

describe('models.use', () => {
  test('an unknown or uninstalled Speech Model is refused', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h['models.use'](req('models.use', { id: 'nope' }), context().ctx)
    ).toMatchObject({ code: 'unknown_model' })
    expect(
      await h['models.use'](
        req('models.use', { id: NOT_INSTALLED_ID }),
        context().ctx
      )
    ).toMatchObject({ code: 'model_not_installed' })
    expect(f.writes).toEqual([])
  })

  test('selects exactly as Settings does', async () => {
    const f = allowed({
      getTranscriptionLanguageId: () => 'da',
      getStreamMode: () => true,
    })
    const result = await createCommandHandlers(f.deps)['models.use'](
      req('models.use', { id: NON_CURATED_ID }),
      context().ctx
    )
    expect(result).toEqual({ type: 'result', speechModelId: NON_CURATED_ID })
    expect(f.writes).toEqual([
      speechModelSelectionPatch(
        {
          speechModelId: DEFAULT_MODEL_ID,
          transcriptionLanguageId: 'da',
          streamMode: true,
        },
        NON_CURATED_ID
      ),
    ])
  })

  test('the selected Speech Model writes nothing', async () => {
    const f = allowed({ getStreamMode: () => true })
    expect(
      await createCommandHandlers(f.deps)['models.use'](
        req('models.use', { id: DEFAULT_MODEL_ID }),
        context().ctx
      )
    ).toEqual({ type: 'result', speechModelId: DEFAULT_MODEL_ID })
    expect(f.writes).toEqual([])
  })

  test('a refused write is model_not_installed', async () => {
    const f = allowed({ updateTranscriptionSettings: async () => false })
    expect(
      await createCommandHandlers(f.deps)['models.use'](
        req('models.use', { id: NON_CURATED_ID }),
        context().ctx
      )
    ).toMatchObject({ code: 'model_not_installed' })
  })
})

describe('models.download', () => {
  test('unknown is refused; installed or bundled answers at once', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h['models.download'](
        req('models.download', { id: 'nope' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_model' })
    for (const id of [BUNDLED_ID, NON_CURATED_ID]) {
      expect(
        await h['models.download'](
          req('models.download', { id }),
          context().ctx
        )
      ).toEqual({ type: 'result', speechModelId: id })
    }
    expect(f.models.downloads).toEqual([])
  })

  test('streams throttled progress, then the result, and never selects', async () => {
    const f = allowed()
    const emitted: ProgressLikeEvent[] = []
    const running = Promise.resolve(
      createCommandHandlers(f.deps)['models.download'](
        req('models.download', { id: NOT_INSTALLED_ID }),
        context(emitted).ctx
      )
    )
    await tick()
    expect(f.models.downloads).toEqual([
      { id: NOT_INSTALLED_ID, requester: 'command-line' },
    ])
    for (let i = 1; i <= 20; i++) f.models.progress(i / 40)
    expect(emitted).toEqual([{ type: 'download', fraction: 0.025 }])
    f.models.settle({ status: 'installed' })
    expect(await running).toEqual({
      type: 'result',
      speechModelId: NOT_INSTALLED_ID,
    })
    expect(f.writes).toEqual([])
    expect(f.models.released).toBe(1)
  })

  test('a failure or a cancel in the window is download_failed', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    const failing = Promise.resolve(
      h['models.download'](
        req('models.download', { id: NOT_INSTALLED_ID }),
        context().ctx
      )
    )
    await tick()
    f.models.settle({ status: 'failed', message: 'HTTP 404' })
    const failed = await failing
    expect(failed).toMatchObject({ code: 'download_failed' })
    expect((failed as { message: string }).message).toContain('HTTP 404')

    const cancelling = Promise.resolve(
      h['models.download'](
        req('models.download', { id: NOT_INSTALLED_ID }),
        context().ctx
      )
    )
    await tick()
    f.models.settle({ status: 'cancelled' })
    expect(await cancelling).toMatchObject({ code: 'download_failed' })
  })

  test('a cancel line or a disconnect releases the download', async () => {
    const f = allowed()
    const { ctx, abort } = context()
    const running = Promise.resolve(
      createCommandHandlers(f.deps)['models.download'](
        req('models.download', { id: NOT_INSTALLED_ID }),
        ctx
      )
    )
    await tick()
    abort.abort()
    expect(await running).toMatchObject({ code: 'cancelled' })
    expect(f.models.released).toBe(1)

    // Through a session: the client goes away mid-download.
    const g = allowed()
    const sent: ServerEvent[] = []
    const session = createCommandLineSession(createCommandHandlers(g.deps), {
      send: (event) => sent.push(event),
      end: () => {},
    })
    session.receiveLine(
      JSON.stringify(req('models.download', { id: NOT_INSTALLED_ID }))
    )
    await tick()
    expect(g.models.downloads).toHaveLength(1)
    session.disconnected()
    await tick()
    expect(g.models.released).toBe(1)
  })
})

describe('createDownloadEventThrottle', () => {
  test('lets one event through per interval', () => {
    let now = 1_000
    const mayEmit = createDownloadEventThrottle(() => now)
    expect(mayEmit()).toBe(true)
    expect(mayEmit()).toBe(false)
    now += DOWNLOAD_EVENT_INTERVAL_MS - 1
    expect(mayEmit()).toBe(false)
    now += 1
    expect(mayEmit()).toBe(true)
  })
})

describe('models.remove', () => {
  test('unknown, bundled and not installed', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h['models.remove'](
        req('models.remove', { id: 'nope' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_model' })
    expect(
      await h['models.remove'](
        req('models.remove', { id: BUNDLED_ID }),
        context().ctx
      )
    ).toMatchObject({ code: 'model_bundled' })
    expect(
      await h['models.remove'](
        req('models.remove', { id: NOT_INSTALLED_ID }),
        context().ctx
      )
    ).toEqual({ type: 'result', speechModelId: NOT_INSTALLED_ID })
    expect(f.models.removes).toEqual([])
  })

  test('removes through the shared path; a failed delete is internal', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h['models.remove'](
        req('models.remove', { id: NON_CURATED_ID }),
        context().ctx
      )
    ).toEqual({ type: 'result', speechModelId: NON_CURATED_ID })
    expect(f.models.removes).toEqual([NON_CURATED_ID])
    f.models.removeAnswer = false
    expect(
      await h['models.remove'](
        req('models.remove', { id: NON_CURATED_ID }),
        context().ctx
      )
    ).toMatchObject({ code: 'internal' })
  })
})

describe('languages.use', () => {
  test('unknown, and not allowed for the selected Speech Model', async () => {
    const f = allowed({ getSpeechModelId: () => HVISKE_ID })
    const h = createCommandHandlers(f.deps)
    expect(
      await h['languages.use'](
        req('languages.use', { id: 'klingon' }),
        context().ctx
      )
    ).toMatchObject({ code: 'unknown_language' })
    expect(
      await h['languages.use'](
        req('languages.use', { id: 'en' }),
        context().ctx
      )
    ).toMatchObject({ code: 'language_not_allowed' })
    expect(f.writes).toEqual([])
  })

  test('writes the Transcription Language, and nothing when it is already selected', async () => {
    const f = allowed()
    const h = createCommandHandlers(f.deps)
    expect(
      await h['languages.use'](
        req('languages.use', { id: 'DA' }),
        context().ctx
      )
    ).toEqual({ type: 'result', transcriptionLanguageId: 'da' })
    expect(f.writes).toEqual([{ transcriptionLanguageId: 'da' }])
    expect(
      await h['languages.use'](
        req('languages.use', { id: 'auto' }),
        context().ctx
      )
    ).toEqual({ type: 'result', transcriptionLanguageId: 'auto' })
    expect(f.writes).toHaveLength(1)
  })
})
