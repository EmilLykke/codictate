/**
 * End-to-end File Transcriptions on this Mac, through the real queue in-process. Opt-in
 * (`.manual.ts`, so `bun test` never discovers it): it spawns `say`, the media Native Helper
 * and real Speech Engines, and reads installed weights.
 *
 *   bun test ./src/bun/file-transcription/file-transcription.manual.ts
 *
 * One case per Speech Engine kind, each skipped when its weights are not installed, plus
 * Translate to English, a cancel and a check that the engine runs at lowered priority. Needs `bun run build:native`
 * for the Media Helper. The video case needs ffmpeg and is skipped without it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRANSLATE_CAPABLE_MODEL_IDS } from '../../shared/dictation-plan'
import { speechModelMakesTimedTranscript } from '../../shared/speech-models'
import { modelManager } from '../utils/whisper/model-manager'
import { createFileTranscriptionQueue } from './queue'
import { productionFileTranscriptionDeps } from './production-deps'
import type { FileTranscriptionEvent, PublicSpeechEngineName } from './types'

let dir = ''
let englishAudio = ''
let danishAudio = ''
let longAudio = ''
let video: string | null = null

function run(cmd: string[]): number {
  return Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'ignore' }).exitCode
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'codictate-file-transcription-e2e-'))
  englishAudio = join(dir, 'english.m4a')
  danishAudio = join(dir, 'danish.aiff')
  longAudio = join(dir, 'long.aiff')
  const english = 'Hello there. This is a short test of file transcription.'
  run(['say', '-o', join(dir, 'english.aiff'), english])
  run([
    'afconvert',
    '-f',
    'm4af',
    '-d',
    'aac',
    join(dir, 'english.aiff'),
    englishAudio,
  ])
  run([
    'say',
    '-v',
    'Sara',
    '-o',
    danishAudio,
    'Hej, dette er en kort test af transskription på dansk.',
  ])
  run(['say', '-o', longAudio, Array(20).fill(english).join(' ')])
  const mov = join(dir, 'english.mov')
  if (
    run([
      'ffmpeg',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=6',
      '-i',
      join(dir, 'english.aiff'),
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      mov,
    ]) === 0
  ) {
    video = mov
  }
}, 180_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/**
 * A queue whose File Transcription Settings select one Speech Model, with `en` asked on
 * purpose and Translate to English off.
 */
function queueFor(speechModelId: string) {
  return createFileTranscriptionQueue(
    productionFileTranscriptionDeps({
      getFileTranscriptionSettings: () => ({
        speechModelId,
        transcriptionLanguageId: 'en',
        translateToEnglish: false,
      }),
      getTranslateDefaultLanguageId: () => 'auto',
    })
  )
}

const ENGINE_CASES: {
  speechModelId: string
  engine: PublicSpeechEngineName
  danish: boolean
}[] = [
  { speechModelId: 'parakeet-tdt-0.6b-v3', engine: 'parakeet', danish: false },
  { speechModelId: 'hviske-v5-tiny-q5_0', engine: 'hviske', danish: true },
  { speechModelId: 'edda-v0.2-q5_0', engine: 'whisper', danish: true },
  { speechModelId: 'large-v3-turbo-q5_0', engine: 'whisper', danish: false },
]

/**
 * Installed and actually on disk: a source checkout reports the bundled Whisper weights
 * available whether or not the pre-build has downloaded them.
 */
const installed = (speechModelId: string) =>
  modelManager.isModelAvailable(speechModelId) &&
  existsSync(modelManager.getModelPath(speechModelId))

describe('one Speech Model per engine', () => {
  for (const c of ENGINE_CASES) {
    test.skipIf(!installed(c.speechModelId))(
      c.speechModelId,
      async () => {
        const queue = queueFor(c.speechModelId)
        const job = queue.enqueue({
          filePath: c.danish ? danishAudio : englishAudio,
          origin: { kind: 'command-line', callerName: 'manual test' },
        })
        const events: FileTranscriptionEvent[] = []
        job.onEvent((e) => events.push(e))
        const started = performance.now()
        const result = await job.result
        console.log(
          `[${c.speechModelId}] ${((performance.now() - started) / 1000).toFixed(2)} s`,
          JSON.stringify(result)
        )
        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.engine).toBe(c.engine)
        expect(result.speechModelId).toBe(c.speechModelId)
        expect(result.language).toBe(c.danish ? 'da' : null)
        expect(result.text.length).toBeGreaterThan(0)
        expect(result.translated).toBe(false)
        expect(result.processingSeconds).toBeGreaterThan(0)
        if (speechModelMakesTimedTranscript(c.speechModelId)) {
          expect(result.timedTranscript?.text).toBe(result.text)
        } else {
          expect(result.timedTranscript).toBeNull()
        }
        expect(events.some((e) => e.type === 'progress')).toBe(true)
        expect(queue.snapshot()).toEqual([])
      },
      300_000
    )
  }
})

