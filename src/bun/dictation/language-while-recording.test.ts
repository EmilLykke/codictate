import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDictationPlan } from '../../shared/dictation-plan'
import { EKKO_ENGINE_ID } from '../../shared/speech-models'
import { readWavSamples } from '../utils/whisper/engines/vad-slices'
import {
  detectLanguageWhileRecording,
  startLanguageWhileRecording,
  wavBytes,
} from './language-while-recording'

const RATE = 16_000
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 100 ms of room noise, about -60 dBFS. */
function quiet(): Int16Array {
  const out = new Int16Array(RATE / 10)
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? 30 : -30
  return out
}

/** 100 ms of a loud tone, about -13 dBFS: speech to the meter. */
function loud(): Int16Array {
  const out = new Int16Array(RATE / 10)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 10_000)
  }
  return out
}

/** A fake recorder, a fake crispasr that answers when told to, and a real temp directory. */
function harness(ignoreLeadingMs = 0) {
  let push: ((samples: Int16Array, rate: number) => void) | null = null
  let stopped = false
  const calls: { path: string; bytes: Uint8Array; signal: AbortSignal }[] = []
  const answers: ((language: string | null) => void)[] = []
  let dir: string | null = null
  const check = detectLanguageWhileRecording(ignoreLeadingMs, {
    watch: (onSamples) => {
      push = onSamples
      return { stop: () => (stopped = true) }
    },
    detect: (path, signal) => {
      calls.push({ path, bytes: new Uint8Array(readFileSync(path)), signal })
      return new Promise((resolve) => answers.push(resolve))
    },
    makeTempDir: () => {
      dir = mkdtempSync(join(tmpdir(), 'codictate-language-test-'))
      dirs.push(dir)
      return dir
    },
  })
  return {
    check,
    calls,
    answer: (index: number, language: string | null) =>
      answers[index](language),
    /** Room noise first, so the meter has a floor, then `speechSeconds` of tone with pauses. */
    record(speechSeconds: number, leadingQuietSeconds = 0.5) {
      for (let i = 0; i < leadingQuietSeconds * 10; i++) push!(quiet(), RATE)
      for (let i = 0; i < speechSeconds * 10; i++) {
        push!(loud(), RATE)
        if (i % 10 === 9) push!(quiet(), RATE)
      }
    },
    get stopped() {
      return stopped
    },
    get dir() {
      return dir
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('detectLanguageWhileRecording', () => {
  test('no check before 3 s of speech, and none at all in silence', async () => {
    const h = harness()
    h.record(0, 8)
    h.record(2.5, 0)
    expect(h.calls).toHaveLength(0)
    expect(await h.check.finish()).toBeNull()
    expect(h.stopped).toBe(true)
  })

  test('3 s of speech checks everything recorded so far, as a 16 kHz mono WAV', async () => {
    const h = harness()
    h.record(3.2)
    expect(h.calls).toHaveLength(1)
    const audio = readWavSamples(h.calls[0].bytes)
    expect(audio.sampleRate).toBe(RATE)
    expect(audio.samples.length).toBeGreaterThan(3 * RATE)
    h.answer(0, 'da')
    await settle()
    expect(await h.check.finish()).toBe('da')
    expect(existsSync(h.calls[0].path)).toBe(false)
    expect(existsSync(h.dir!)).toBe(false)
  })

  test('a long pause mid-Dictation does not stop the count', async () => {
    const h = harness()
    h.record(2)
    h.record(0, 3)
    h.record(1.5, 0)
    expect(h.calls).toHaveLength(1)
  })

  test('a long silence first only moves the check later', async () => {
    const h = harness()
    h.record(0, 6)
    expect(h.calls).toHaveLength(0)
    h.record(3.2, 0)
    expect(h.calls).toHaveLength(1)
  })

  test('the start chime is not speech', async () => {
    const h = harness(4_000)
    h.record(3.5, 0)
    expect(h.calls).toHaveLength(0)
  })

  test('stopping waits for the check still running', async () => {
    const h = harness()
    h.record(3.2)
    const finished = h.check.finish()
    h.answer(0, 'en')
    expect(await finished).toBe('en')
  })

  test('checks again at 10 s of speech, after the first one ends, and the latest wins', async () => {
    const h = harness()
    h.record(3.2)
    h.record(8, 0)
    // The first is still running at 10 s, so the second waits for it.
    expect(h.calls).toHaveLength(1)
    h.answer(0, 'en')
    await settle()
    expect(h.calls).toHaveLength(2)
    expect(readWavSamples(h.calls[1].bytes).samples.length).toBeGreaterThan(
      readWavSamples(h.calls[0].bytes).samples.length
    )
    h.answer(1, 'da')
    expect(await h.check.finish()).toBe('da')
  })

  test('a failed check leaves the earlier answer', async () => {
    const h = harness()
    h.record(3.2)
    h.answer(0, 'da')
    await settle()
    h.record(8, 0)
    h.answer(1, null)
    expect(await h.check.finish()).toBe('da')
  })

  test('cancel aborts the running check and keeps nothing', async () => {
    const h = harness()
    h.record(3.2)
    h.check.cancel()
    expect(h.calls[0].signal.aborted).toBe(true)
    expect(h.stopped).toBe(true)
    h.answer(0, null)
    await settle()
    await settle()
    expect(existsSync(h.dir!)).toBe(false)
  })
})

describe('startLanguageWhileRecording', () => {
  test('checks nothing for an ekko Dictation, whatever its language says', () => {
    const autoWhisper = buildDictationPlan(
      {
        speechModelId: 'large-v3-turbo-q5_0',
        transcriptionLanguageId: 'auto',
        translateDefaultLanguageId: 'auto',
        translateToEnglish: false,
        streamMode: false,
        addPunctuation: false,
      },
      {
        isModelAvailable: () => true,
        streamSupported: true,
        punctuationModelInstalled: false,
      }
    )
    if (autoWhisper.status !== 'runnable') throw new Error('expected runnable')
    const check = startLanguageWhileRecording(
      { ...autoWhisper, engineId: EKKO_ENGINE_ID },
      {
        recordingPath: '/nonexistent/recording.wav',
        startedAtMs: 0,
        ignoreLeadingMs: 0,
        modelPath: '/nonexistent/ekko.gguf',
      }
    )
    check?.cancel()
    expect(check).toBeNull()
  })
})

describe('wavBytes', () => {
  test('round-trips through the WAV reader the nt-vad path uses', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768])
    const audio = readWavSamples(wavBytes([samples], samples.length, RATE))
    expect(audio.sampleRate).toBe(RATE)
    expect(audio.samples.length).toBe(samples.length)
    expect(audio.samples[1]).toBeCloseTo(1000 / 32768, 4)
  })
})
