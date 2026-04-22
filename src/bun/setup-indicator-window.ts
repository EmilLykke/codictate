import { Screen, type Display } from 'electrobun/bun'
import type {
  AppSettings,
  AppStatus,
  RecordingIndicatorMode,
} from '../shared/types'
import {
  createNativeIndicatorHelper,
  type NativeIndicatorHelper,
} from './utils/window/native-indicator-helper'

/** Window frame around the circular HUD (56px circle + padding). */
const INDICATOR_FRAME_PX = 72

export type IndicatorWindowHandle = {
  onAppStatus: (status: AppStatus) => void
  onConfigChanged: () => void
  dispose: () => void
}

/**
 * Resolve saved vs onboarding-preview mode and whether the indicator process
 * should keep a window alive.
 */
function readIndicatorPlan(
  getSettings: () => AppSettings,
  previewMode: RecordingIndicatorMode | null
): {
  mode: RecordingIndicatorMode
  wantLifecycle: boolean
} {
  const settings = getSettings()
  const savedMode = settings.recordingIndicatorMode ?? ('always' as const)
  const mode = previewMode ?? savedMode
  const wantLifecycle =
    mode !== 'off' && (settings.onboardingCompleted || previewMode !== null)
  return { mode, wantLifecycle }
}

/** Actually visible on screen (not parked off-screen). */
function indicatorShouldBeVisible(
  mode: RecordingIndicatorMode,
  status: AppStatus
): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return status === 'recording' || status === 'transcribing'
}

function bottomRightFrame(display?: Display): {
  x: number
  y: number
  width: number
  height: number
} {
  const targetDisplay = display ?? Screen.getPrimaryDisplay()
  const { bounds } = targetDisplay
  const margin = 16
  const x = Math.round(bounds.x + bounds.width - INDICATOR_FRAME_PX - margin)
  const y = Math.round(bounds.y + bounds.height - INDICATOR_FRAME_PX - margin)
  return { x, y, width: INDICATOR_FRAME_PX, height: INDICATOR_FRAME_PX }
}

export function setupIndicatorWindow(deps: {
  getSettings: () => AppSettings
  getRecordingIndicatorPosition: () => AppSettings['recordingIndicatorPosition']
  saveRecordingIndicatorPosition: (x: number, y: number) => void | Promise<void>
  getOnboardingIndicatorPreviewMode: () => RecordingIndicatorMode | null
}): IndicatorWindowHandle {
  let lastStatus: AppStatus = 'ready'
  let positionSaveTimer: ReturnType<typeof setTimeout> | null = null
  let helper: NativeIndicatorHelper | null = null

  function clearPositionSaveTimer() {
    if (positionSaveTimer) {
      clearTimeout(positionSaveTimer)
      positionSaveTimer = null
    }
  }

  function destroyWindow() {
    clearPositionSaveTimer()
    helper?.dispose()
    helper = null
  }

  function intersectsAnyDisplay(
    x: number,
    y: number,
    w: number,
    h: number
  ): boolean {
    const displays = Screen.getAllDisplays()
    if (displays.length === 0) return true
    for (const d of displays) {
      const b = d.bounds
      if (
        x + w > b.x &&
        x < b.x + b.width &&
        y + h > b.y &&
        y < b.y + b.height
      ) {
        return true
      }
    }
    return false
  }

  function getDisplayContainingFrame(
    x: number,
    y: number,
    width: number,
    height: number
  ): Display | null {
    const displays = Screen.getAllDisplays()
    for (const display of displays) {
      const b = display.bounds
      const fullyContained =
        x >= b.x &&
        y >= b.y &&
        x + width <= b.x + b.width &&
        y + height <= b.y + b.height
      if (fullyContained) return display
    }
    return null
  }

  function clampFrameToDisplay(
    display: Display,
    frame: { x: number; y: number; width: number; height: number }
  ): { x: number; y: number; width: number; height: number } {
    const b = display.bounds
    const maxX = b.x + Math.max(0, b.width - frame.width)
    const maxY = b.y + Math.max(0, b.height - frame.height)
    return {
      x: Math.min(Math.max(frame.x, b.x), maxX),
      y: Math.min(Math.max(frame.y, b.y), maxY),
      width: frame.width,
      height: frame.height,
    }
  }

  function displayContainsPoint(
    display: Display,
    x: number,
    y: number
  ): boolean {
    const b = display.bounds
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
  }

  function getCursorDisplay(): Display | null {
    const cursor = Screen.getCursorScreenPoint()
    const displays = Screen.getAllDisplays()
    for (const display of displays) {
      if (displayContainsPoint(display, cursor.x, cursor.y)) return display
    }
    return displays[0] ?? null
  }

  function resolvePreferredDisplay(): Display {
    return getCursorDisplay() ?? Screen.getPrimaryDisplay()
  }

  function resolveInitialIndicatorFrame(): {
    x: number
    y: number
    width: number
    height: number
  } {
    const saved = deps.getRecordingIndicatorPosition()
    if (saved === null) return bottomRightFrame(resolvePreferredDisplay())
    const { x, y } = saved
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !intersectsAnyDisplay(x, y, INDICATOR_FRAME_PX, INDICATOR_FRAME_PX)
    ) {
      return bottomRightFrame(resolvePreferredDisplay())
    }

    const rounded = {
      x: Math.round(x),
      y: Math.round(y),
      width: INDICATOR_FRAME_PX,
      height: INDICATOR_FRAME_PX,
    }

    const containingDisplay = getDisplayContainingFrame(
      rounded.x,
      rounded.y,
      rounded.width,
      rounded.height
    )
    if (containingDisplay) return rounded

    return clampFrameToDisplay(resolvePreferredDisplay(), rounded)
  }

  function scheduleSaveIndicatorPosition(x: number, y: number) {
    clearPositionSaveTimer()
    positionSaveTimer = setTimeout(() => {
      positionSaveTimer = null
      void deps.saveRecordingIndicatorPosition(x, y)
    }, 450)
  }

  function getOrCreateHelper(): NativeIndicatorHelper | null {
    if (!deps.getSettings().capabilities.supportsNativeIndicator) return null
    if (helper) return helper
    helper = createNativeIndicatorHelper((x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      scheduleSaveIndicatorPosition(Math.round(x), Math.round(y))
    })
    return helper
  }

  function applyVisibleOverlayBehavior(status: AppStatus) {
    const frame = resolveInitialIndicatorFrame()
    const nativeHelper = getOrCreateHelper()
    if (!nativeHelper) return
    nativeHelper.show(frame, status)
  }

  function parkIndicatorWindow() {
    clearPositionSaveTimer()
    helper?.hide()
  }

  const onAppStatus = (status: AppStatus) => {
    lastStatus = status
    const previewMode = deps.getOnboardingIndicatorPreviewMode()
    const { mode, wantLifecycle } = readIndicatorPlan(
      deps.getSettings,
      previewMode
    )
    const wantVisible = wantLifecycle && indicatorShouldBeVisible(mode, status)

    if (!wantLifecycle) {
      destroyWindow()
      return
    }

    if (wantVisible) {
      applyVisibleOverlayBehavior(status)
      helper?.setStatus(status)
    } else {
      parkIndicatorWindow()
    }
  }

  const onConfigChanged = () => {
    onAppStatus(lastStatus)
  }

  const dispose = () => {
    destroyWindow()
  }

  return { onAppStatus, onConfigChanged, dispose }
}
