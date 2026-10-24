/**
 * The wire protocol between the `codictate` command-line client and the running app.
 *
 * The contract is docs/CLI.md ("Wire protocol", "Events", "Results", "Errors and exit
 * codes"); the Rust client implements the same document. Renaming a command, field or error
 * code here is a breaking change and bumps `CONTRACT_VERSION`.
 *
 * Pure: no platform imports, so the webview and the tests can use it too.
 */

import type { SpeechEngineId } from './speech-models'
import {
  TRANSCRIPT_EXPORT_FORMATS,
  isTranscriptExportFormat,
  type TranscriptExportFormat,
} from './transcript-export'

export const CONTRACT_VERSION = 1

// ── Requests ─────────────────────────────────────────────────────────────

export const COMMAND_NAMES = [
  'transcribe',
  'dictate',
  'stop',
  'status',
  'models.list',
  'models.use',
  'models.download',
  'models.remove',
  'languages.list',
  'languages.use',
  'app.show',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export type DictateOutput = 'stdout' | 'cursor'
export type DictateUntil = 'enter' | 'silence'

/*
 * Not this protocol, recorded here beside it: the Parakeet Native Helper's batch `final`
 * line carries an optional `timing`, ignored by readers that do not know it. Omitted when
 * there is no transcript or no timings; times in seconds, rounded to ms.
 *
 *   macOS, pre-ITN spoken words:
 *   {"kind":"final","text":"<Raw Transcript>","timing":{"unit":"spoken-word",
 *    "items":[{"text":"twenty","start":0.32,"end":0.61}]}}
 *   Windows, sentences:
 *   {"kind":"final","text":"<Raw Transcript>","timing":{"unit":"sentence",
 *    "items":[{"text":"Hello there.","start":0.0,"end":1.2}]}}
 */

/** `args` per command, after parsing: optional fields the client omitted read as `null`. */
export interface CommandArgs {
  transcribe: {
    file: string
    speechModelId: string | null
    languageId: string | null
    /**
     * `true` translates this call to English; `false` and `null` (absent on the wire) do
     * not. The command line never takes it from the File Transcription Settings.
     */
    translate: boolean | null
    /** Render the result as this Transcript Export into `formatted`; `null`: no rendering. */
    format: TranscriptExportFormat | null
  }
  dictate: {
    output: DictateOutput
    raw: boolean
    until: DictateUntil
    maxSeconds: number | null
    speechModelId: string | null
    languageId: string | null
    formattingModeId: string | null
  }
  stop: Record<string, never>
  status: Record<string, never>
  'models.list': { all: boolean }
  'models.use': { id: string }
  'models.download': { id: string }
  'models.remove': { id: string }
  'languages.list': Record<string, never>
  'languages.use': { id: string }
  'app.show': Record<string, never>
}

/** The client's parent process, self-reported. Shown to the user, never used to grant anything. */
export interface RequestCaller {
  name: string | null
  pid: number | null
}

export type CommandRequestOf<C extends CommandName> = {
  contractVersion: number
  command: C
  args: CommandArgs[C]
  caller: RequestCaller | null
}

export type CommandRequest = {
  [C in CommandName]: CommandRequestOf<C>
}[CommandName]

// ── Control lines ────────────────────────────────────────────────────────

export type ControlLine = { type: 'stop' } | { type: 'cancel' }

// ── Events ───────────────────────────────────────────────────────────────

/** The Speech Engine names the command line shows; the internal ids never leave the app. */
export type PublicEngineName = 'whisper' | 'parakeet' | 'hviske'

const PUBLIC_ENGINE_NAMES: Record<SpeechEngineId, PublicEngineName> = {
  whisper_cpp: 'whisper',
  whisperkit: 'parakeet',
  hviske: 'hviske',
}

export function publicEngineName(engine: SpeechEngineId): PublicEngineName {
  return PUBLIC_ENGINE_NAMES[engine]
}

export interface QueuedEvent {
  type: 'queued'
  position: number
}

export interface ProgressEvent {
  type: 'progress'
  stage: 'decoding' | 'transcribing'
  elapsedSeconds: number
  audioSeconds: number | null
}

export interface RecordingEvent {
  type: 'recording'
}

export interface TranscribingEvent {
  type: 'transcribing'
}

export interface DownloadEvent {
  type: 'download'
  fraction: number
}

export type ProgressLikeEvent =
  | QueuedEvent
  | ProgressEvent
  | RecordingEvent
  | TranscribingEvent
  | DownloadEvent

export type MicrophoneState = 'granted' | 'denied' | 'undetermined' | 'unknown'
export type DictationStartedBy = 'shortcut' | 'command-line'

export interface TranscribeResult {
  type: 'result'
  file: string
  text: string
  language: string | null
  speechModelId: string
  engine: PublicEngineName
  audioSeconds: number
  /** Processing Time in seconds, rounded to 0.1. Excludes waiting in the queue. */
  processingSeconds: number
  /** Whether `text` is Translate to English output. */
  translated: boolean
  /** The rendered Transcript Export; present only when the request asked for a `format`. */
  formatted?: string
}

export interface DictateResult {
  type: 'result'
  text: string | null
  rawText: string | null
  formattingMode: string | null
  pasted: boolean
  live: boolean
  language: string | null
  speechModelId: string
  engine: PublicEngineName
  audioSeconds: number
}

export interface StopResult {
  type: 'result'
  stopped: boolean
}

export interface StatusResult {
  type: 'result'
  contractVersion: number
  app: { version: string; channel: string; identifier: string }
  onboardingCompleted: boolean
  microphone: MicrophoneState
  commandLineControl: boolean
  dictation: { active: boolean; startedBy: DictationStartedBy | null }
  speechModel: {
    id: string
    label: string
    engine: PublicEngineName
    installed: boolean
  }
  transcriptionLanguage: { id: string; label: string }
  fileTranscriptions: { running: number; queued: number }
}

export interface ListedSpeechModel {
  id: string
  label: string
  engine: PublicEngineName
  downloadSizeMB: number
  installed: boolean
  selected: boolean
  curated: boolean
  bundled: boolean
}

export interface ModelsListResult {
  type: 'result'
  models: ListedSpeechModel[]
}

export interface SpeechModelIdResult {
  type: 'result'
  speechModelId: string
}

export interface ListedTranscriptionLanguage {
  id: string
  label: string
  selected: boolean
  allowed: boolean
}

export interface LanguagesListResult {
  type: 'result'
  languages: ListedTranscriptionLanguage[]
}

export interface LanguagesUseResult {
  type: 'result'
  transcriptionLanguageId: string
}

export interface AppShowResult {
  type: 'result'
}

export interface CommandResults {
  transcribe: TranscribeResult
  dictate: DictateResult
  stop: StopResult
  status: StatusResult
  'models.list': ModelsListResult
  'models.use': SpeechModelIdResult
  'models.download': SpeechModelIdResult
  'models.remove': SpeechModelIdResult
  'languages.list': LanguagesListResult
  'languages.use': LanguagesUseResult
  'app.show': AppShowResult
}

export type ResultEvent = CommandResults[CommandName]

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Every `error.code`, with the exit code the client maps it to. `cancelled` is 130 for SIGINT;
 * the client uses 143 instead when SIGTERM caused it. `app_unavailable` and
 * `contract_mismatch` are mostly the client's own, but the app sends `contract_mismatch` too.
 * `output_unwritable` (exit 1, `-o` could not be written) is the client's alone, so the app
 * never sends it and it is not listed here.
 */
export const EXIT_CODE_BY_ERROR = {
  internal: 1,
  usage: 2,
  unknown_model: 2,
  unknown_language: 2,
  language_not_allowed: 2,
  unknown_formatting_mode: 2,
  model_bundled: 2,
  cannot_translate: 2,
  captions_unavailable: 2,
  input_unreadable: 3,
  no_audio: 3,
  model_not_installed: 4,
  engine_failed: 5,
  app_unavailable: 6,
  command_line_control_off: 7,
  busy: 8,
  not_ready: 9,
  download_failed: 10,
  contract_mismatch: 11,
  cancelled: 130,
} as const satisfies Record<string, number>

export type ErrorCode = keyof typeof EXIT_CODE_BY_ERROR

export const ERROR_CODES = Object.keys(EXIT_CODE_BY_ERROR) as ErrorCode[]

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(EXIT_CODE_BY_ERROR, value)
  )
}

