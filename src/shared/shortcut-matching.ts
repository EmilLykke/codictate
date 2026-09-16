import {
  SHORTCUT_PRESETS,
  type ShortcutBinding,
  type ShortcutModifier,
} from './shortcut-options'
import type { ShortcutId } from './types'
import type { PlatformRuntime } from './platform'

export const KeyCode: Record<number, string> = {
  49: 'space',
  36: 'enter',
  53: 'escape',
  51: 'delete',
  48: 'tab',
  122: 'f1',
  120: 'f2',
  99: 'f3',
  118: 'f4',
  // modifiers
  56: 'shift',
  60: 'rightShift',
  55: 'command',
  54: 'rightCommand',
  58: 'option',
  61: 'rightOption',
  59: 'control',
  62: 'rightControl',
  /** Fn / globe (hardware-dependent; Swift also handles 179). */
  63: 'fn',
  179: 'globeFn',
} as const

// Reverse lookup: name → keycode number (e.g. Key.space === 49)
export const Key = Object.fromEntries(
  Object.entries(KeyCode).map(([code, name]) => [name, Number(code)])
) as Record<string, number>

/** Physical keycodes that can represent Fn / Globe on different Macs. */
export const FN_PHYSICAL_KEYCODES = [Key.fn, Key.globeFn] as const

export interface KeyEvent {
  keycode: number
  option: boolean
  leftOption?: boolean
  rightOption?: boolean
  command: boolean
  control: boolean
  shift: boolean
  fn: boolean
  keyDown: boolean
  isRepeat: boolean
}

export function normalizeKeyEvent(
  parsed: Record<string, unknown>
): KeyEvent | null {
  if (typeof parsed.keycode !== 'number') return null
  return {
    keycode: parsed.keycode,
    option: Boolean(parsed.option),
    leftOption:
      typeof parsed.leftOption === 'boolean' ? parsed.leftOption : undefined,
    rightOption:
      typeof parsed.rightOption === 'boolean' ? parsed.rightOption : undefined,
    command: Boolean(parsed.command),
    control: Boolean(parsed.control),
    shift: Boolean(parsed.shift),
    fn: Boolean(parsed.fn),
    keyDown: parsed.keyDown !== false,
    isRepeat: Boolean(parsed.isRepeat),
  }
}

/** Swallow rule payload for KeyListener (modifiers must match exactly). */
export function serializeSwallowRule(r: KeyEvent): Record<string, unknown> {
  return {
    keycode: r.keycode,
    option: r.option,
    ...(typeof r.leftOption === 'boolean' ? { leftOption: r.leftOption } : {}),
    ...(typeof r.rightOption === 'boolean'
      ? { rightOption: r.rightOption }
      : {}),
    command: r.command,
    control: r.control,
    shift: r.shift,
    fn: r.fn,
  }
}

function rule(
  keycode: number,
  mods: Partial<
    Pick<
      KeyEvent,
      | 'option'
      | 'leftOption'
      | 'rightOption'
      | 'command'
      | 'control'
      | 'shift'
      | 'fn'
    >
  >
): KeyEvent {
  return {
    keycode,
    option: mods.option ?? false,
    leftOption: mods.leftOption,
    rightOption: mods.rightOption,
    command: mods.command ?? false,
    control: mods.control ?? false,
    shift: mods.shift ?? false,
    fn: mods.fn ?? false,
    keyDown: true,
    isRepeat: false,
  }
}

export const MODIFIER_KEYCODES: Record<ShortcutModifier, readonly number[]> = {
  option: [Key.option, Key.rightOption],
  control: [Key.control, Key.rightControl],
  command: [Key.command, Key.rightCommand],
  shift: [Key.shift, Key.rightShift],
  fn: FN_PHYSICAL_KEYCODES,
}

export interface ShortcutDefinition {
  swallowRules: KeyEvent[]
  matchesToggleDown: (event: KeyEvent) => boolean
  matchesHoldDown: (event: KeyEvent) => boolean
  matchesHoldUp: (event: KeyEvent) => boolean
}

