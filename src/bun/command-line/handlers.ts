/**
 * What each command-line command does, over a deps object so the tests need no app.
 *
 * Shapes are docs/CLI.md's "Results". `dictate`, `stop` and the commands that change
 * settings or weights (`models use|download|remove`, `languages use`) need Command-Line
 * Control (`requireCommandLineControl`).
 */

import { isAbsolute } from 'node:path'
import {
  COMMAND_NAMES,
  CONTRACT_VERSION,
  errorEvent,
  publicEngineName,
  type CommandName,
  type CommandRequestOf,
  type CommandRequest,
  type DictateResult,
  type ErrorCode,
  type ErrorEvent,
  type ListedSpeechModel,
  type MicrophoneState,
  type ProgressLikeEvent,
  type TranscribeResult,
} from '../../shared/command-line-protocol'
import {
  SPEECH_MODELS,
  getSpeechModel,
  transcriptionLanguageAllowedForModel,
} from '../../shared/speech-models'
import { speechModelSelectionPatch } from '../../shared/speech-model-selection'
import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  isValidTranscriptionLanguageId,
} from '../../shared/transcription-languages'
import type { TranscriptionSettingsPatch } from '../../shared/types'
import type { ModelOperations } from '../model-operations'
import {
  modelLabel,
  type BlockedDictationPlan,
  type DictationBlockedReason,
} from '../../shared/dictation-plan'
import {
  FORMATTING_MODE_ORDER,
  isValidFormattingModeId,
} from '../../shared/formatting-modes'
import type {
  CommandLineDictationControl,
  CommandLineDictationResult,
  CommandLineDictationStart,
} from '../dictation/command-line-dictation'
import {
  engineFailureLine,
  resultLanguage,
  selectFileTranscription,
} from '../file-transcription/plan'
import type {
  FileTranscriptionEvent,
  FileTranscriptionQueue,
  FileTranscriptionResult,
} from '../file-transcription/types'
import type { CommandHandler, CommandHandlers, HandlerContext } from './session'

export interface AppIdentity {
  version: string
  channel: string
  identifier: string
}

export interface CommandLineDeps {
  app: AppIdentity
  isOnboardingCompleted(): boolean
  getMicrophone(): MicrophoneState
  getCommandLineControl(): boolean
  /**
   * Whether the microphone can be recorded right now. May ask the platform afresh, since a
   * long-lived helper can hold a stale answer after the user granted access.
   */
  isMicrophoneGranted(): boolean | Promise<boolean>
  /** Starting, stopping and reading the Dictation, through the current recording module. */
  dictation: CommandLineDictationControl
  /** A native notification. Electrobun's cannot carry a click action. */
  notify(notification: { title: string; body: string }): void
  getSpeechModelId(): string
  getTranscriptionLanguageId(): string
  isModelAvailable(speechModelId: string): boolean
  fileTranscriptions: Pick<FileTranscriptionQueue, 'enqueue' | 'snapshot'>
  /** Show and focus the main window, creating it when it is closed. */
  showMainWindow(): void
  getStreamMode(): boolean
  /**
   * A transcription settings write, as the tray and Settings make it, followed by the same
   * sync: the settings push to the window, the tray menu, Live Transcription. False when the
   * write was refused.
   */
  updateTranscriptionSettings(
    patch: TranscriptionSettingsPatch
  ): Promise<boolean>
  /** Speech Model downloads and removals, shared with the window. */
  models: Pick<ModelOperations, 'download' | 'remove'>
}

function transcriptionLanguageLabel(id: string): string {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.find((o) => o.id === id)?.label ?? id
}

function fileTranscriptionCounts(deps: CommandLineDeps): {
  running: number
  queued: number
} {
  const jobs = deps.fileTranscriptions.snapshot()
  const queued = jobs.filter((job) => job.state === 'queued').length
  return { running: jobs.length - queued, queued }
}

