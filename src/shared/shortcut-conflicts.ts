import type { PlatformRuntime } from './platform'
import {
  SHORTCUT_OPTIONS,
  SHORTCUT_PRESETS,
  shortcutOptionById,
  type ShortcutModifier,
} from './shortcut-options'
import type { ShortcutId } from './types'

/**
 * One key binding the desktop itself owns, as the Linux Native Helper reports it from
 * Hyprland. `modmask` uses Hyprland's bits (SHIFT 1, CTRL 4, ALT 8, SUPER 64); `key` is the
 * key name Hyprland stores, compared case-insensitively.
 */
export interface DesktopBinding {
  modmask: number
  key: string
  description: string
}

/** A Preset the desktop already binds, with the sentence that explains why it is not offered. */
export type ShortcutConflicts = Partial<Record<ShortcutId, string>>

const MODIFIER_BITS: Record<ShortcutModifier, number> = {
  shift: 1,
  control: 4,
  option: 8,
  command: 64,
  fn: 0,
}

/** Lock-style bits (Caps Lock, Num Lock) never make a binding a different chord. */
const LOCK_BITS = 2 | 16

const TRIGGER_KEY_NAMES: Record<string, readonly string[]> = {
  space: ['space'],
  enter: ['return', 'enter'],
  f1: ['f1'],
  f2: ['f2'],
}

/** The chord a Preset occupies on the desktop, or null when it has no Trigger Key. */
function presetChord(
  id: ShortcutId
): { modmask: number; keys: readonly string[] } | null {
  const binding = SHORTCUT_PRESETS[id].binding
  if (binding.kind !== 'trigger') return null
  const modmask = binding.modifiers.reduce(
    (mask, modifier) => mask | MODIFIER_BITS[modifier],
    0
  )
  return { modmask, keys: TRIGGER_KEY_NAMES[binding.key] ?? [binding.key] }
}

/**
 * Every Preset whose chord the desktop already binds. A conflicting Preset is not offered,
 * and a saved Dictation Shortcut that becomes conflicting is healed to a free one: see
 * Shortcut Conflict in CONTEXT.md.
 */
export function findShortcutConflicts(
  bindings: readonly DesktopBinding[]
): ShortcutConflicts {
  const conflicts: ShortcutConflicts = {}
  for (const id of Object.keys(SHORTCUT_PRESETS) as ShortcutId[]) {
    const chord = presetChord(id)
    if (chord === null) continue
    const taken = bindings.find(
      (binding) =>
        (binding.modmask & ~LOCK_BITS) === chord.modmask &&
        chord.keys.includes(binding.key.trim().toLowerCase())
    )
    if (taken === undefined) continue
    const label = shortcutOptionById(id, 'linux').label
    const purpose = taken.description.trim()
    conflicts[id] = purpose
      ? `Hyprland already uses ${label} for “${purpose}”.`
      : `Hyprland already uses ${label}.`
  }
  return conflicts
}

/**
 * A Dictation Shortcut moved off a combination the desktop took over. Said out loud through
 * the same banner as the dictation heal pass, but healed here rather than there: it is a
 * fact about the desktop, not about Speech Model availability.
 */
export interface ShortcutHealAnnouncement {
  target: 'dictation_shortcut' | 'hold_only_shortcut'
  reason: 'shortcut_conflict'
  /** One finished sentence, shown to the user as written. */
  message: string
}

export interface ShortcutSelection {
  shortcutId: ShortcutId
  shortcutHoldOnlyId: ShortcutId | null
}

export interface ShortcutHealResult {
  selection: ShortcutSelection
  announcements: ShortcutHealAnnouncement[]
  unchanged: boolean
}

/**
 * Move a saved Dictation Shortcut off a combination the desktop now owns. The primary
 * shortcut moves to the first free Preset this platform offers; the optional second one is
 * cleared, because it is optional. Both are said out loud: the user chose them.
 */
export function healShortcutConflicts(
  selection: ShortcutSelection,
  conflicts: ShortcutConflicts,
  platform: PlatformRuntime
): ShortcutHealResult {
  let { shortcutId, shortcutHoldOnlyId } = selection
  const announcements: ShortcutHealAnnouncement[] = []

  const primaryConflict = conflicts[shortcutId]
  if (primaryConflict !== undefined) {
    const free = SHORTCUT_OPTIONS.find(
      (option) =>
        option.supportedPlatforms.includes(platform) &&
        conflicts[option.id] === undefined &&
        option.id !== shortcutHoldOnlyId
    )
    if (free !== undefined) {
      const previous = shortcutOptionById(shortcutId, platform).label
      shortcutId = free.id
      announcements.push({
        target: 'dictation_shortcut',
        reason: 'shortcut_conflict',
        message: `Dictation Shortcut switched to ${shortcutOptionById(free.id, platform).label}. ${primaryConflict} Free ${previous} in Hyprland to use it again.`,
      })
    }
  }

  if (shortcutHoldOnlyId !== null) {
    const holdConflict = conflicts[shortcutHoldOnlyId]
    if (holdConflict !== undefined || shortcutHoldOnlyId === shortcutId) {
      announcements.push({
        target: 'hold_only_shortcut',
        reason: 'shortcut_conflict',
        message: `Second shortcut turned off. ${holdConflict ?? 'It is now the Dictation Shortcut.'}`,
      })
      shortcutHoldOnlyId = null
    }
  }

  return {
    selection: { shortcutId, shortcutHoldOnlyId },
    announcements,
    unchanged:
      shortcutId === selection.shortcutId &&
      shortcutHoldOnlyId === selection.shortcutHoldOnlyId,
  }
}
