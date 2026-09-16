import { DICTATION_HOLD_QUALIFY_MS } from './dictation-shortcut'
import type { ShortcutId } from './types'
import type { PlatformRuntime } from './platform'

/** Used to group shortcuts in the picker (Option / Fn / Control / Meta). */
export type ShortcutFamily = 'option' | 'fn' | 'control' | 'meta'

export type ShortcutModifier = 'option' | 'control' | 'command' | 'shift' | 'fn'
export type ShortcutBinding =
  | {
      kind: 'trigger'
      key: 'space' | 'enter' | 'f1' | 'f2'
      modifiers: ShortcutModifier[]
      swallowPrefix?: ShortcutModifier[]
    }
  | { kind: 'modifiers'; modifiers: ShortcutModifier[] }
  | { kind: 'physical'; key: 'rightOption' | 'fn'; modifier: ShortcutModifier }

/** Single source of truth for dictation shortcuts (picker UI + keyboard display). */
export interface ShortcutOption {
  id: ShortcutId
  keys: string[]
  label: string
  windowsKeys?: string[]
  windowsLabel?: string
  supportedPlatforms: PlatformRuntime[]
  family: ShortcutFamily
  binding: ShortcutBinding
  /** On Windows, releasing a Modifier ends the hold before the Trigger Key does. */
  windowsHoldEndsOnModifierRelease: boolean
}

/**
 * The exhaustive Preset catalog. Adding a `ShortcutId` requires its complete metadata here,
 * and removing one leaves a compile error until the catalog follows.
 */
export const SHORTCUT_PRESETS = {
  'option-space': {
    id: 'option-space',
    binding: { kind: 'trigger', key: 'space', modifiers: ['option'] },
    keys: ['⌥', 'Space'],
    label: 'Option + Space',
    windowsKeys: ['Alt', 'Space'],
    windowsLabel: 'Alt + Space',
    supportedPlatforms: ['macos', 'windows'],
    family: 'option',
    windowsHoldEndsOnModifierRelease: true,
  },
  'right-option': {
    id: 'right-option',
    binding: { kind: 'physical', key: 'rightOption', modifier: 'option' },
    keys: ['Right ⌥'],
    label: 'Right Option',
    windowsKeys: ['Right Alt'],
    windowsLabel: 'Right Alt',
    supportedPlatforms: ['macos', 'windows'],
    family: 'option',
    windowsHoldEndsOnModifierRelease: false,
  },
  'option-enter': {
    id: 'option-enter',
    binding: { kind: 'trigger', key: 'enter', modifiers: ['option'] },
    keys: ['⌥', 'Enter'],
    label: 'Option + Enter',
    windowsKeys: ['Alt', 'Enter'],
    windowsLabel: 'Alt + Enter',
    supportedPlatforms: ['macos', 'windows'],
    family: 'option',
    windowsHoldEndsOnModifierRelease: true,
  },
  'fn-space': {
    id: 'fn-space',
    binding: { kind: 'trigger', key: 'space', modifiers: ['fn'] },
    keys: ['Fn', 'Space'],
    label: 'Fn + Space',
    supportedPlatforms: ['macos'],
    family: 'fn',
    windowsHoldEndsOnModifierRelease: false,
  },
  'fn-f1': {
    id: 'fn-f1',
    binding: { kind: 'trigger', key: 'f1', modifiers: ['fn'] },
    keys: ['Fn', 'F1'],
    label: 'Fn + F1',
    supportedPlatforms: ['macos'],
    family: 'fn',
    windowsHoldEndsOnModifierRelease: false,
  },
  'fn-f2': {
    id: 'fn-f2',
    binding: { kind: 'trigger', key: 'f2', modifiers: ['fn'] },
    keys: ['Fn', 'F2'],
    label: 'Fn + F2',
    supportedPlatforms: ['macos'],
    family: 'fn',
    windowsHoldEndsOnModifierRelease: false,
  },
  'fn-globe': {
    id: 'fn-globe',
    binding: { kind: 'physical', key: 'fn', modifier: 'fn' },
    keys: ['Fn'],
    label: 'Fn only (Globe)',
    supportedPlatforms: ['macos'],
    family: 'fn',
    windowsHoldEndsOnModifierRelease: false,
  },
  'control-space': {
    id: 'control-space',
    binding: { kind: 'trigger', key: 'space', modifiers: ['control'] },
    keys: ['⌃', 'Space'],
    label: 'Control + Space',
    windowsKeys: ['Ctrl', 'Space'],
    windowsLabel: 'Ctrl + Space',
    supportedPlatforms: ['macos', 'windows'],
    family: 'control',
    windowsHoldEndsOnModifierRelease: true,
  },
  'control-enter': {
    id: 'control-enter',
    binding: { kind: 'trigger', key: 'enter', modifiers: ['control'] },
    keys: ['⌃', 'Enter'],
    label: 'Control + Enter',
    windowsKeys: ['Ctrl', 'Enter'],
    windowsLabel: 'Ctrl + Enter',
    supportedPlatforms: ['macos', 'windows'],
    family: 'control',
    windowsHoldEndsOnModifierRelease: true,
  },
  'control-option': {
    id: 'control-option',
    binding: { kind: 'modifiers', modifiers: ['control', 'option'] },
    keys: ['⌃', '⌥'],
    label: 'Control + Option',
    windowsKeys: ['Ctrl', 'Alt'],
    windowsLabel: 'Ctrl + Alt',
    supportedPlatforms: ['macos', 'windows'],
    family: 'control',
    windowsHoldEndsOnModifierRelease: false,
  },
  'control-meta': {
    id: 'control-meta',
    binding: { kind: 'modifiers', modifiers: ['control', 'command'] },
    keys: ['⌃', '⌘'],
    label: 'Control + Command',
    windowsKeys: ['Ctrl', 'Win'],
    windowsLabel: 'Ctrl + Win',
    supportedPlatforms: ['macos', 'windows'],
    family: 'meta',
    windowsHoldEndsOnModifierRelease: false,
  },
  'control-meta-space': {
    id: 'control-meta-space',
    binding: {
      kind: 'trigger',
      key: 'space',
      modifiers: ['control', 'command'],
      swallowPrefix: ['command'],
    },
    keys: ['⌃', '⌘', 'Space'],
    label: 'Control + Command + Space',
    windowsKeys: ['Ctrl', 'Win', 'Space'],
    windowsLabel: 'Ctrl + Win + Space',
    supportedPlatforms: ['macos', 'windows'],
    family: 'meta',
    windowsHoldEndsOnModifierRelease: true,
  },
} satisfies Record<ShortcutId, ShortcutOption>