export interface ErrorEvent {
  type: 'error'
  code: ErrorCode
  message: string
}

export function errorEvent(code: ErrorCode, message: string): ErrorEvent {
  return { type: 'error', code, message }
}

/** Everything the app may send. The last one on a connection is a `result` or an `error`. */
export type ServerEvent = ProgressLikeEvent | ResultEvent | ErrorEvent

export type TerminalEvent = ResultEvent | ErrorEvent

export function isTerminalEvent(event: ServerEvent): event is TerminalEvent {
  return event.type === 'result' || event.type === 'error'
}

/** One NDJSON line: the event and its `\n`. */
export function encodeLine(event: ServerEvent | CommandRequest | ControlLine) {
  return `${JSON.stringify(event)}\n`
}

// ── Parsing ──────────────────────────────────────────────────────────────

export type ParsedRequest =
  { ok: true; request: CommandRequest } | { ok: false; error: ErrorEvent }

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCommandName(value: unknown): value is CommandName {
  return (
    typeof value === 'string' &&
    (COMMAND_NAMES as readonly string[]).includes(value)
  )
}

class UsageError extends Error {}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`args.${key} must be a non-empty string`)
  }
  return value
}

/** Absent and `null` both read as `null`; anything else must be a non-empty string. */
function optionalString(args: JsonObject, key: string): string | null {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`args.${key} must be a non-empty string or null`)
  }
  return value
}

function requiredBoolean(args: JsonObject, key: string): boolean {
  const value = args[key]
  if (typeof value !== 'boolean') {
    throw new UsageError(`args.${key} must be true or false`)
  }
  return value
}