const status =
  (deps: CommandLineDeps): CommandHandler<'status'> =>
  () => {
    const speechModelId = deps.getSpeechModelId()
    const model = getSpeechModel(speechModelId)
    if (!model) {
      return errorEvent(
        'internal',
        `The selected Speech Model ${speechModelId} is not one Codictate knows`
      )
    }
    const languageId = deps.getTranscriptionLanguageId()
    return {
      type: 'result',
      contractVersion: CONTRACT_VERSION,
      app: {
        version: deps.app.version,
        channel: deps.app.channel,
        identifier: deps.app.identifier,
      },
      onboardingCompleted: deps.isOnboardingCompleted(),
      microphone: deps.getMicrophone(),
      commandLineControl: deps.getCommandLineControl(),
      dictation: deps.dictation.getActiveDictation(),
      speechModel: {
        id: model.id,
        label: model.label,
        engine: publicEngineName(model.engine),
        installed: deps.isModelAvailable(model.id),
      },
      transcriptionLanguage: {
        id: languageId,
        label: transcriptionLanguageLabel(languageId),
      },
      fileTranscriptions: fileTranscriptionCounts(deps),
    }
  }

const modelsList =
  (deps: CommandLineDeps): CommandHandler<'models.list'> =>
  (request) => {
    const selectedId = deps.getSpeechModelId()
    const models: ListedSpeechModel[] = []
    for (const model of SPEECH_MODELS) {
      const installed = deps.isModelAvailable(model.id)
      const curated = model.curated === true
      if (!request.args.all && !curated && !installed) continue
      models.push({
        id: model.id,
        label: model.label,
        engine: publicEngineName(model.engine),
        downloadSizeMB: model.downloadSizeMB,
        installed,
        selected: model.id === selectedId,
        curated,
        bundled: model.bundled === true,
      })
    }
    return { type: 'result', models }
  }

const languagesList =
  (deps: CommandLineDeps): CommandHandler<'languages.list'> =>
  () => {
    const speechModelId = deps.getSpeechModelId()
    const selectedId = deps.getTranscriptionLanguageId()
    return {
      type: 'result',
      languages: TRANSCRIPTION_LANGUAGE_OPTIONS.map(({ id, label }) => ({
        id,
        label,
        selected: id === selectedId,
        allowed: transcriptionLanguageAllowedForModel(speechModelId, id),
      })),
    }
  }

/** A File Transcription event on the wire. The queue already speaks the contract's names. */
export function fileTranscriptionWireEvent(
  event: FileTranscriptionEvent
): ProgressLikeEvent {
  switch (event.type) {
    case 'queued':
      return { type: 'queued', position: event.position }
    case 'progress':
      return {
        type: 'progress',
        stage: event.stage,
        elapsedSeconds: event.elapsedSeconds,
        audioSeconds: event.audioSeconds,
      }
  }
}

export function fileTranscriptionTerminalEvent(
  result: FileTranscriptionResult
): TranscribeResult | ErrorEvent {
  if (result.status === 'failed') return errorEvent(result.code, result.message)
  return {
    type: 'result',
    file: result.filePath,
    text: result.text,
    language: result.language,
    speechModelId: result.speechModelId,
    engine: result.engine,
    audioSeconds: result.audioSeconds,
  }
}

const transcribe =
  (deps: CommandLineDeps): CommandHandler<'transcribe'> =>
  async (request, context) => {
    const { file, speechModelId, languageId } = request.args
    // A cancel can land while the handler waited for the app to finish booting.
    if (context.signal.aborted) return errorEvent('cancelled', 'Cancelled')
    if (!isAbsolute(file)) {
      return errorEvent('usage', `transcribe: not an absolute path: ${file}`)
    }
    const job = deps.fileTranscriptions.enqueue({
      filePath: file,
      speechModelId,
      languageId,
      origin: {
        kind: 'command-line',
        callerName: request.caller?.name ?? null,
      },
    })
    const cancel = () => job.cancel()
    context.signal.addEventListener('abort', cancel, { once: true })
    const unsubscribe = job.onEvent((event) =>
      context.emit(fileTranscriptionWireEvent(event))
    )
    try {
      return fileTranscriptionTerminalEvent(await job.result)
    } finally {
      unsubscribe()
      context.signal.removeEventListener('abort', cancel)
    }
  }