export const SHORTCUT_OPTIONS: ShortcutOption[] =
  Object.values(SHORTCUT_PRESETS)

export function shortcutFamily(id: ShortcutId): ShortcutFamily {
  return SHORTCUT_PRESETS[id].family
}

function optionSupportedOnPlatform(
  option: ShortcutOption,
  platform: PlatformRuntime
): boolean {
  return option.supportedPlatforms.includes(platform)
}

export function shortcutSupportedOnPlatform(
  id: ShortcutId,
  platform: PlatformRuntime
): boolean {
  return optionSupportedOnPlatform(SHORTCUT_PRESETS[id], platform)
}

/** Validate an untrusted Shortcut ID and its availability on this runtime. */
export function isSupportedShortcutId(
  value: unknown,
  platform: PlatformRuntime
): value is ShortcutId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SHORTCUT_PRESETS, value) &&
    shortcutSupportedOnPlatform(value as ShortcutId, platform)
  )
}

function displayShortcutOption(
  option: ShortcutOption,
  platform: PlatformRuntime
): ShortcutOption {
  if (platform !== 'windows') return option
  return {
    ...option,
    keys: option.windowsKeys ?? option.keys,
    label: option.windowsLabel ?? option.label,
  }
}

/** Resolve a shortcut row for UI (falls back to first option if id is unknown). */
export function shortcutOptionById(
  id: ShortcutId,
  platform: PlatformRuntime = 'macos'
): ShortcutOption {
  const option = SHORTCUT_PRESETS[id] ?? SHORTCUT_OPTIONS[0]
  return displayShortcutOption(option, platform)
}

const FAMILY_ORDER: ShortcutFamily[] = ['option', 'fn', 'control', 'meta']

const FAMILY_LABEL: Record<ShortcutFamily, string> = {
  option: 'Option (⌥)',
  fn: 'Fn / Globe',
  control: 'Control (⌃)',
  meta: 'Command (⌘)',
}

const WINDOWS_FAMILY_LABEL: Record<ShortcutFamily, string> = {
  option: 'Alt',
  fn: 'Fn / Globe',
  control: 'Control (Ctrl)',
  meta: 'Windows (Win)',
}

