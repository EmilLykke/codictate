import type { ShortcutId } from '../../../shared/types'
import type { WindowsHelperCommand } from '../../../shared/windows-helper-protocol'
import {
  bindNativePasteboardWriter,
  unbindNativePasteboardWriter,
} from '../clipboard/native-pasteboard-bridge'
import { log } from '../logger'
import { observerFinish, observerStartWatch } from './observer-helper'
import { findKeyboardHelperBinary } from './find-keyboard-helper'
import { getPlatformRuntime } from '../../platform/runtime'

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

function optionComboToggleDown(trigger: number, requireLeftOption = false) {
  return (e: KeyEvent) =>
    e.keyDown &&
    e.keycode === trigger &&
    e.option &&
    !e.isRepeat &&
    (!requireLeftOption || (e.leftOption === true && e.rightOption !== true))
}

function optionComboHoldDown(trigger: number, requireLeftOption = false) {
  return optionComboToggleDown(trigger, requireLeftOption)
}

function optionComboHoldUp(trigger: number, requireLeftOption = false) {
  const modifierReleaseOnly = getPlatformRuntime() === 'windows'
  return (e: KeyEvent) =>
    (!modifierReleaseOnly && !e.keyDown && e.keycode === trigger) ||
    (requireLeftOption
      ? e.keycode === Key.option && !e.keyDown
      : (e.keycode === Key.option || e.keycode === Key.rightOption) &&
        !e.option)
}

function fnComboToggleDown(trigger: number) {
  return (e: KeyEvent) =>
    e.keyDown && e.keycode === trigger && e.fn && !e.isRepeat
}

function fnComboHoldDown(trigger: number) {
  return fnComboToggleDown(trigger)
}

function fnComboHoldUp(trigger: number) {
  return (e: KeyEvent) =>
    (!e.keyDown && e.keycode === trigger) ||
    (FN_PHYSICAL_KEYCODES.includes(
      e.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
    ) &&
      !e.fn)
}

function controlComboToggleDown(trigger: number) {
  return (e: KeyEvent) =>
    e.keyDown && e.keycode === trigger && e.control && !e.isRepeat
}

function controlComboHoldDown(trigger: number) {
  return controlComboToggleDown(trigger)
}

function controlComboHoldUp(trigger: number) {
  const modifierReleaseOnly = getPlatformRuntime() === 'windows'
  return (e: KeyEvent) =>
    (!modifierReleaseOnly && !e.keyDown && e.keycode === trigger) ||
    ((e.keycode === Key.control || e.keycode === Key.rightControl) &&
      !e.control)
}

export interface ShortcutDefinition {
  displayKeys: string[]
  /** One or more swallow rules (e.g. Fn uses two hardware keycodes). */
  swallowRules: KeyEvent[]
  matchesToggleDown: (e: KeyEvent) => boolean
  matchesHoldDown: (e: KeyEvent) => boolean
  matchesHoldUp: (e: KeyEvent) => boolean
}

export type ShortcutDefinitionOptions = {
  requireLeftOption?: boolean
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  'option-space': {
    displayKeys: ['⌥', 'Space'],
    swallowRules: [rule(Key.space, { option: true })],
    matchesToggleDown: optionComboToggleDown(Key.space),
    matchesHoldDown: optionComboHoldDown(Key.space),
    matchesHoldUp: optionComboHoldUp(Key.space),
  },
  'right-option': {
    displayKeys: ['Right ⌥'],
    swallowRules: [rule(Key.rightOption, { option: true })],
    matchesToggleDown: (e) =>
      e.keyDown && e.keycode === Key.rightOption && e.option && !e.isRepeat,
    matchesHoldDown: (e) =>
      e.keyDown && e.keycode === Key.rightOption && e.option && !e.isRepeat,
    // Physical key up from KeyListener (`keyState`); do not require `!e.option` — Left ⌥ may stay down.
    matchesHoldUp: (e) => e.keycode === Key.rightOption && !e.keyDown,
  },
  'option-enter': {
    displayKeys: ['⌥', 'Enter'],
    swallowRules: [rule(Key.enter, { option: true })],
    matchesToggleDown: optionComboToggleDown(Key.enter),
    matchesHoldDown: optionComboHoldDown(Key.enter),
    matchesHoldUp: optionComboHoldUp(Key.enter),
  },
  'fn-space': {
    displayKeys: ['Fn', 'Space'],
    swallowRules: [rule(Key.space, { fn: true })],
    matchesToggleDown: fnComboToggleDown(Key.space),
    matchesHoldDown: fnComboHoldDown(Key.space),
    matchesHoldUp: fnComboHoldUp(Key.space),
  },
  'fn-f1': {
    displayKeys: ['Fn', 'F1'],
    swallowRules: [rule(Key.f1, { fn: true })],
    matchesToggleDown: fnComboToggleDown(Key.f1),
    matchesHoldDown: fnComboHoldDown(Key.f1),
    matchesHoldUp: fnComboHoldUp(Key.f1),
  },
  'fn-f2': {
    displayKeys: ['Fn', 'F2'],
    swallowRules: [rule(Key.f2, { fn: true })],
    matchesToggleDown: fnComboToggleDown(Key.f2),
    matchesHoldDown: fnComboHoldDown(Key.f2),
    matchesHoldUp: fnComboHoldUp(Key.f2),
  },
  'fn-globe': {
    displayKeys: ['Fn'],
    swallowRules: [rule(Key.fn, { fn: true }), rule(Key.globeFn, { fn: true })],
    matchesToggleDown: (e) =>
      FN_PHYSICAL_KEYCODES.includes(
        e.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
      ) &&
      e.fn &&
      e.keyDown,
    matchesHoldDown: (e) =>
      FN_PHYSICAL_KEYCODES.includes(
        e.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
      ) &&
      e.fn &&
      e.keyDown,
    matchesHoldUp: (e) =>
      FN_PHYSICAL_KEYCODES.includes(
        e.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
      ) && !e.keyDown,
  },
  'control-space': {
    displayKeys: ['⌃', 'Space'],
    swallowRules: [rule(Key.space, { control: true })],
    matchesToggleDown: controlComboToggleDown(Key.space),
    matchesHoldDown: controlComboHoldDown(Key.space),
    matchesHoldUp: controlComboHoldUp(Key.space),
  },
  'control-enter': {
    displayKeys: ['⌃', 'Enter'],
    swallowRules: [rule(Key.enter, { control: true })],
    matchesToggleDown: controlComboToggleDown(Key.enter),
    matchesHoldDown: controlComboHoldDown(Key.enter),
    matchesHoldUp: controlComboHoldUp(Key.enter),
  },
}

