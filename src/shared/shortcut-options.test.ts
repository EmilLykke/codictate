import { describe, expect, test } from 'bun:test'
import type { ShortcutId } from './types'
import {
  SHORTCUT_OPTIONS,
  SHORTCUT_PRESETS,
  isSupportedShortcutId,
  shortcutFamily,
  shortcutOptionsGroupedForPlatform,
  shortcutSupportedOnPlatform,
  windowsUsesModifierReleaseHold,
} from './shortcut-options'

const EXPECTED_SHORTCUT_IDS: ShortcutId[] = [
  'option-space',
  'right-option',
  'option-enter',
  'fn-space',
  'fn-f1',
  'fn-f2',
  'fn-globe',
  'control-space',
  'control-enter',
  'control-option',
  'control-meta',
  'control-meta-space',
]

describe('shortcut preset catalog', () => {
  test('has one complete Preset for every ShortcutId', () => {
    expect(Object.keys(SHORTCUT_PRESETS)).toEqual(EXPECTED_SHORTCUT_IDS)
    expect(SHORTCUT_OPTIONS.map((option) => option.id)).toEqual(
      EXPECTED_SHORTCUT_IDS
    )
    expect(new Set(SHORTCUT_OPTIONS.map((option) => option.id)).size).toBe(
      EXPECTED_SHORTCUT_IDS.length
    )

    for (const id of EXPECTED_SHORTCUT_IDS) {
      const preset = SHORTCUT_PRESETS[id]
      expect(preset.id).toBe(id)
      expect(preset.keys.length).toBeGreaterThan(0)
      expect(preset.supportedPlatforms.length).toBeGreaterThan(0)
      expect(shortcutFamily(id)).toBe(preset.family)
    }
  })

  test('offers every Preset on macOS and only supported Presets on Windows', () => {
    const macos = shortcutOptionsGroupedForPlatform('macos').flatMap(
      (group) => group.options
    )
    const windows = shortcutOptionsGroupedForPlatform('windows').flatMap(
      (group) => group.options
    )

    expect(macos.map((option) => option.id)).toEqual(EXPECTED_SHORTCUT_IDS)
    expect(windows.map((option) => option.id)).toEqual(
      EXPECTED_SHORTCUT_IDS.filter((id) =>
        shortcutSupportedOnPlatform(id, 'windows')
      )
    )
    expect(windows.some((option) => option.id.startsWith('fn-'))).toBe(false)
    expect(
      windows.find((option) => option.id === 'control-meta-space')?.keys
    ).toEqual(['Ctrl', 'Win', 'Space'])
  })

  test('derives Windows hold-end behavior from Preset metadata', () => {
    const modifierReleaseIds = EXPECTED_SHORTCUT_IDS.filter(
      windowsUsesModifierReleaseHold
    )
    expect(modifierReleaseIds).toEqual([
      'option-space',
      'option-enter',
      'control-space',
      'control-enter',
      'control-meta-space',
    ])
  })

  test('validates untrusted IDs against the active platform', () => {
    expect(isSupportedShortcutId('control-space', 'windows')).toBe(true)
    expect(isSupportedShortcutId('fn-space', 'windows')).toBe(false)
    expect(isSupportedShortcutId('fn-space', 'macos')).toBe(true)
    expect(isSupportedShortcutId('not-a-shortcut', 'macos')).toBe(false)
    expect(isSupportedShortcutId(null, 'macos')).toBe(false)
  })
})
