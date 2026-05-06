import { whisperCliLanguageArg } from '../../../shared/transcription-languages'
import { getSpeechModel } from '../../../shared/speech-models'
import { resolveTranslateModelId } from '../../../shared/whisper-models'
import { modelManager } from './model-manager'
import { pasteTranscript } from '../keyboard/keyboard-events'
import { applyFormatting } from '../formatting/apply-formatting'
import { buildFormatterRequest } from '../formatting/resolve-formatting-request'
import { availableParallelism } from 'node:os'
import { log } from '../logger'
import { getPlatform } from '../../platform'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../../shared/types'
import { applyDictionary } from '../dictionary/apply-dictionary'
import { RECORDING_PATH } from '../../platform/runtime'
import { findWhisperCliBinary } from './find-whisper-cli'

/**
 * Whisper often splits or mishears the product name — normalize before paste.
 * Order: phrase mishearings first, then codec+tate|tape|sheet|shade (incl. Codec Tate, Codec Tape, Codec Sheet, Codic shade, glued forms), then kodictate/codictate (any casing).
 */
const BRAND_TRANSCRIPT_FIXES: [RegExp, string][] = [
  [/\bcode\s+dictate\b/gi, 'Codictate'],
  [/\bcoding\s*tate\b/gi, 'Codictate'],
  [/\bco(?:\s+|[-–—]\s*)dictate\b/gi, 'Codictate'],
  [/\bkodi\s+dicate\b/gi, 'Codictate'],
  [/\bkodi\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tet\b/gi, 'Codictate'],
  [/\bkodiktet\b/gi, 'Codictate'],
  [/\bkodiktete\b/gi, 'Codictate'],
  [/\bkodig\s+tate\b/gi, 'Codictate'],
  [/\bkodigtate\b/gi, 'Codictate'],
  [/\bkodig\s+tet\b/gi, 'Codictate'],
  [/\bkodigtet\b/gi, 'Codictate'],
  [/\bko\s+digtet\b/gi, 'Codictate'],
  [/\bkodigt\s+tade\b/gi, 'Codictate'],
  [/\bkodigttade\b/gi, 'Codictate'],
  [/\bkodigtede\b/gi, 'Codictate'],
  [/\bkodig\s+tede\b/gi, 'Codictate'],
  [/\bko\s+digtede\b/gi, 'Codictate'],
  [/\bKodak\s+Tech\b/gi, 'Codictate'],
  [/\bKodakTech\b/gi, 'Codictate'],
  [/\bcodec\s+cheat\b/gi, 'Codictate'],
  [/\bcodeccheat\b/gi, 'Codictate'],
  [/\bcodec\s+sheet\b/gi, 'Codictate'],
  [/\bcodecsheet\b/gi, 'Codictate'],
  [/\bcodic\s+shade\b/gi, 'Codictate'],
  [/\bcodicshade\b/gi, 'Codictate'],
  [/\bcodec\s*t(?:ate|ape)\b/gi, 'Codictate'],
  [/\bcodec\s+tade\b/gi, 'Codictate'],
  [/\bcodectade\b/gi, 'Codictate'],
  [/\bcodexade\b/gi, 'Codictate'],
  [/\bcodex\s+ade\b/gi, 'Codictate'],
  [/\bcode\s+xade\b/gi, 'Codictate'],
  [/\bkodiktat\b/gi, 'Codictate'],
  [/\bkodiktate\b/gi, 'Codictate'],
  [/\bkodic\s+tate\b/gi, 'Codictate'],
  [/\bkodictate\b/gi, 'Codictate'],
  [/\bcodictate\b/gi, 'Codictate'],
  [/\bCodigTate\b/gi, 'Codictate'],
  [/\bCodig\s+Tate\b/gi, 'Codictate'],
]

export function fixBrandMishearings(text: string): string {
  let t = text
  for (const [pattern, replacement] of BRAND_TRANSCRIPT_FIXES) {
    t = t.replace(pattern, replacement)
  }
  return t
}

/** Read a subprocess pipe to completion. Must run concurrently with `proc.exited` or the child can deadlock once the pipe buffer fills (Core ML / FluidAudio is verbose on stderr). */
async function drainReadableStream(
  stream: ReadableStream<Uint8Array> | undefined
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(value)
  }
  const len = chunks.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export const transcribe = async (
  whisperLanguageCode: string | null | undefined,
  modelId: string,
  translateToEnglish: boolean
) => {
  const speech = getSpeechModel(modelId)
  if (speech?.engine === 'whisperkit') {
    return transcribeParakeet(modelId)
  }

  const binary = await findWhisperCliBinary()

  const translateRunModelId = resolveTranslateModelId(modelId, (id) =>
    modelManager.isModelAvailable(id)
  )
  const useTranslate = translateToEnglish && translateRunModelId !== null
  if (translateToEnglish && translateRunModelId === null) {
    log(
      'whisper',
      'translate requested but no translate-capable model selected or available — transcribing without -tr',
      { transcriptionModelId: modelId }
    )
  }

  const effectiveModelId = useTranslate ? translateRunModelId : modelId
  const model = modelManager.getModelPath(effectiveModelId)

  const lang = whisperCliLanguageArg(whisperLanguageCode)

  log('whisper', 'spawning whisper-cli', {
    binary,
    model,
    whisperLanguageCode: lang,
    languageMode: lang === 'auto' ? 'auto-detect' : 'fixed',
    modelId: effectiveModelId,
    translateToEnglish: useTranslate,
  })

  const args = [
    binary,
    '-m',
    model,
    '-t',
    String(Math.max(4, availableParallelism?.() ?? 4)),
    '--language',
    lang,
    '-f',
    RECORDING_PATH,
    '--no-prints',
    '-nt', // No timestamps
  ]

  if (useTranslate) {
    args.push('-tr')
  }

  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Avoid C locale / missing UTF-8 so whisper-cli prints UTF-8 transcript
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    },
  })

  const stderrPromise = drainReadableStream(proc.stderr)
  const stdoutPromise = drainReadableStream(proc.stdout)
  await proc.exited
  const stderrBytes = await stderrPromise
  const stdoutBytes = await stdoutPromise
  const stderrText = new TextDecoder('utf-8').decode(stderrBytes)
  const raw = new TextDecoder('utf-8').decode(stdoutBytes).trim()
  const transcript = fixBrandMishearings(raw)

  log('whisper', 'transcription complete', {
    exitCode: proc.exitCode,
    transcriptLength: transcript.length,
    stderr: stderrText.slice(0, 500) || undefined,
  })

  return transcript
}