const appShow =
  (deps: CommandLineDeps): CommandHandler<'app.show'> =>
  () => {
    deps.showMainWindow()
    return { type: 'result' }
  }

// ── Command-Line Control ─────────────────────────────────────────────────

export const COMMAND_LINE_CONTROL_OFF_TITLE = 'Command-Line Control is off'

/** The notification for a refused command, naming the app that asked when it said. */
export function commandLineControlOffNotification(
  callerName: string | null,
  action: string
): { title: string; body: string } {
  return {
    title: COMMAND_LINE_CONTROL_OFF_TITLE,
    body: `${callerName ?? 'An app'} tried to ${action} from the command line. To allow that, turn on Command-Line Control in Settings > Command Line.`,
  }
}

/**
 * The gate for every command that records the microphone or changes what Codictate is doing
 * (docs/CLI.md, "Which commands need Command-Line Control"). Off: the command fails and the
 * user is told which setting it needs. There is no "Allow" button, by design (ADR-0009).
 */
export function requireCommandLineControl(
  deps: Pick<CommandLineDeps, 'getCommandLineControl' | 'notify'>,
  request: Pick<CommandRequest, 'caller'>,
  action: string
): ErrorEvent | null {
  if (deps.getCommandLineControl()) return null
  try {
    deps.notify(
      commandLineControlOffNotification(request.caller?.name ?? null, action)
    )
  } catch {
    // A notification that cannot be shown must not change the answer.
  }
  return errorEvent(
    'command_line_control_off',
    "Command-Line Control is off. Turn it on in Codictate's Settings > Command Line."
  )
}

// ── dictate / stop ───────────────────────────────────────────────────────

/** Onboarding finished and the microphone allowed, or the `not_ready` error saying which. */
async function dictationNotReady(
  deps: CommandLineDeps
): Promise<ErrorEvent | null> {
  if (!deps.isOnboardingCompleted()) {
    return errorEvent(
      'not_ready',
      'Codictate is not set up yet. Open Codictate and finish setting it up first.'
    )
  }
  if (!(await deps.isMicrophoneGranted())) {
    return errorEvent(
      'not_ready',
      'Codictate does not have permission to use the microphone. Open Codictate to allow it.'
    )
  }
  return null
}

/**
 * A blocked Dictation Plan as a command-line error. The plan's own sentences are written for
 * a press of the shortcut and the heal pass that follows it ("the selection has been reset"),
 * so the command line gets its own, one per reason, and exhaustive so a new reason does not
 * compile without one.
 */
const BLOCKED_PLAN_ERRORS: Record<
  DictationBlockedReason,
  (speechModelId: string, plan: BlockedDictationPlan) => [ErrorCode, string]
> = {
  speech_model_not_installed: (id) => [
    'model_not_installed',
    `Speech Model ${id} is not installed. Download it in Codictate's Settings, or run codictate models download ${id}.`,
  ],
  parakeet_not_installed: (_id, plan) => ['model_not_installed', plan.message],
  model_cannot_translate: (id) => [
    'usage',
    `${modelLabel(id)} cannot translate to English, and Translate to English is on. Pick another Speech Model with --model, or turn Translate to English off in Settings.`,
  ],
  no_translate_source_language: () => [
    'usage',
    'Translate to English is on and needs a source language. Pass one with --language, or choose one in Settings.',
  ],
  live_transcription_unsupported_platform: () => [
    'usage',
    'Live transcription is on, but this platform cannot run it yet. Leave out --paste, or turn live transcription off in Settings.',
  ],
  model_cannot_stream: (id) => [
    'usage',
    `${modelLabel(id)} cannot run live transcription, which is on. Leave out --paste, or turn live transcription off in Settings.`,
  ],
  language_not_supported_by_parakeet: (_id, plan) => [
    'language_not_allowed',
    plan.message,
  ],
  parakeet_helper_missing: (_id, plan) => ['internal', plan.message],
}

export function blockedPlanError(
  plan: BlockedDictationPlan,
  speechModelId: string
): ErrorEvent {
  const [code, message] = BLOCKED_PLAN_ERRORS[plan.reason](speechModelId, plan)
  return errorEvent(code, message)
}

