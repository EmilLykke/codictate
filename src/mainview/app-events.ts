import type {
  AppStatus,
  AppSettings,
  FormatterModelTier,
  PermissionState,
  SettingsPane,
  UpdateCheckState,
} from '../shared/types'

export type { PermissionState }

type EventMap = {
  permissions: PermissionState
  status: AppStatus
  settings: AppSettings
  openSettings: SettingsPane
  openSettingsScreen: void
  updateCheckStatus: { state: UpdateCheckState; message?: string }
  modelDownloadProgress: {
    modelId: string
    progressFraction: number
    done: boolean
    error?: string
  }
  modelAvailability: { modelId: string; available: boolean }
  formatterModelProgress: {
    tier: FormatterModelTier
    progressFraction: number
    done: boolean
    error?: string
  }
  historyEntryAdded: void
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
