import { join } from 'node:path'
import { Tray, BrowserWindow } from 'electrobun/bun'
import { AppConfig } from './AppConfig/AppConfig'
import {
  buildDeviceMenuItems,
  handleDeviceAction,
} from './utils/device-actions'
import {
  buildTranscriptionLanguageMenuItems,
  handleTranscriptionLanguageAction,
} from './utils/transcription-language-actions'
import { buildModelMenuItems, handleModelAction } from './utils/model-actions'
import { speechModelLocksTranscriptionLanguage } from '../shared/speech-models'
import { shortcutTrayCompact } from '../shared/shortcut-options'
import {
  FORMATTING_MODE_ORDER,
  formattingModeLabel,
  isValidFormattingModeId,
  type FormattingModeId,
} from '../shared/formatting-modes'
import { getPlatformRuntime } from './platform/runtime'
import type { AudioDeviceDetails } from '../shared/types'

export type TrayHandlers = {
  setTrayIdle: () => void
  setTrayRecording: () => void
  setTrayTranscribing: () => void
  setTrayStreaming: () => void
  /**
   * A Dictation refused to start. The tray is the one surface that is always visible with no
   * window open, so it carries the error state until the next Dictation replaces it.
   */
  setTrayError: (message: string) => void
  refreshTrayShortcutTitle: () => void
  rebuildDeviceMenu: (selectedDevice: number) => void
  updateDeviceList: (
    newDevices: Record<string, string>,
    selectedDevice: number,
    newDeviceDetails?: Record<string, AudioDeviceDetails>
  ) => void
  setUpdateChecking: () => void
  showUpdateReady: () => void
  resetUpdateState: () => void
  syncTranslateState: () => void
  syncStreamModeState: () => void
  syncFormattingModeState: () => void
  syncModelState: () => void
}

/** How long the blocked reason stays on the tray before it goes back to Ready. */
const TRAY_ERROR_CLEAR_MS = 20_000

const trayIconPath =
  getPlatformRuntime() === 'windows'
    ? join(import.meta.dir, '../images/TrayIcon.ico')
    : join(import.meta.dir, '../images/MacTrayIcon.svg')