function oneOf<T extends string>(
  args: JsonObject,
  key: string,
  options: readonly T[]
): T {
  const value = args[key]
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new UsageError(`args.${key} must be one of ${options.join(', ')}`)
  }
  return value as T
}

/** Absent and `null` both read as `null`. */
function optionalBoolean(args: JsonObject, key: string): boolean | null {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') {
    throw new UsageError(`args.${key} must be true, false or null`)
  }
  return value
}

/** Absent and `null` both read as `null`. */
function optionalFormat(
  args: JsonObject,
  key: string
): TranscriptExportFormat | null {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (!isTranscriptExportFormat(value)) {
    throw new UsageError(
      `args.${key} must be one of ${TRANSCRIPT_EXPORT_FORMATS.join(', ')} or null`
    )
  }
  return value
}

function optionalPositiveNumber(args: JsonObject, key: string): number | null {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(`args.${key} must be a positive number or null`)
  }
  return value
}

function parseArgs<C extends CommandName>(
  command: C,
  args: JsonObject
): CommandArgs[C] {
  const parsed: { [K in CommandName]: () => CommandArgs[K] } = {
    transcribe: () => ({
      file: requiredString(args, 'file'),
      speechModelId: optionalString(args, 'speechModelId'),
      languageId: optionalString(args, 'languageId'),
      translate: optionalBoolean(args, 'translate'),
      format: optionalFormat(args, 'format'),
    }),
    dictate: () => ({
      output: oneOf(args, 'output', ['stdout', 'cursor'] as const),
      raw: requiredBoolean(args, 'raw'),
      until: oneOf(args, 'until', ['enter', 'silence'] as const),
      maxSeconds: optionalPositiveNumber(args, 'maxSeconds'),
      speechModelId: optionalString(args, 'speechModelId'),
      languageId: optionalString(args, 'languageId'),
      formattingModeId: optionalString(args, 'formattingModeId'),
    }),
    stop: () => ({}),
    status: () => ({}),
    'models.list': () => ({ all: requiredBoolean(args, 'all') }),
    'models.use': () => ({ id: requiredString(args, 'id') }),
    'models.download': () => ({ id: requiredString(args, 'id') }),
    'models.remove': () => ({ id: requiredString(args, 'id') }),
    'languages.list': () => ({}),
    'languages.use': () => ({ id: requiredString(args, 'id') }),
    'app.show': () => ({}),
  }
  return parsed[command]()
}

function parseCaller(value: unknown): RequestCaller | null {
  if (!isObject(value)) return null
  const name =
    typeof value.name === 'string' && value.name.length > 0 ? value.name : null
  const pid =
    typeof value.pid === 'number' && Number.isInteger(value.pid)
      ? value.pid
      : null
  return { name, pid }
}

/**
 * The client's first line. Malformed requests are `usage` errors; a different
 * `contractVersion` is `contract_mismatch`, checked before the command so a newer client
 * naming a command this app does not know still gets the right answer. Unknown fields are
 * ignored. `caller` is informational, so a malformed one reads as `null` rather than failing.
 */
export function parseRequestLine(line: string): ParsedRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return {
      ok: false,
      error: errorEvent('usage', 'The request is not valid JSON'),
    }
  }
  if (!isObject(value)) {
    return {
      ok: false,
      error: errorEvent('usage', 'The request must be a JSON object'),
    }
  }
  const { contractVersion, command } = value
  if (
    typeof contractVersion !== 'number' ||
    !Number.isInteger(contractVersion)
  ) {
    return {
      ok: false,
      error: errorEvent('usage', 'The request has no contractVersion'),
    }
  }
  if (contractVersion !== CONTRACT_VERSION) {
    return {
      ok: false,
      error: errorEvent(
        'contract_mismatch',
        `The command line speaks contract version ${contractVersion}, Codictate speaks ${CONTRACT_VERSION}`
      ),
    }
  }
  if (!isCommandName(command)) {
    return {
      ok: false,
      error: errorEvent(
        'usage',
        typeof command === 'string'
          ? `Unknown command: ${command}`
          : 'The request has no command'
      ),
    }
  }
  const rawArgs = value.args === undefined ? {} : value.args
  if (!isObject(rawArgs)) {
    return {
      ok: false,
      error: errorEvent('usage', 'args must be a JSON object'),
    }
  }
  try {
    const args = parseArgs(command, rawArgs)
    return {
      ok: true,
      request: {
        contractVersion,
        command,
        args,
        caller: parseCaller(value.caller),
      } as CommandRequest,
    }
  } catch (err) {
    if (err instanceof UsageError) {
      return {
        ok: false,
        error: errorEvent('usage', `${command}: ${err.message}`),
      }
    }
    throw err
  }
}

/**
 * A line the client sends after the request. Anything that is not a known control line
 * (bad JSON, an unknown `type`) reads as `null` and is ignored, so a newer client's extra
 * control lines cannot break an older app.
 */
export function parseControlLine(line: string): ControlLine | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  if (value.type === 'stop') return { type: 'stop' }
  if (value.type === 'cancel') return { type: 'cancel' }
  return null
}