async function transcribeParakeet(modelId: string): Promise<string> {
  const helper = getPlatform().findParakeetHelperBinary()
  const modelDir = modelManager.getParakeetInstallDir(modelId)

  log('parakeet', 'spawning CodictateParakeetHelper transcribe', {
    helper,
    modelDir,
  })

  const proc = Bun.spawn([helper, 'transcribe', RECORDING_PATH, modelDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    },
  })

  const stderrPromise = drainReadableStream(proc.stderr)
  const stdoutPromise = drainReadableStream(proc.stdout)
  await proc.exited
  const stderrBytes = await stderrPromise
  const stdoutBytes = await stdoutPromise
  const stderrText = new TextDecoder('utf-8').decode(stderrBytes)

  const out = new TextDecoder('utf-8').decode(stdoutBytes).trim()
  let text = ''
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t) as { kind?: string; text?: string }
      if (obj.kind === 'final' && typeof obj.text === 'string') {
        text = obj.text
        break
      }
    } catch {
      // ignore non-JSON
    }
  }

  const transcript = fixBrandMishearings(text.trim())

  if (stderrText.trim()) {
    log('parakeet', 'helper stderr', {
      text: stderrText.slice(0, 4000),
    })
  }

  log('parakeet', 'transcription complete', {
    exitCode: proc.exitCode,
    transcriptLength: transcript.length,
  })

  return transcript
}

function createSilentWav(): Uint8Array {
  const sampleRate = 16000
  const numSamples = Math.floor(sampleRate * 0.5)
  const dataSize = numSamples * 2
  const buf = new Uint8Array(44 + dataSize)
  const view = new DataView(buf.buffer)
  buf[0] = 0x52
  buf[1] = 0x49
  buf[2] = 0x46
  buf[3] = 0x46 // RIFF
  view.setUint32(4, 36 + dataSize, true)
  buf[8] = 0x57
  buf[9] = 0x41
  buf[10] = 0x56
  buf[11] = 0x45 // WAVE
  buf[12] = 0x66
  buf[13] = 0x6d
  buf[14] = 0x74
  buf[15] = 0x20 // fmt
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  buf[36] = 0x64
  buf[37] = 0x61
  buf[38] = 0x74
  buf[39] = 0x61 // data
  view.setUint32(40, dataSize, true)
  return buf
}

export async function warmupParakeet(
  onReady?: () => Promise<void>
): Promise<void> {
  const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v3'
  if (!modelManager.isModelAvailable(PARAKEET_MODEL_ID)) return
  try {
    const helper = getPlatform().findParakeetHelperBinary()
    const modelDir = modelManager.getParakeetInstallDir(PARAKEET_MODEL_ID)
    const warmupPath = getPlatform().getTempPath('codictate-warmup.wav')
    await Bun.write(warmupPath, createSilentWav())
    log('parakeet', 'starting Core ML warmup')
    const proc = Bun.spawn([helper, 'transcribe', warmupPath, modelDir], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    })
    await proc.exited
    log('parakeet', 'Core ML warmup complete', { exitCode: proc.exitCode })
    if (proc.exitCode === 0) {
      await onReady?.()
    }
  } catch (err) {
    log('parakeet', 'Core ML warmup error', { err: String(err) })
  }
}

export const speech2text = async (
  whisperLanguageCode: string | null | undefined,
  modelId: string,
  translateToEnglish: boolean,
  formattingSettings: FormattingRuntimeSettings,
  dictionaryEntries: DictionaryEntry[] = [],
  onBeforeTranscription?: () => Promise<void>,
  onAppliedEntries?: (entries: DictionaryEntry[]) => void
): Promise<string> => {
  if (onBeforeTranscription) await onBeforeTranscription()

  let transcript = await transcribe(
    whisperLanguageCode,
    modelId,
    translateToEnglish
  )
  if (dictionaryEntries.length > 0) {
    const result = applyDictionary(transcript, dictionaryEntries, {
      trackApplied: true,
    })
    transcript = result.text
    if (onAppliedEntries && result.appliedEntries.length > 0) {
      onAppliedEntries(result.appliedEntries)
    }
  }
  const formatterRequest = await buildFormatterRequest(
    transcript,
    formattingSettings
  )
  if (formatterRequest !== null) {
    transcript = await applyFormatting(formatterRequest)
  }
  await pasteTranscript(transcript)
  return transcript
}