/** How a started command-line Dictation ended, on the wire. */
export function dictateTerminalEvent(
  result: CommandLineDictationResult,
  speechModelId: string
): DictateResult | ErrorEvent {
  switch (result.status) {
    case 'ok':
      return {
        type: 'result',
        text: result.text,
        rawText: result.rawText,
        formattingMode: result.formattingModeId,
        pasted: result.pasted,
        live: result.live,
        language: resultLanguage(result.plan),
        speechModelId: result.plan.speechModelId,
        engine: publicEngineName(result.plan.engineId),
        audioSeconds: result.audioSeconds,
      }
    case 'cancelled':
      return errorEvent('cancelled', 'Cancelled')
    case 'failed':
      return errorEvent(
        'engine_failed',
        engineFailureLine(
          result.failure.reason,
          result.plan.speechModelId,
          result.failure.diagnostic
        )
      )
    case 'blocked':
      return blockedPlanError(result.plan, speechModelId)
    case 'error':
      return errorEvent('internal', result.message)
  }
}

function dictationStartError(
  start: Exclude<CommandLineDictationStart, { status: 'started' }>,
  speechModelId: string
): ErrorEvent {
  switch (start.status) {
    case 'busy':
      return errorEvent(
        'busy',
        'A dictation is already running. End it first, or run codictate stop.'
      )
    case 'blocked':
      return blockedPlanError(start.plan, speechModelId)
    case 'unsupported':
      return errorEvent('usage', start.message)
  }
}

/**
 * `codictate dictate`. Checks, in order: Command-Line Control, then onboarding and the
 * microphone, then the arguments, then (inside the recording module, atomically with the
 * start) whether a Dictation is already running and whether the plan can run.
 */
const dictate =
  (deps: CommandLineDeps): CommandHandler<'dictate'> =>
  async (request, context) => {
    if (context.signal.aborted) return errorEvent('cancelled', 'Cancelled')
    const refused = requireCommandLineControl(
      deps,
      request,
      'start a dictation'
    )
    if (refused) return refused
    const notReady = await dictationNotReady(deps)
    if (notReady) return notReady

    const args = request.args
    if (args.raw && args.formattingModeId !== null) {
      return errorEvent(
        'usage',
        'dictate: --raw and --formatting-mode cannot be used together'
      )
    }
    const formattingModeId = args.formattingModeId
    if (
      formattingModeId !== null &&
      !isValidFormattingModeId(formattingModeId)
    ) {
      return errorEvent(
        'unknown_formatting_mode',
        `There is no Formatting Mode called "${formattingModeId}". The Formatting Modes are ${FORMATTING_MODE_ORDER.join(', ')}.`
      )
    }

    // Overrides are checked and coerced exactly as for `transcribe`.
    let speechModelId: string | null = null
    let transcriptionLanguageId: string | null = null
    if (args.speechModelId !== null || args.languageId !== null) {
      const selected = selectFileTranscription(deps, {
        speechModelId: args.speechModelId,
        languageId: args.languageId,
      })
      if (selected.status === 'failed') {
        return errorEvent(selected.code, selected.message)
      }
      speechModelId = selected.selection.speechModelId
      transcriptionLanguageId = selected.selection.transcriptionLanguageId
    }
    // Read before starting: a blocked plan runs the heal pass, which can change the selection.
    const reportedSpeechModelId = speechModelId ?? deps.getSpeechModelId()

    if (context.signal.aborted) return errorEvent('cancelled', 'Cancelled')

    // A `stop` line can arrive while the recorder is still starting.
    let started: Extract<
      CommandLineDictationStart,
      { status: 'started' }
    > | null = null
    let stopRequested = false
    context.onStop(() => {
      if (started) started.stop()
      else stopRequested = true
    })

    const start = await deps.dictation.startCommandLineDictation({
      output: args.output,
      raw: args.raw,
      until: args.until,
      maxSeconds: args.maxSeconds,
      speechModelId,
      transcriptionLanguageId,
      formattingModeId,
      onEvent: (event) => context.emit(event),
    })
    if (start.status !== 'started') {
      return dictationStartError(start, reportedSpeechModelId)
    }

    started = start
    const cancel = () => start.cancel()
    if (context.signal.aborted) cancel()
    else context.signal.addEventListener('abort', cancel, { once: true })
    if (stopRequested) start.stop()
    try {
      return dictateTerminalEvent(await start.result, reportedSpeechModelId)
    } finally {
      context.signal.removeEventListener('abort', cancel)
    }
  }