export function getShortcutDefinition(
  id: ShortcutId,
  options: { requireLeftOption?: boolean; platform: PlatformRuntime }
): ShortcutDefinition {
  const preset = SHORTCUT_PRESETS[id]
  const binding: ShortcutBinding = preset.binding
  const modifiers =
    binding.kind === 'physical' ? [binding.modifier] : binding.modifiers
  const keycodes =
    binding.kind === 'trigger'
      ? [Key[binding.key]]
      : binding.kind === 'physical'
        ? binding.key === 'fn'
          ? [...FN_PHYSICAL_KEYCODES]
          : [Key[binding.key]]
        : modifiers.flatMap((modifier) => [...MODIFIER_KEYCODES[modifier]])
  const leftOnly =
    options.requireLeftOption === true &&
    binding.kind === 'trigger' &&
    modifiers.includes('option')
  const mods = Object.fromEntries(modifiers.map((modifier) => [modifier, true]))
  const swallowMods = leftOnly
    ? { ...mods, leftOption: true, rightOption: false }
    : mods
  const down = (event: KeyEvent) =>
    event.keyDown &&
    (!event.isRepeat ||
      (binding.kind === 'physical' && binding.key === 'fn')) &&
    keycodes.includes(event.keycode) &&
    modifiers.every((modifier) => event[modifier]) &&
    (!leftOnly || (event.leftOption === true && event.rightOption !== true))
  return {
    swallowRules: [
      ...keycodes.map((keycode) => rule(keycode, swallowMods)),
      ...(binding.kind === 'trigger'
        ? (binding.swallowPrefix ?? [])
        : []
      ).flatMap((modifier) =>
        MODIFIER_KEYCODES[modifier].map((keycode) => rule(keycode, swallowMods))
      ),
    ],
    matchesToggleDown: down,
    matchesHoldDown: down,
    matchesHoldUp: (event) => {
      if (binding.kind === 'physical')
        return keycodes.includes(event.keycode) && !event.keyDown
      if (binding.kind === 'modifiers')
        return modifiers.some((modifier) => !event[modifier])
      if (
        options.platform === 'windows' &&
        preset.windowsHoldEndsOnModifierRelease
      ) {
        return (
          isWindowsModifierReleaseEvent(id, event, leftOnly) &&
          (leftOnly
            ? event.keycode === Key.option
            : modifiers.some((modifier) => !event[modifier]))
        )
      }
      if (!event.keyDown && keycodes.includes(event.keycode)) return true
      if (modifiers.length > 1)
        return modifiers.some((modifier) => !event[modifier])
      return modifiers.some((modifier) =>
        leftOnly && modifier === 'option'
          ? event.keycode === Key.option && !event.keyDown
          : MODIFIER_KEYCODES[modifier].includes(event.keycode) &&
            !event[modifier]
      )
    },
  }
}

export function isWindowsModifierReleaseEvent(
  id: ShortcutId,
  event: KeyEvent,
  leftOnly = false
): boolean {
  const preset = SHORTCUT_PRESETS[id]
  if (!preset.windowsHoldEndsOnModifierRelease) return true
  const binding: ShortcutBinding = preset.binding
  return (
    binding.kind === 'trigger' &&
    !event.keyDown &&
    binding.modifiers.some((modifier) =>
      leftOnly && modifier === 'option'
        ? event.keycode === Key.option
        : MODIFIER_KEYCODES[modifier].includes(event.keycode)
    )
  )
}

export function isWindowsComboTriggerReleaseEvent(
  id: ShortcutId,
  event: KeyEvent
): boolean {
  const preset = SHORTCUT_PRESETS[id]
  const binding: ShortcutBinding = preset.binding
  return (
    preset.windowsHoldEndsOnModifierRelease &&
    binding.kind === 'trigger' &&
    !event.keyDown &&
    event.keycode === Key[binding.key]
  )
}