function buildOptionShortcutDefinition(
  displayKeys: string[],
  trigger: number,
  requireLeftOption = false
): ShortcutDefinition {
  return {
    displayKeys,
    swallowRules: [
      requireLeftOption
        ? rule(trigger, {
            option: true,
            leftOption: true,
            rightOption: false,
          })
        : rule(trigger, { option: true }),
    ],
    matchesToggleDown: optionComboToggleDown(trigger, requireLeftOption),
    matchesHoldDown: optionComboHoldDown(trigger, requireLeftOption),
    matchesHoldUp: optionComboHoldUp(trigger, requireLeftOption),
  }
}

export function getShortcutDefinition(
  id: ShortcutId,
  options?: ShortcutDefinitionOptions
): ShortcutDefinition {
  const requireLeftOption = options?.requireLeftOption === true
  if (!requireLeftOption) return SHORTCUTS[id]

  switch (id) {
    case 'option-space':
      return buildOptionShortcutDefinition(['⌥', 'Space'], Key.space, true)
    case 'option-enter':
      return buildOptionShortcutDefinition(['⌥', 'Enter'], Key.enter, true)
    default:
      return SHORTCUTS[id]
  }
}

export interface PermissionStatus {
  inputMonitoring: boolean
  microphone: boolean
  accessibility: boolean
}

/** NSPasteboard + Cmd+V — Unicode-safe in bundled apps (no pbcopy / shell locale). */
let keyListenerPasteText: ((text: string) => void) | null = null
let keyListenerReplaceText:
  | ((payload: { deleteText: string; text: string }) => void)
  | null = null

