import type { RunnableDictationPlan } from '../../../shared/dictation-plan'
import { PARAKEET_ENGINE_ID } from '../../../shared/speech-models'
import { modelManager } from './model-manager'
import { pasteTranscript } from '../keyboard/keyboard-events'
import { applyFormatting } from '../formatting/apply-formatting'
import { buildFormatterRequest } from '../formatting/resolve-formatting-request'
import { log } from '../logger'
import { getPlatform } from '../../platform'
import type {
  DictionaryEntry,
  FormattingRuntimeSettings,
} from '../../../shared/types'
import { applyDictionary } from '../dictionary/apply-dictionary'
import { RECORDING_PATH } from '../../platform/runtime'
import { buildWhisperHarnessCommand } from './whisper-harness-command'
import { awaitParakeetWarmup } from './parakeet-warmup'
import { parseParakeetFinalText } from './engines/parakeet-output'

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
  [/\bCodeictate\b/gi, 'Codictate'],
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

/**
 * One Dictation, exactly as the Dictation Plan describes it.
 *
 * Every question this used to ask - is the selection installed, can it translate, which
 * backend, which language - was answered when the plan was built, so nothing is re-derived
 * here and there is nothing left to fall back to. The two fallbacks that used to live in
 * this function are gone: an hviske selection with deleted weights no longer transcribes
 * with the default Speech Model, and Translate to English is no longer dropped when the
 * selection cannot do it. Both states are now unreachable (settings-heal.ts) or blocked
 * before the spawn (buildDictationPlan). See ADR-0005.
 */
export const transcribe = async (plan: RunnableDictationPlan) => {
  if (plan.engineId === PARAKEET_ENGINE_ID) {
    return transcribeParakeet(plan.speechModelId)
  }

  const model = modelManager.getModelPath(plan.speechModelId)

  const command = await buildWhisperHarnessCommand({
    crispasrBackend: plan.crispasrBackend ?? undefined,
    modelPath: model,
    language: plan.languageCode,
    audioPath: RECORDING_PATH,
    translateToEnglish: plan.translateToEnglish,
  })

  log('whisper', 'spawning ASR harness', {
    harness: command.harness,
    backend: command.crispasrBackend,
    binary: command.binary,
    model,
    whisperLanguageCode: command.languageArg,
    languageMode: command.languageArg === 'auto' ? 'auto-detect' : 'fixed',
    modelId: plan.speechModelId,
    transcriptionLanguageId: plan.transcriptionLanguageId,
    translateToEnglish: plan.translateToEnglish,
  })

  const proc = Bun.spawn(command.argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Avoid C locale / missing UTF-8 so the ASR Harness prints a UTF-8 transcript
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
    harness: command.harness,
    exitCode: proc.exitCode,
    transcriptLength: transcript.length,
    stderr: stderrText.slice(0, 500) || undefined,
  })

  return transcript
}

async function transcribeParakeet(modelId: string): Promise<string> {
  // Serialise behind an in-flight preparation rather than racing it. Recording is already
  // over by the time this runs and the indicator says "transcribing", so the wait is visible
  // and it is the same compile this spawn would otherwise have paid for itself.
  await awaitParakeetWarmup()

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

  const out = new TextDecoder('utf-8').decode(stdoutBytes)
  const text = parseParakeetFinalText(out) ?? ''

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

export interface Speech2TextResult {
  raw: string
  output: string
  formattingUsed: boolean
}

export const speech2text = async (
  plan: RunnableDictationPlan,
  formattingSettings: FormattingRuntimeSettings,
  dictionaryEntries: DictionaryEntry[] = [],
  onBeforeTranscription?: () => Promise<void>,
  onAppliedEntries?: (entries: DictionaryEntry[]) => void
): Promise<Speech2TextResult> => {
  if (onBeforeTranscription) await onBeforeTranscription()

  let transcript = await transcribe(plan)
  if (dictionaryEntries.length > 0) {
    const result = applyDictionary(transcript, dictionaryEntries, {
      trackApplied: true,
    })
    transcript = result.text
    if (onAppliedEntries && result.appliedEntries.length > 0) {
      onAppliedEntries(result.appliedEntries)
    }
  }
  const rawTranscript = transcript
  let formattingUsed = false
  const formatterRequest = await buildFormatterRequest(
    transcript,
    formattingSettings
  )
  if (formatterRequest !== null) {
    transcript = await applyFormatting(formatterRequest)
    formattingUsed = true
  }
  await pasteTranscript(transcript)
  return { raw: rawTranscript, output: transcript, formattingUsed }
}
