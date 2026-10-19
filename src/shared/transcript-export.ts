/**
 * Transcript Export (GLOSSARY.md): a File Transcription rendered as text, as a Caption File
 * (SRT, VTT) or as JSON, and what the Save menu offers. Pure, so the window, History and the
 * command line all render the same document.
 */

import { modelLabel } from './dictation-plan'
import {
  getSpeechModel,
  speechModelMakesTimedTranscript,
} from './speech-models'
import { isTimedTranscript, type TimedTranscript } from './timed-transcript'
import { buildCues, type TranscriptCue } from './transcript-cues'

export const TRANSCRIPT_EXPORT_FORMATS = ['txt', 'srt', 'vtt', 'json'] as const
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number]
export function isTranscriptExportFormat(
  value: unknown
): value is TranscriptExportFormat {
  return (
    typeof value === 'string' &&
    (TRANSCRIPT_EXPORT_FORMATS as readonly string[]).includes(value)
  )
}

/** Everything a Transcript Export is made from: a window result, a History entry, a command-line result. */
export interface TranscriptExportSource {
  fileName: string
  /** `null` for a History entry saved before Codictate recorded it. */
  speechModelId: string | null
  /** The Transcription Language the run was fixed to; `null` when detected or unknown. */
  language: string | null
  translated: boolean
  audioSeconds: number
  /** `null` for a History entry saved before Processing Time was recorded. */
  processingSeconds: number | null
  /** The Raw Transcript. */
  text: string
  timedTranscript: TimedTranscript | null
}

/** What the webview knows about a transcript, without its timings. */
export interface TranscriptExportFacts {
  speechModelId: string | null
  hasTimedTranscript: boolean
}

export interface TranscriptExportOption {
  format: TranscriptExportFormat
  /** "Text (.txt)", "Captions (.srt)", "Captions (.vtt)", "JSON (.json)". */
  label: string
  available: boolean
  /** One finished sentence, no em dashes; `null` when available. */
  unavailableReason: string | null
}

/** The JSON export document (`--format json` too). `segments` are the cues; omitted with no Timed Transcript. */
export interface TranscriptJsonDocument {
  fileName: string
  speechModelId: string | null
  language: string | null
  translated: boolean
  audioSeconds: number
  processingSeconds: number | null
  text: string
  segments?: { start: number; end: number; text: string }[]
}

export type RenderedTranscript =
  | { ok: true; content: string }
  | { ok: false; reason: 'no_timed_transcript'; message: string }

const OPTION_LABELS: Record<TranscriptExportFormat, string> = {
  txt: 'Text (.txt)',
  srt: 'Captions (.srt)',
  vtt: 'Captions (.vtt)',
  json: 'JSON (.json)',
}

const SAVED_WITHOUT_TIMINGS =
  "This transcript was saved without timings, so it can't be made into captions."
const HAS_NO_TIMINGS =
  "This transcript has no timings, so it can't be made into captions."

/** The Speech Model's sentence when it is the reason there are no captions, else `null`. */
function modelCannotMakeCaptions(speechModelId: string | null): string | null {
  if (speechModelId === null || getSpeechModel(speechModelId) === undefined) {
    return null
  }
  return speechModelMakesTimedTranscript(speechModelId)
    ? null
    : `${modelLabel(speechModelId)} can't make captions yet.`
}

function isCaptionFormat(format: TranscriptExportFormat): boolean {
  return format === 'srt' || format === 'vtt'
}

/** What the Save menu offers, in menu order. Captions need a Timed Transcript; text and JSON never do. */
export function transcriptExportOptions(
  facts: TranscriptExportFacts
): TranscriptExportOption[] {
  const reason = facts.hasTimedTranscript
    ? null
    : (modelCannotMakeCaptions(facts.speechModelId) ?? SAVED_WITHOUT_TIMINGS)
  return TRANSCRIPT_EXPORT_FORMATS.map((format) => {
    const unavailableReason = isCaptionFormat(format) ? reason : null
    return {
      format,
      label: OPTION_LABELS[format],
      available: unavailableReason === null,
      unavailableReason,
    }
  })
}

/** The source's Timed Transcript when it is one and says exactly the source's text, else `null`. */
function usableTimedTranscript(
  source: TranscriptExportSource
): TimedTranscript | null {
  const t = source.timedTranscript
  return t !== null && isTimedTranscript(t) && t.text === source.text ? t : null
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0')
}

/** `HH:MM:SS<separator>mmm`, rounded to the millisecond. */
function captionClock(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms % 1000, 3)}`
}

/** Text can never pass for a timing line. */
function srtLine(line: string): string {
  return line.replace(/-->/g, '->')
}

/** WebVTT cue text: `&`, `<` and `>` escaped, which also keeps `-->` out of it. */
function vttLine(line: string): string {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderSrt(cues: readonly TranscriptCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${captionClock(cue.start, ',')} --> ${captionClock(cue.end, ',')}\n${cue.lines.map(srtLine).join('\n')}\n\n`
    )
    .join('')
}

function renderVtt(cues: readonly TranscriptCue[]): string {
  return `WEBVTT\n\n${cues
    .map(
      (cue) =>
        `${captionClock(cue.start, '.')} --> ${captionClock(cue.end, '.')}\n${cue.lines.map(vttLine).join('\n')}\n\n`
    )
    .join('')}`
}

function roundToMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

function renderJson(
  source: TranscriptExportSource,
  timed: TimedTranscript | null
): string {
  const document: TranscriptJsonDocument = {
    fileName: source.fileName,
    speechModelId: source.speechModelId,
    language: source.language,
    translated: source.translated,
    audioSeconds: source.audioSeconds,
    processingSeconds: source.processingSeconds,
    text: source.text,
  }
  if (timed !== null) {
    document.segments = buildCues(timed).map((cue) => ({
      start: roundToMs(cue.start),
      end: roundToMs(cue.end),
      text: cue.text,
    }))
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * The document a Transcript Export writes. Captions use `CAPTION_CUE_RULES`; JSON carries
 * the same cues as `segments`, with their exact text. A Caption File without a Timed
 * Transcript is refused with the sentence to show; text and JSON always render.
 */
export function renderTranscript(
  format: TranscriptExportFormat,
  source: TranscriptExportSource
): RenderedTranscript {
  const timed = usableTimedTranscript(source)
  switch (format) {
    case 'txt':
      return { ok: true, content: `${source.text}\n` }
    case 'json':
      return { ok: true, content: renderJson(source, timed) }
    case 'srt':
    case 'vtt': {
      if (timed === null) {
        return {
          ok: false,
          reason: 'no_timed_transcript',
          message:
            modelCannotMakeCaptions(source.speechModelId) ?? HAS_NO_TIMINGS,
        }
      }
      const cues = buildCues(timed)
      return {
        ok: true,
        content: format === 'srt' ? renderSrt(cues) : renderVtt(cues),
      }
    }
  }
}

/**
 * The name a Transcript Export is saved under: `memo.m4a` gives `memo.srt`. The source file's
 * last extension is dropped (`a.b.mov` gives `a.b.srt`); a leading dot is part of the name.
 * When the name is taken in the chosen folder, the export adds a number (`memo 2.srt`) rather
 * than replace the file.
 */
export function transcriptExportFileName(
  sourceFileName: string,
  format: TranscriptExportFormat
): string {
  const dot = sourceFileName.lastIndexOf('.')
  const stem = dot > 0 ? sourceFileName.slice(0, dot) : sourceFileName
  return `${stem}.${format}`
}