export function startKeyboardListener(
  onKeyEvent: (event: KeyEvent) => void,
  swallowRules: KeyEvent[] = [],
  onPermissions?: (status: PermissionStatus) => void
) {
  let procAlive = true
  let proc: ReturnType<typeof Bun.spawn> | null = null

  const pendingStart = findKeyboardHelperBinary().then((helper) => {
    const args =
      helper.kind === 'windows' ? [helper.path, 'keyboard-hook'] : [helper.path]
    const startedProc = Bun.spawn(args, { stdout: 'pipe', stdin: 'pipe' })
    proc = startedProc

    if (helper.kind === 'windows') {
      const payload: WindowsHelperCommand = {
        command: 'configure',
        swallow: swallowRules.map(serializeSwallowRule),
      }
      startedProc.stdin.write(JSON.stringify(payload) + '\n')
    } else {
      startedProc.stdin.write(
        JSON.stringify({ swallow: swallowRules.map(serializeSwallowRule) }) +
          '\n'
      )
    }
    startedProc.stdin.flush()

    startedProc.exited.then((code) => {
      procAlive = false
      if (code !== 0 && code !== 143 && code !== 137) {
        console.error(
          helper.kind === 'windows'
            ? `[CodictateWindowsHelper] exited with code ${code}.\n` +
                `If shortcuts are not working, rebuild the Windows helper and verify it can start.`
            : `[KeyListener] exited with code ${code}.\n` +
                `If shortcuts are not working, grant Input Monitoring permission:\n` +
                `System Settings > Privacy & Security > Input Monitoring → add this app, then restart.`
        )
        onPermissions?.({
          inputMonitoring: false,
          microphone: false,
          accessibility: false,
        })
      }
    })

    return { helper, proc: startedProc }
  })

  const withProc = (
    fn: (activeProc: ReturnType<typeof Bun.spawn>) => void
  ) => {
    void pendingStart.then(({ proc: activeProc }) => fn(activeProc)).catch((err) => {
      procAlive = false
      console.error(`[keyboard] ${String(err)}`)
    })
  }

  const sendCommand = (command: Record<string, unknown> | WindowsHelperCommand) => {
    withProc((activeProc) => {
      const stdin = activeProc.stdin
      if (!stdin || typeof stdin === 'number') return
      stdin.write(JSON.stringify(command) + '\n')
      stdin.flush()
    })
  }

  const pasteText = (text: string) => sendCommand({ command: 'paste_text', text })

  const replaceText = (deleteText: string, text: string) =>
    sendCommand({ command: 'replace_text', deleteText, text })

  const setClipboardOnly = (text: string) =>
    sendCommand({ command: 'set_clipboard', text })

  const checkPermissions = () => sendCommand({ command: 'check_permissions' })

  const requestInputMonitoringPrompt = () =>
    sendCommand({ command: 'request_input_monitoring' })

  const promptAccessibility = () =>
    sendCommand({ command: 'prompt_accessibility' })

  const requestMicrophone = () => sendCommand({ command: 'request_microphone' })

  keyListenerPasteText = pasteText
  keyListenerReplaceText = ({ deleteText, text }) =>
    replaceText(deleteText, text)
  bindNativePasteboardWriter(setClipboardOnly)

  void pendingStart.then(({ proc: activeProc }) => {
    const reader = activeProc.stdout.getReader()
    const decoder = new TextDecoder()

    let lastPermissions: PermissionStatus = {
      inputMonitoring: false,
      microphone: false,
      accessibility: false,
    }

    ;(async () => {
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>

            if (typeof parsed.keycode === 'number') {
              const ev = normalizeKeyEvent(parsed)
              if (ev) onKeyEvent(ev)
            } else if (parsed.status === 'started') {
              lastPermissions = {
                inputMonitoring: parsed.inputMonitoring === true,
                microphone: parsed.microphone === true,
                accessibility: parsed.accessibility === true,
              }
              onPermissions?.(lastPermissions)
            } else if (parsed.type === 'permissions') {
              lastPermissions = {
                inputMonitoring:
                  lastPermissions.inputMonitoring ||
                  parsed.inputMonitoring === true,
                microphone: parsed.microphone === true,
                accessibility: parsed.accessibility === true,
              }
              onPermissions?.(lastPermissions)
            } else if (parsed.type === 'paste_result') {
              log('paste', 'native paste result from keyboard helper', {
                success: parsed.success,
                accessibility: parsed.accessibility,
                message:
                  typeof parsed.message === 'string' ? parsed.message : undefined,
              })
            } else if (parsed.type === 'clipboard_set') {
              log('clipboard', 'native clipboard set')
            } else if (parsed.type === 'tap_attached') {
              console.log(
                '[KeyListener] Event tap attached — input monitoring confirmed'
              )
              lastPermissions = { ...lastPermissions, inputMonitoring: true }
              onPermissions?.(lastPermissions)
            } else if (parsed.type === 'tap_create_failed') {
              console.error(
                `[KeyListener] ${String(parsed.message ?? 'tap_create_failed')}`
              )
            } else if (
              parsed.status === 'permission_requested' ||
              parsed.status === 'error'
            ) {
              console.error(
                `[KeyListener] ${String(parsed.message ?? parsed.status)}`
              )
            }
          } catch {
            // Ignore malformed output lines from the native binary
          }
        }
      }
    })()
  })

  return {
    get isAlive() {
      return procAlive
    },
    stop: () => {
      keyListenerPasteText = null
      keyListenerReplaceText = null
      unbindNativePasteboardWriter()
      proc?.kill()
    },
    checkPermissions,
    requestInputMonitoringPrompt,
    promptAccessibility,
    requestMicrophone,
  }
}

export const pasteTranscript = async (text: string) => {
  if (!keyListenerPasteText) {
    console.error(
      '[pasteTranscript] KeyListener not running; cannot paste transcript.'
    )
    return
  }
  log('paste', 'paste_text via KeyListener (NSPasteboard)', {
    charCount: text.length,
  })
  keyListenerPasteText(text)
  // Start AX observation after paste so corrections are auto-learned.
  // Small delay lets the paste land before we snapshot the field.
  setTimeout(() => observerStartWatch(text), 150)
}

export const replaceTranscript = async (deleteText: string, text: string) => {
  if (!keyListenerReplaceText) {
    console.error(
      '[replaceTranscript] KeyListener not running; cannot replace transcript.'
    )
    return
  }
  log('paste', 'replace_text via KeyListener', {
    deleteChars: [...deleteText].length,
    insertChars: [...text].length,
  })
  keyListenerReplaceText({ deleteText, text })
}

export const finishObservedCorrection = () => {
  observerFinish()
}