/** `codictate stop`: ends whichever Dictation is recording; its text goes to its starter. */
const stop =
  (deps: CommandLineDeps): CommandHandler<'stop'> =>
  (request) => {
    const refused = requireCommandLineControl(deps, request, 'stop a dictation')
    if (refused) return refused
    return { type: 'result', stopped: deps.dictation.stopAnyDictation() }
  }

// ── models use / download / remove, languages use ────────────────────────

function unknownModel(id: string): ErrorEvent {
  return errorEvent(
    'unknown_model',
    `There is no Speech Model called "${id}". Run codictate models list --all to see them.`
  )
}

function modelNotInstalled(id: string): ErrorEvent {
  return errorEvent(
    'model_not_installed',
    `Speech Model ${id} is not installed. Run codictate models download ${id} first.`
  )
}

/** `codictate models use`: selects the Speech Model exactly as the tray and Settings do. */
const modelsUse =
  (deps: CommandLineDeps): CommandHandler<'models.use'> =>
  async (request) => {
    const refused = requireCommandLineControl(
      deps,
      request,
      'change the Speech Model'
    )
    if (refused) return refused
    const { id } = request.args
    if (getSpeechModel(id) === undefined) return unknownModel(id)
    if (!deps.isModelAvailable(id)) return modelNotInstalled(id)
    const current = deps.getSpeechModelId()
    // Settings does nothing on a click of the selected Speech Model, and neither does this:
    // the selection patch would also switch Live Transcription off.
    if (id === current) return { type: 'result', speechModelId: id }
    const patch = speechModelSelectionPatch(
      {
        speechModelId: current,
        transcriptionLanguageId: deps.getTranscriptionLanguageId(),
        streamMode: deps.getStreamMode(),
      },
      id
    )
    // The write refuses a selection only when its weights are not there to load, so a refusal
    // after the check above means they went away in between.
    if (!(await deps.updateTranscriptionSettings(patch))) {
      return modelNotInstalled(id)
    }
    return { type: 'result', speechModelId: id }
  }

/** How often a `download` event may go out: docs/CLI.md says at most ~4 a second. */
export const DOWNLOAD_EVENT_INTERVAL_MS = 250

/** True when a `download` event may go out now. The first one always may. */
export function createDownloadEventThrottle(
  now: () => number = Date.now
): () => boolean {
  let last: number | null = null
  return () => {
    const time = now()
    if (last !== null && time - last < DOWNLOAD_EVENT_INTERVAL_MS) return false
    last = time
    return true
  }
}

/**
 * `codictate models download`. Goes through the window's download path, so the Models page
 * shows it and the heal pass follows it, and joins a download of the same weights that is
 * already running. Never selects the Speech Model.
 */
const modelsDownload =
  (deps: CommandLineDeps): CommandHandler<'models.download'> =>
  async (request, context) => {
    if (context.signal.aborted) return errorEvent('cancelled', 'Cancelled')
    const refused = requireCommandLineControl(
      deps,
      request,
      'download a Speech Model'
    )
    if (refused) return refused
    const { id } = request.args
    const model = getSpeechModel(id)
    if (model === undefined) return unknownModel(id)
    if (model.bundled === true || deps.isModelAvailable(id)) {
      return { type: 'result', speechModelId: id }
    }

    const download = deps.models.download(id, 'command-line')
    const mayEmit = createDownloadEventThrottle()
    download.onProgress((fraction) => {
      if (!mayEmit()) return
      context.emit({
        type: 'download',
        fraction: Math.round(fraction * 1000) / 1000,
      })
    })
    let onAbort = () => {}
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted')
      if (context.signal.aborted) onAbort()
      else context.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const outcome = await Promise.race([download.result, aborted])
      if (outcome === 'aborted') return errorEvent('cancelled', 'Cancelled')
      switch (outcome.status) {
        case 'installed':
          return { type: 'result', speechModelId: id }
        case 'cancelled':
          return errorEvent(
            'download_failed',
            `The download of ${model.label} was cancelled in Codictate.`
          )
        case 'failed':
          return errorEvent(
            'download_failed',
            `Could not download ${model.label}: ${outcome.message}`
          )
      }
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      // Stops the download unless the window asked for it too.
      download.release()
    }
  }

