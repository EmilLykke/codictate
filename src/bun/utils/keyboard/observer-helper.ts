import { findBinary } from '../../platform/binaries'
import { log } from '../logger'
import { extractCorrections } from '../dictionary/apply-dictionary'
import type { DictionaryEntry } from '../../../shared/types'

interface ObserverCommand {
  command: 'observe' | 'finish' | 'cancel' | 'quit'
  targetText?: string
}

let observerSend: ((cmd: ObserverCommand) => void) | null = null

function countTokens(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

function sliceEndByTokenCount(
  text: string,
  start: number,
  tokenCount: number
): number {
  if (tokenCount <= 0) return start

  let idx = start
  let seenTokens = 0
  let inToken = false

  while (idx < text.length) {
    const char = text[idx]
    const isWhitespace = /\s/.test(char)

    if (!isWhitespace && !inToken) {
      inToken = true
      seenTokens++
    } else if (isWhitespace && inToken) {
      inToken = false
      if (seenTokens >= tokenCount) {
        return idx
      }
    }

    idx++
  }

  return idx
}

function scopeObservedChange(
  originalText: string,
  currentText: string,
  targetText: string | null
): {
  originalText: string
  currentText: string
  scoped: boolean
} {
  if (!targetText || targetText.length === 0) {
    return { originalText, currentText, scoped: false }
  }

  const start = originalText.lastIndexOf(targetText)
  if (start === -1) {
    return { originalText, currentText, scoped: false }
  }

  const scopedStart = start
  const scopedEndBefore = start + targetText.length
  const suffix = originalText.slice(scopedEndBefore)
  let scopedEndAfter = scopedEndBefore

  if (suffix.length > 0) {
    const suffixIndex = currentText.indexOf(suffix, scopedStart)
    if (suffixIndex !== -1) {
      scopedEndAfter = suffixIndex
    }
  }

  if (scopedEndAfter === scopedEndBefore) {
    const targetTokenCount = countTokens(targetText)
    scopedEndAfter = sliceEndByTokenCount(
      currentText,
      scopedStart,
      targetTokenCount
    )
  }

  return {
    originalText: originalText.slice(scopedStart, scopedEndBefore),
    currentText: currentText.slice(scopedStart, scopedEndAfter),
    scoped: true,
  }
}

export function startObserverHelper(
  onCorrection: (candidate: { original: string; corrected: string }) => void,
  onObservationSettled: (result: {
    originalText: string
    currentText: string
    candidatesFound: number
  }) => void,
  isAutoLearnEnabled: () => boolean,
  _getDictionaryEntries: () => DictionaryEntry[]
) {
  const binaryPath = findBinary('observer')
  if (!binaryPath) {
    log(
      'observer',
      'CodictateObserverHelper not available on this platform — auto-learn disabled'
    )
    return
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([binaryPath], { stdout: 'pipe', stdin: 'pipe' })
  } catch {
    log(
      'observer',
      'CodictateObserverHelper failed to spawn — auto-learn disabled'
    )
    return
  }

  log('observer', 'CodictateObserverHelper spawned', { binaryPath })

  const stdin = proc.stdin
  const stdout = proc.stdout
  if (
    !stdin ||
    typeof stdin === 'number' ||
    !stdout ||
    typeof stdout === 'number'
  ) {
    log(
      'observer',
      'CodictateObserverHelper pipe setup failed — auto-learn disabled'
    )
    proc.kill()
    return
  }

  const send = (cmd: ObserverCommand) => {
    try {
      stdin.write(JSON.stringify(cmd) + '\n')
      stdin.flush()
    } catch {
      // process may have exited
    }
  }

  observerSend = (command) => {
    log('observer', 'sending command to helper', {
      command: command.command,
      targetTextChars: command.targetText?.length,
    })
    send(command)
  }

  proc.exited.then((code) => {
    log('observer', 'CodictateObserverHelper exited', { code })
    observerSend = null
  })

  const reader = stdout.getReader()
  const decoder = new TextDecoder()

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
          const msg = JSON.parse(line) as Record<string, unknown>
          if (msg.type === 'correction' || msg.type === 'observationFinished') {
            log('observer', 'received observation event', {
              eventType: String(msg.type),
              originalText: String(msg.originalText ?? ''),
              currentText: String(msg.currentText ?? ''),
              autoLearnEnabled: isAutoLearnEnabled(),
            })
            if (!isAutoLearnEnabled()) continue
            const observedBefore = String(msg.originalText ?? '')
            const observedAfter = String(msg.currentText ?? '')
            const targetText =
              typeof msg.targetText === 'string' ? msg.targetText : null
            const scopedChange = scopeObservedChange(
              observedBefore,
              observedAfter,
              targetText
            )
            const originalText = scopedChange.originalText
            const currentText = scopedChange.currentText
            const candidates =
              msg.type === 'correction'
                ? extractCorrections(originalText, currentText)
                : []
            log('observer', 'extractCorrections result', {
              scopedToPastedText: scopedChange.scoped,
              comparedOriginalText: originalText,
              comparedCurrentText: currentText,
              candidateCount: candidates.length,
              candidates: candidates.map(
                (c) => `${c.original} → ${c.corrected}`
              ),
            })
            onObservationSettled({
              originalText,
              currentText,
              candidatesFound: candidates.length,
            })
            for (const candidate of candidates) {
              log('observer', 'observed correction candidate', {
                original: candidate.original,
                corrected: candidate.corrected,
              })
              onCorrection(candidate)
            }
          } else if (msg.type === 'ready') {
            log('observer', 'CodictateObserverHelper ready')
          } else if (msg.type === 'unsupported') {
            log('observer', 'app does not expose AX text — auto-learn skipped')
          }
        } catch {
          // ignore malformed output
        }
      }
    }
  })()
}

export function observerStartWatch(targetText?: string) {
  if (!observerSend) {
    log('observer', 'observerStartWatch called but helper is not running')
    return
  }
  observerSend({ command: 'observe', targetText })
}

export function observerFinish() {
  if (!observerSend) return
  observerSend({ command: 'finish' })
}

export function observerCancel() {
  if (!observerSend) return
  observerSend({ command: 'cancel' })
}
