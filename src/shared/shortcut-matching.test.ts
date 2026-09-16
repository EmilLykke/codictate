import { describe, expect, test } from 'bun:test'
import type { ShortcutId } from './types'
import {
  getShortcutDefinition,
  isWindowsComboTriggerReleaseEvent,
  isWindowsModifierReleaseEvent,
  serializeSwallowRule,
  type KeyEvent,
} from './shortcut-matching'

const event = (keycode: number, fields: Partial<KeyEvent> = {}): KeyEvent => ({
  keycode,
  option: false,
  command: false,
  control: false,
  shift: false,
  fn: false,
  keyDown: true,
  isRepeat: false,
  ...fields,
})

const presses: [ShortcutId, KeyEvent][] = [
  ['option-space', event(49, { option: true })],
  ['right-option', event(61, { option: true })],
  ['option-enter', event(36, { option: true })],
  ['fn-space', event(49, { fn: true })],
  ['fn-f1', event(122, { fn: true })],
  ['fn-f2', event(120, { fn: true })],
  ['fn-globe', event(63, { fn: true })],
  ['control-space', event(49, { control: true })],
  ['control-enter', event(36, { control: true })],
  ['control-option', event(58, { control: true, option: true })],
  ['control-meta', event(55, { control: true, command: true })],
  ['control-meta-space', event(49, { control: true, command: true })],
]

describe('Preset matching and native swallow contract', () => {
  for (const [id, press] of presses) {
    test(`${id}: matches press, rejects unrelated input, supplies matching native rule`, () => {
      const definition = getShortcutDefinition(id, { platform: 'macos' })
      expect(definition.matchesToggleDown(press)).toBe(true)
      expect(definition.matchesHoldDown(press)).toBe(true)
      expect(definition.matchesToggleDown({ ...press, keyDown: false })).toBe(
        false
      )
      expect(definition.matchesToggleDown(event(53))).toBe(false)
      expect(definition.swallowRules.map(serializeSwallowRule)).toContainEqual(
        serializeSwallowRule(press)
      )
    })
  }

  for (const [id, keycode, mods, modifierKeys] of [
    ['option-space', 49, { option: true }, [58, 61]],
    ['option-enter', 36, { option: true }, [58, 61]],
    ['control-space', 49, { control: true }, [59, 62]],
    ['control-enter', 36, { control: true }, [59, 62]],
    [
      'control-meta-space',
      49,
      { control: true, command: true },
      [59, 62, 55, 54],
    ],
  ] as [ShortcutId, number, Partial<KeyEvent>, number[]][]) {
    test(`${id}: macOS trigger release stops; Windows holds until modifier release`, () => {
      const mac = getShortcutDefinition(id, { platform: 'macos' })
      const win = getShortcutDefinition(id, { platform: 'windows' })
      const triggerUp = event(keycode, { ...mods, keyDown: false })
      expect(mac.matchesHoldUp(triggerUp)).toBe(true)
      expect(win.matchesHoldUp(triggerUp)).toBe(false)
      expect(isWindowsComboTriggerReleaseEvent(id, triggerUp)).toBe(true)
      for (const modifier of modifierKeys) {
        const up = event(modifier, { keyDown: false })
        expect(win.matchesHoldUp(up)).toBe(true)
        expect(isWindowsModifierReleaseEvent(id, up)).toBe(true)
      }
      expect(win.matchesHoldUp(event(53, { keyDown: false }))).toBe(false)
      expect(
        isWindowsComboTriggerReleaseEvent(
          id,
          event(keycode === 49 ? 36 : 49, { keyDown: false })
        )
      ).toBe(false)
    })
  }

  test('left Option chord and physical Right Option can coexist', () => {
    for (const platform of ['macos', 'windows'] as const) {
      const main = getShortcutDefinition('option-space', {
        platform,
        requireLeftOption: true,
      })
      expect(
        main.matchesHoldDown(
          event(49, { option: true, leftOption: true, rightOption: false })
        )
      ).toBe(true)
      expect(
        main.matchesHoldDown(
          event(49, { option: true, leftOption: false, rightOption: true })
        )
      ).toBe(false)
      expect(
        main.matchesHoldUp(
          event(61, { keyDown: false, option: true, leftOption: true })
        )
      ).toBe(false)
      expect(main.matchesHoldUp(event(58, { keyDown: false }))).toBe(true)
      expect(serializeSwallowRule(main.swallowRules[0])).toMatchObject({
        leftOption: true,
        rightOption: false,
      })
      const right = getShortcutDefinition('right-option', { platform })
      expect(
        right.matchesHoldUp(
          event(61, { keyDown: false, option: true, leftOption: true })
        )
      ).toBe(true)
    }
  })

  test('Fn handles both hardware codes; Fn chords release on either', () => {
    for (const keycode of [63, 179]) {
      const globe = getShortcutDefinition('fn-globe', { platform: 'macos' })
      expect(globe.matchesHoldDown(event(keycode, { fn: true }))).toBe(true)
      expect(globe.matchesHoldUp(event(keycode, { keyDown: false }))).toBe(true)
      for (const id of ['fn-space', 'fn-f1', 'fn-f2'] as const) {
        expect(
          getShortcutDefinition(id, { platform: 'macos' }).matchesHoldUp(
            event(keycode, { keyDown: false })
          )
        ).toBe(true)
      }
    }
  })

  test('modifier pairs work in either order and Ctrl+Win+Space swallows Win prefix', () => {
    for (const [id, codes, mods] of [
      ['control-option', [59, 62, 58, 61], { control: true, option: true }],
      ['control-meta', [59, 62, 55, 54], { control: true, command: true }],
    ] as [ShortcutId, number[], Partial<KeyEvent>][]) {
      const definition = getShortcutDefinition(id, { platform: 'windows' })
      for (const code of codes)
        expect(definition.matchesHoldDown(event(code, mods))).toBe(true)
      expect(definition.matchesHoldUp(event(59, { keyDown: false }))).toBe(true)
    }
    const combo = getShortcutDefinition('control-meta-space', {
      platform: 'windows',
    })
    expect(combo.swallowRules.map((rule) => rule.keycode)).toEqual([49, 55, 54])
    expect(
      combo.matchesHoldDown(event(55, { control: true, command: true }))
    ).toBe(false)
  })
})