export const setupTray = (
  getOrCreateWindow: (onAction?: () => void) => BrowserWindow,
  devices: Record<string, string>,
  deviceDetails: Record<string, AudioDeviceDetails> | undefined,
  appConfig: AppConfig,
  onQuit: () => void,
  onDeviceSelected?: (device: number) => void,
  onOpenSettings?: () => void,
  onApplyUpdate?: () => void,
  onCheckForUpdate?: () => void,
  /** After tray changes transcription language — sync webview (e.g. updateSettings). */
  onTranscriptionLanguageChanged?: () => void,
  /** After tray changes formatting mode — sync webview. */
  onFormattingModeChanged?: () => void,
  /** After tray changes the transcription model — sync webview. */
  onModelChanged?: () => void
): TrayHandlers => {
  const tray = new Tray({
    image: trayIconPath,
    // template: true renders the icon as a macOS template image — it
    // automatically inverts for light/dark mode. Requires a black + transparent
    // PNG. Set to false if the icon uses colours.
    template: getPlatformRuntime() !== 'windows',
    width: 16,
    height: 16,
  })

  let currentDevices = devices
  let currentDeviceDetails = deviceDetails

  const resolveCurrentDevice = () =>
    appConfig.resolveAudioDevice(currentDevices, currentDeviceDetails)

  type UpdateState = 'idle' | 'checking' | 'ready'
  let updateState: UpdateState = 'idle'

  // Declared before buildMenu because the status row reads it on the very first
  // setMenu call.
  type TrayVisualState =
    'idle' | 'recording' | 'transcribing' | 'streaming' | 'error'
  let trayVisualState: TrayVisualState = 'idle'
  /** The blocked reason, shown in the status row for as long as the error state lasts. */
  let trayErrorMessage: string | null = null
  let trayErrorTimer: ReturnType<typeof setTimeout> | null = null

  const clearTrayError = () => {
    if (trayErrorTimer !== null) {
      clearTimeout(trayErrorTimer)
      trayErrorTimer = null
    }
    trayErrorMessage = null
  }

  const updateMenuItem = () => {
    if (updateState === 'ready')
      return {
        type: 'normal' as const,
        label: '⬆ Restart to Update',
        action: 'restart-to-update',
      }
    if (updateState === 'checking')
      return {
        type: 'normal' as const,
        label: 'Checking for Updates…',
        action: 'noop',
      }
    return {
      type: 'normal' as const,
      label: 'Check for Updates',
      action: 'check-for-update',
    }
  }

  /**
   * Compact form of both Dictation Shortcut slots, e.g. `⌥+Space / fn` on macOS and
   * `Alt+Space` on Windows. The platform must be passed explicitly:
   * `shortcutTrayCompact` defaults to macOS, and this string is the tray's first row,
   * so defaulting would put ⌘ / ⌥ glyphs in front of Windows users. Platform parity
   * in AGENTS.md forbids that.
   */
  const shortcutSummary = () => {
    const platform = getPlatformRuntime()
    const main = shortcutTrayCompact(appConfig.getShortcutId(), platform)
    const hold = appConfig.getShortcutHoldOnlyId()
    if (hold === null) return main
    return `${main} / ${shortcutTrayCompact(hold, platform)}`
  }

  const STATUS_LABELS: Record<TrayVisualState, string> = {
    idle: 'Ready',
    recording: 'Recording',
    transcribing: 'Transcribing…',
    streaming: 'Live transcription',
    error: 'Dictation blocked',
  }

  /**
   * Top item doubles as the status readout and the way into the app, which is why
   * there is no separate "Open Codictate" entry.
   */
  const statusMenuItem = () => ({
    type: 'normal' as const,
    label:
      trayVisualState === 'error' && trayErrorMessage !== null
        ? `⚠ ${STATUS_LABELS.error} · ${trayErrorMessage}`
        : `● ${STATUS_LABELS[trayVisualState]} · ${shortcutSummary()}`,
    action: 'open',
  })

  const selectedDeviceLabel = (selectedDevice: number) =>
    buildDeviceMenuItems(currentDevices, selectedDevice).find((d) => d.checked)
      ?.label ?? 'System default'

  const selectedModelLabel = () =>
    buildModelMenuItems(appConfig.getWhisperModelId()).find((m) => m.checked)
      ?.label ?? appConfig.getWhisperModelId()

  const selectedLanguageLabel = () =>
    buildTranscriptionLanguageMenuItems(
      appConfig.getTranscriptionLanguageId()
    ).find((l) => l.checked)?.label ?? 'Automatic'

  const buildFormattingMenuItems = (cfg: AppConfig) => {
    const forced = cfg.getFormattingForceModeId()
    const masterOn = cfg.getFormattingEnabled()
    return [
      {
        type: 'normal' as const,
        label: masterOn
          ? 'Auto (detect from focused app)'
          : 'Auto — Formatting is off',
        action: 'set-formatting-force-auto',
        checked: forced === null,
      },
      { type: 'divider' as const },
      ...FORMATTING_MODE_ORDER.map((id) => ({
        type: 'normal' as const,
        label: `Force: ${formattingModeLabel(id)}`,
        action: `set-formatting-force-${id}`,
        checked: forced === id,
      })),
    ]
  }

  const formattingMenuLabel = (cfg: AppConfig) => {
    if (!cfg.getFormattingEnabled()) return 'Formatting: Off'
    const forced = cfg.getFormattingForceModeId()
    if (forced === null) return 'Formatting: Auto'
    return `Formatting: ${formattingModeLabel(forced)}`
  }

  /**
   * Status and shortcut on top, then the four settings a user changes mid-session,
   * then app-level actions. Translate to English and Live transcription are
   * deliberately absent: they need readiness explanation that does not fit a menu
   * label, so they live in Settings.
   */
  const buildMenu = (selectedDevice: number) => [
    statusMenuItem(),
    { type: 'normal' as const, label: 'Settings…', action: 'open-settings' },
    { type: 'divider' as const },
    {
      type: 'normal' as const,
      label: `Microphone: ${selectedDeviceLabel(selectedDevice)}`,
      submenu: buildDeviceMenuItems(currentDevices, selectedDevice),
    },
    {
      type: 'normal' as const,
      label: `Model: ${selectedModelLabel()}`,
      submenu: buildModelMenuItems(appConfig.getWhisperModelId()),
    },
    speechModelLocksTranscriptionLanguage(appConfig.getWhisperModelId())
      ? {
          type: 'normal' as const,
          label: 'Language: Automatic (Parakeet)',
          action: 'noop',
        }
      : {
          type: 'normal' as const,
          label: `Language: ${selectedLanguageLabel()}`,
          submenu: buildTranscriptionLanguageMenuItems(
            appConfig.getTranscriptionLanguageId()
          ),
        },
    {
      type: 'normal' as const,
      label: formattingMenuLabel(appConfig),
      submenu: buildFormattingMenuItems(appConfig),
    },
    { type: 'divider' as const },
    updateMenuItem(),
    {
      type: 'normal' as const,
      label: 'Quit Codictate',
      action: 'quit',
    },
  ]

  tray.setMenu(buildMenu(resolveCurrentDevice()))

  tray.on('tray-clicked', (e) => {
    const event = e as { data: { action: string } }
    if (event.data.action === 'open') {
      getOrCreateWindow().focus()
    }
    if (event.data.action === 'open-settings') {
      onOpenSettings?.()
    }
    if (event.data.action === 'check-for-update') onCheckForUpdate?.()
    if (event.data.action === 'restart-to-update') onApplyUpdate?.()
    if (event.data.action === 'quit') onQuit()
    if (event.data.action === 'noop') return
    handleDeviceAction(
      event.data.action,
      appConfig,
      currentDevices,
      (device) => {
        tray.setMenu(buildMenu(device))
        onDeviceSelected?.(device)
      },
      currentDeviceDetails
    )
    handleTranscriptionLanguageAction(event.data.action, appConfig, () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
      onTranscriptionLanguageChanged?.()
    })
    handleModelAction(event.data.action, appConfig, () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
      onModelChanged?.()
    })
    if (event.data.action.startsWith('set-formatting-force-')) {
      const suffix = event.data.action.replace('set-formatting-force-', '')
      void (async () => {
        if (suffix === 'auto') {
          const forcedBefore = appConfig.getFormattingForceModeId()
          if (forcedBefore !== null) {
            const ok = await appConfig.setFormattingForceModeId(null)
            tray.setMenu(buildMenu(resolveCurrentDevice()))
            if (ok) onFormattingModeChanged?.()
          } else {
            const ok = await appConfig.setFormattingEnabled(
              !appConfig.getFormattingEnabled()
            )
            tray.setMenu(buildMenu(resolveCurrentDevice()))
            if (ok) onFormattingModeChanged?.()
          }
          return
        }
        const next: FormattingModeId | null = isValidFormattingModeId(suffix)
          ? suffix
          : null
        const ok = await appConfig.setFormattingForceModeId(next)
        tray.setMenu(buildMenu(resolveCurrentDevice()))
        if (ok) onFormattingModeChanged?.()
      })()
    }
  })

  tray.setTitle('')

  return {
    refreshTrayShortcutTitle: () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
      if (trayVisualState === 'idle') tray.setTitle('')
    },
    setTrayIdle: () => {
      clearTrayError()
      trayVisualState = 'idle'
      tray.setTitle('')
    },
    setTrayRecording: () => {
      clearTrayError()
      trayVisualState = 'recording'
      tray.setTitle(' Listening...')
    },
    setTrayTranscribing: () => {
      clearTrayError()
      trayVisualState = 'transcribing'
      tray.setTitle(' …')
    },
    /**
     * The blocked reason on the tray: a warning glyph in the title, and the sentence itself
     * in the status row so it is readable with no window open. Self-clearing, because a
     * lingering warning after the user has moved on is its own kind of lie - and any of the
     * four normal states clears it the moment a Dictation runs.
     */
    setTrayError: (message: string) => {
      if (trayErrorTimer !== null) clearTimeout(trayErrorTimer)
      trayVisualState = 'error'
      trayErrorMessage = message
      tray.setTitle(' ⚠')
      tray.setMenu(buildMenu(resolveCurrentDevice()))
      trayErrorTimer = setTimeout(() => {
        trayErrorTimer = null
        if (trayVisualState !== 'error') return
        trayVisualState = 'idle'
        trayErrorMessage = null
        tray.setTitle('')
        tray.setMenu(buildMenu(resolveCurrentDevice()))
      }, TRAY_ERROR_CLEAR_MS)
    },
    setTrayStreaming: () => {
      clearTrayError()
      trayVisualState = 'streaming' as TrayVisualState
      tray.setTitle(' Live…')
    },
    rebuildDeviceMenu: (selectedDevice: number) =>
      tray.setMenu(buildMenu(selectedDevice)),
    updateDeviceList: (
      newDevices: Record<string, string>,
      selectedDevice: number,
      newDeviceDetails?: Record<string, AudioDeviceDetails>
    ) => {
      currentDevices = newDevices
      currentDeviceDetails = newDeviceDetails
      tray.setMenu(buildMenu(selectedDevice))
    },
    setUpdateChecking: () => {
      updateState = 'checking'
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    showUpdateReady: () => {
      updateState = 'ready'
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    resetUpdateState: () => {
      updateState = 'idle'
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    syncTranslateState: () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    syncStreamModeState: () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    syncFormattingModeState: () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
    syncModelState: () => {
      tray.setMenu(buildMenu(resolveCurrentDevice()))
    },
  }
}
