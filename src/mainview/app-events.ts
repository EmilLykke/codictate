import type {
  AppStatus,
  AppSettings,
  FileTranscriptionsState,
  FormatterModelTier,
  ModelDownloadProgress,
  NavigateRequest,
  PermissionState,
  SettingsPane,
  TranscriptExportResult,
  UpdateCheckState,
} from '../shared/types'

export type { PermissionState }

type EventMap = {
  permissions: PermissionState
  status: AppStatus
  settings: AppSettings
  openSettings: SettingsPane
  openSettingsScreen: void
  navigate: NavigateRequest
  updateCheckStatus: { state: UpdateCheckState; message?: string }
  modelDownloadProgress: ModelDownloadProgress
  modelAvailability: { modelId: string; available: boolean }
  formatterModelProgress: {
    tier: FormatterModelTier
    progressFraction: number
    done: boolean
    error?: string
  }
  historyEntryAdded: void
  fileTranscriptions: FileTranscriptionsState
  transcriptExportFinished: TranscriptExportResult
}

type Unsubscribe = () => void

class AppEventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>()

  on<K extends keyof EventMap>(
    event: K,
    listener: (data: EventMap[K]) => void
  ): Unsubscribe {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    const set = this.listeners.get(event)!
    set.add(listener as (data: unknown) => void)
    return () => set.delete(listener as (data: unknown) => void)
  }

  emit<K extends keyof EventMap>(
    ...args: EventMap[K] extends void
      ? [event: K]
      : [event: K, data: EventMap[K]]
  ) {
    const [event, data] = args
    this.listeners.get(event)?.forEach((fn) => fn(data as unknown))
  }
}

export const appEvents = new AppEventBus()

/**
 * Navigation from the main process can arrive before the main view has mounted: a window
 * the tray just created is still fetching settings when the request lands. The last request
 * is kept for a short while so the main view can pick it up when it mounts.
 */
const PENDING_NAVIGATION_TTL_MS = 10_000
let pendingNavigation: { request: NavigateRequest; at: number } | null = null

export function dispatchNavigation(request: NavigateRequest): void {
  pendingNavigation = { request, at: Date.now() }
  appEvents.emit('navigate', request)
}

/** The navigation request nobody has handled yet, if it is recent. Clears it. */
export function takePendingNavigation(): NavigateRequest | null {
  const pending = pendingNavigation
  pendingNavigation = null
  if (pending === null) return null
  return Date.now() - pending.at <= PENDING_NAVIGATION_TTL_MS
    ? pending.request
    : null
}