export function shortcutOptionsGrouped(): {
  family: ShortcutFamily
  title: string
  options: ShortcutOption[]
}[] {
  return shortcutOptionsGroupedForPlatform('macos')
}

export function shortcutOptionsGroupedForPlatform(platform: PlatformRuntime): {
  family: ShortcutFamily
  title: string
  options: ShortcutOption[]
}[] {
  const byFamily: Record<ShortcutFamily, ShortcutOption[]> = {
    option: [],
    fn: [],
    control: [],
    meta: [],
  }
  for (const opt of SHORTCUT_OPTIONS) {
    if (!optionSupportedOnPlatform(opt, platform)) continue
    byFamily[shortcutFamily(opt.id)].push(displayShortcutOption(opt, platform))
  }
  return FAMILY_ORDER.map((family) => ({
    family,
    title:
      platform === 'windows'
        ? WINDOWS_FAMILY_LABEL[family]
        : FAMILY_LABEL[family],
    options: byFamily[family],
  })).filter((group) => group.options.length > 0)
}

/** Key cap labels for a shortcut (for inline UI, e.g. Ready / onboarding). */
export function shortcutDisplayKeys(
  id: ShortcutId,
  platform: PlatformRuntime = 'macos'
): string[] {
  return shortcutOptionById(id, platform).keys
}

/** Compact label for tray menu (Space → ␣; keys joined with +). */
export function shortcutTrayCompact(
  id: ShortcutId,
  platform: PlatformRuntime = 'macos'
): string {
  return shortcutDisplayKeys(id, platform).join('+')
}

/** Ready / onboarding: section title + body for hold-to-talk mode. */
export const dictationShortcutSummaryHoldTitle = 'Hold'

export const dictationShortcutSummaryHoldBody =
  'Keep the shortcut pressed while you talk, then release to paste.'

/** Ready / onboarding: section title + body for tap-to-latch mode. */
export const dictationShortcutSummaryTapTitle = 'Tap'

export const dictationShortcutSummaryTapBody =
  'Press once and let go, talk hands-free, then press the shortcut again to paste.'

/** Ready screen: sentence parts around underlined Hold / Tap hover terms. */
export const dictationReadyStartHintBeforeHold = 'To start dictating, use the '

export const dictationReadyStartHintBetween = ' or '

export const dictationReadyStartHintAfterTap =
  ' option with the main shortcut above.'

/** Ready screen: push-to-talk column — sentence parts around underlined Hold. */
export const dictationReadyPttHintBefore = 'This shortcut is '

export const dictationReadyPttHintAfter =
  ' only: keep it pressed while you talk, then release to paste.'

/** Full explanation for Settings (hold threshold + latch; see `DICTATION_HOLD_QUALIFY_MS`). */
export function dictationShortcutBehaviorHint(): string {
  const s = DICTATION_HOLD_QUALIFY_MS / 1000
  const dur = s >= 1 ? `${s} seconds` : `${DICTATION_HOLD_QUALIFY_MS} ms`
  return `Hold the shortcut about ${dur} while you speak, then release to stop recording and paste. To stay hands-free, tap quickly (press and release) to latch: when you are done, press the shortcut again to stop and paste.`
}

/** Explains optional second shortcut (push-to-talk only). */
export function dictationHoldOnlyShortcutHint(): string {
  return 'Optional second shortcut: always push-to-talk — release stops and pastes.'
}

export function platformShortcutSupportHint(
  platform: PlatformRuntime
): string | null {
  if (platform !== 'windows') return null
  return 'Windows supports Alt, Ctrl and Win shortcuts. Fn / Globe shortcuts are coming soon.'
}

/**
 * Windows combos whose hold ends on modifier release rather than trigger release.
 * Only Presets with a Trigger Key need this; modifier-only Presets end their hold
 * when the modifier goes up either way.
 */
export function windowsUsesModifierReleaseHold(id: ShortcutId): boolean {
  return SHORTCUT_PRESETS[id].windowsHoldEndsOnModifierRelease
}

export function isModifierChord(
  id: ShortcutId,
  modifier: ShortcutModifier
): boolean {
  const binding: ShortcutBinding = SHORTCUT_PRESETS[id].binding
  return binding.kind === 'trigger' && binding.modifiers.includes(modifier)
}
