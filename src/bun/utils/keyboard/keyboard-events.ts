import {
  normalizeKeyEvent,
  serializeSwallowRule,
  type KeyEvent,
} from '../../../shared/shortcut-matching'
import type { WindowsHelperCommand } from '../../../shared/windows-helper-protocol'
import {
  bindNativePasteboardWriter,
  unbindNativePasteboardWriter,
} from '../clipboard/native-pasteboard-bridge'
import { log } from '../logger'
import { observerFinish, observerStartWatch } from './observer-helper'
import { findKeyboardHelperBinary } from './find-keyboard-helper'

export interface PermissionStatus {
  inputMonitoring: boolean
  microphone: boolean
  accessibility: boolean
}

/** NSPasteboard + Cmd+V — Unicode-safe in bundled apps (no pbcopy / shell locale). */
let keyListenerPasteText: ((text: string) => void) | null = null
let keyListenerReplaceText:
  ((payload: { deleteText: string; text: string }) => void) | null = null

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

  const withProc = (fn: (activeProc: ReturnType<typeof Bun.spawn>) => void) => {
    void pendingStart
      .then(({ proc: activeProc }) => fn(activeProc))
      .catch((err) => {
        procAlive = false
        console.error(`[keyboard] ${String(err)}`)
      })
  }

  const sendCommand = (
    command: Record<string, unknown> | WindowsHelperCommand
  ) => {
    withProc((activeProc) => {
      const stdin = activeProc.stdin
      if (!stdin || typeof stdin === 'number') return
      stdin.write(JSON.stringify(command) + '\n')
      stdin.flush()
    })
  }

  const pasteText = (text: string) =>
    sendCommand({ command: 'paste_text', text })

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
                  typeof parsed.message === 'string'
                    ? parsed.message
                    : undefined,
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
