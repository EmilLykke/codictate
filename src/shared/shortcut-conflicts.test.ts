import { describe, expect, test } from 'bun:test'
import {
  findShortcutConflicts,
  healShortcutConflicts,
} from './shortcut-conflicts'

describe('findShortcutConflicts', () => {
  test('a free desktop conflicts with nothing', () => {
    expect(findShortcutConflicts([])).toEqual({})
  })

  test('a desktop binding on Alt+Space takes the option-space Preset', () => {
    const conflicts = findShortcutConflicts([
      { modmask: 8, key: 'SPACE', description: 'Launcher' },
    ])
    expect(Object.keys(conflicts)).toEqual(['option-space'])
    expect(conflicts['option-space']).toBe(
      'Hyprland already uses Alt + Space for “Launcher”.'
    )
  })

  test('Enter presets match Hyprland RETURN, case-insensitively', () => {
    const conflicts = findShortcutConflicts([
      { modmask: 4, key: 'return', description: '' },
    ])
    expect(conflicts['control-enter']).toBe(
      'Hyprland already uses Ctrl + Enter.'
    )
  })

  test('a different modifier set is a different chord', () => {
    // Omarchy binds Super+Space and Super+Ctrl+Space; neither is Ctrl+Space.
    const conflicts = findShortcutConflicts([
      { modmask: 64, key: 'SPACE', description: 'Omarchy menu' },
      { modmask: 68, key: 'SPACE', description: 'Background switcher' },
    ])
    expect(conflicts['control-space']).toBeUndefined()
    expect(conflicts['control-meta-space']).toBe(
      'Hyprland already uses Ctrl + Super + Space for “Background switcher”.'
    )
  })

  test('Num Lock and Caps Lock bits do not change the chord', () => {
    const conflicts = findShortcutConflicts([
      { modmask: 8 | 16, key: 'SPACE', description: '' },
    ])
    expect(conflicts['option-space']).toBeDefined()
  })

  test('modifier-only Presets never conflict through a Trigger Key', () => {
    const conflicts = findShortcutConflicts([
      { modmask: 12, key: 'DELETE', description: 'Close all windows' },
    ])
    expect(conflicts['control-option']).toBeUndefined()
  })
})

describe('healShortcutConflicts', () => {
  const takenAltSpace = findShortcutConflicts([
    { modmask: 8, key: 'SPACE', description: 'Launcher' },
  ])

  test('a free shortcut is left alone', () => {
    const result = healShortcutConflicts(
      { shortcutId: 'control-space', shortcutHoldOnlyId: null },
      takenAltSpace,
      'linux'
    )
    expect(result.unchanged).toBe(true)
    expect(result.announcements).toEqual([])
  })

  test('a conflicting Dictation Shortcut moves to the first free Linux Preset, out loud', () => {
    const result = healShortcutConflicts(
      { shortcutId: 'option-space', shortcutHoldOnlyId: null },
      takenAltSpace,
      'linux'
    )
    expect(result.selection.shortcutId).toBe('option-enter')
    expect(result.announcements).toHaveLength(1)
    expect(result.announcements[0]?.message).toContain('Alt + Enter')
    expect(result.announcements[0]?.message).toContain('“Launcher”')
  })

  test('the moved shortcut never lands on the second shortcut', () => {
    const result = healShortcutConflicts(
      { shortcutId: 'option-space', shortcutHoldOnlyId: 'option-enter' },
      takenAltSpace,
      'linux'
    )
    expect(result.selection).toEqual({
      shortcutId: 'control-space',
      shortcutHoldOnlyId: 'option-enter',
    })
  })

  test('a conflicting second shortcut is turned off', () => {
    const result = healShortcutConflicts(
      { shortcutId: 'control-space', shortcutHoldOnlyId: 'option-space' },
      takenAltSpace,
      'linux'
    )
    expect(result.selection.shortcutHoldOnlyId).toBeNull()
    expect(result.announcements[0]?.target).toBe('hold_only_shortcut')
  })
})