/** A Whisper Speech Model that can translate, when one is installed. */
const translateModel = TRANSLATE_CAPABLE_MODEL_IDS.find(installed)

describe('Translate to English', () => {
  test.skipIf(!translateModel)(
    'translates Danish speech when the request asks, whatever the settings say',
    async () => {
      const job = queueFor(translateModel!).enqueue({
        filePath: danishAudio,
        languageId: 'da',
        translateToEnglish: true,
        origin: { kind: 'command-line', callerName: 'manual test' },
      })
      const result = await job.result
      console.log(`[translate ${translateModel}]`, JSON.stringify(result))
      expect(result).toMatchObject({
        status: 'ok',
        translated: true,
        language: 'da',
      })
    },
    300_000
  )

  test('a Speech Model that cannot translate is refused at once, as cannot_translate', async () => {
    const cannot = ENGINE_CASES.find(
      (c) =>
        installed(c.speechModelId) &&
        !TRANSLATE_CAPABLE_MODEL_IDS.includes(c.speechModelId)
    )
    if (!cannot) return
    const job = queueFor(cannot.speechModelId).enqueue({
      filePath: englishAudio,
      translateToEnglish: true,
      origin: { kind: 'window' },
    })
    expect(await job.result).toMatchObject({
      status: 'failed',
      code: 'cannot_translate',
    })
  })
})

const whisperCases = ENGINE_CASES.filter(
  (c) => c.engine === 'whisper' && installed(c.speechModelId)
)
/** An English-capable Whisper Speech Model when there is one, since the samples are English. */
const anyWhisper = whisperCases.find((c) => !c.danish) ?? whisperCases[0]

describe.skipIf(!anyWhisper)('with an installed Whisper Speech Model', () => {
  test('a video file', async () => {
    if (video === null) return
    const job = queueFor(anyWhisper!.speechModelId).enqueue({
      filePath: video,
      languageId: 'en',
      origin: { kind: 'window' },
    })
    const result = await job.result
    console.log('[video]', JSON.stringify(result))
    expect(result.status).toBe('ok')
  }, 300_000)

  test('the engine runs at nice 10, and a cancel stops it', async () => {
    const queue = queueFor(anyWhisper!.speechModelId)
    const job = queue.enqueue({
      filePath: longAudio,
      languageId: 'en',
      origin: { kind: 'window' },
    })
    await new Promise<void>((resolve) => {
      job.onEvent((e) => {
        if (e.type === 'progress' && e.stage === 'transcribing') resolve()
      })
    })
    await Bun.sleep(500)
    const ps = Bun.spawnSync(['ps', '-axo', 'nice=,comm=']).stdout.toString()
    const crispasr = ps
      .split('\n')
      .filter((line) => line.includes('crispasr'))
      .map((line) => line.trim())
    console.log('[priority]', crispasr)
    expect(crispasr.some((line) => line.startsWith('10 '))).toBe(true)

    job.cancel()
    expect(await job.result).toMatchObject({
      status: 'failed',
      code: 'cancelled',
    })
    expect(queue.snapshot()).toEqual([])
  }, 300_000)
})

test('a file without audio is no_audio, a missing one input_unreadable', async () => {
  const queue = queueFor(anyWhisper?.speechModelId ?? 'large-v3-turbo-q5_0')
  const missing = queue.enqueue({
    filePath: join(dir, 'nope.wav'),
    origin: { kind: 'window' },
  })
  expect(await missing.result).toMatchObject({ code: 'input_unreadable' })
  if (video === null || !anyWhisper) return
  const silentVideo = join(dir, 'silent.mov')
  run([
    'ffmpeg',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240:d=2',
    '-c:v',
    'libx264',
    silentVideo,
  ])
  const noAudio = queue.enqueue({
    filePath: silentVideo,
    origin: { kind: 'window' },
  })
  expect(await noAudio.result).toMatchObject({ code: 'no_audio' })
}, 60_000)