/** `codictate models remove`: deletes the weights; the heal pass corrects the selection. */
const modelsRemove =
  (deps: CommandLineDeps): CommandHandler<'models.remove'> =>
  async (request) => {
    const refused = requireCommandLineControl(
      deps,
      request,
      'remove a Speech Model'
    )
    if (refused) return refused
    const { id } = request.args
    const model = getSpeechModel(id)
    if (model === undefined) return unknownModel(id)
    if (model.bundled === true) {
      return errorEvent(
        'model_bundled',
        `${model.label} comes with Codictate and cannot be removed.`
      )
    }
    if (!deps.isModelAvailable(id)) return { type: 'result', speechModelId: id }
    if (!(await deps.models.remove(id))) {
      return errorEvent(
        'internal',
        `Codictate could not remove ${model.label}.`
      )
    }
    return { type: 'result', speechModelId: id }
  }

/** `codictate languages use`: as the tray's Transcription Language menu. */
const languagesUse =
  (deps: CommandLineDeps): CommandHandler<'languages.use'> =>
  async (request) => {
    const refused = requireCommandLineControl(
      deps,
      request,
      'change the Transcription Language'
    )
    if (refused) return refused
    const id = request.args.id.trim().toLowerCase()
    if (!isValidTranscriptionLanguageId(id)) {
      return errorEvent(
        'unknown_language',
        `There is no Transcription Language called "${request.args.id}". Run codictate languages list to see them.`
      )
    }
    const speechModelId = deps.getSpeechModelId()
    if (!transcriptionLanguageAllowedForModel(speechModelId, id)) {
      return errorEvent(
        'language_not_allowed',
        `${modelLabel(speechModelId)} cannot transcribe ${transcriptionLanguageLabel(id)}. Choose another Speech Model first, or run codictate languages list.`
      )
    }
    if (id === deps.getTranscriptionLanguageId()) {
      return { type: 'result', transcriptionLanguageId: id }
    }
    if (
      !(await deps.updateTranscriptionSettings({ transcriptionLanguageId: id }))
    ) {
      return errorEvent(
        'internal',
        `Codictate could not switch to ${transcriptionLanguageLabel(id)}.`
      )
    }
    return { type: 'result', transcriptionLanguageId: id }
  }

export function createCommandHandlers(deps: CommandLineDeps): CommandHandlers {
  return {
    transcribe: transcribe(deps),
    status: status(deps),
    'models.list': modelsList(deps),
    'languages.list': languagesList(deps),
    'app.show': appShow(deps),
    dictate: dictate(deps),
    stop: stop(deps),
    'models.use': modelsUse(deps),
    'models.download': modelsDownload(deps),
    'models.remove': modelsRemove(deps),
    'languages.use': languagesUse(deps),
  }
}

/**
 * Handlers that wait for the real ones. The server starts at the top of boot, because the
 * socket is the single-instance lock and the client is already waiting on it; the app's
 * window, config and queue exist only later, so a request that arrives first waits here.
 */
export function deferredCommandHandlers(
  ready: Promise<CommandHandlers>
): CommandHandlers {
  return Object.fromEntries(
    COMMAND_NAMES.map((command) => [
      command,
      async (
        request: CommandRequestOf<CommandName>,
        context: HandlerContext
      ) => {
        const handlers = await ready
        const handler = handlers[command] as CommandHandler<CommandName>
        return handler(request, context)
      },
    ])
  ) as CommandHandlers
}
