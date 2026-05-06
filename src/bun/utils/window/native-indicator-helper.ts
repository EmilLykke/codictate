import type { AppStatus, ThemePreference } from '../../../shared/types'
import { getPlatform } from '../../platform'
import { getPlatformRuntime } from '../../platform/runtime'

type MoveEvent = { type: 'move'; x?: number; y?: number }

function statusToWire(
  status: AppStatus
): 'ready' | 'recording' | 'transcribing' {
  switch (status) {
    case 'recording':
      return 'recording'
    case 'transcribing':
      return 'transcribing'
    default:
      return 'ready'
  }
}

export type NativeIndicatorHelper = {
  show: (
    frame: { x: number; y: number; width: number; height: number },
    status: AppStatus,
    theme?: ThemePreference
  ) => void
  hide: () => void
  setStatus: (status: AppStatus) => void
  setTheme: (theme: ThemePreference) => void
  dispose: () => void
}

export function createNativeIndicatorHelper(
  onMove?: (x: number, y: number) => void
): NativeIndicatorHelper | null {
  const helperPath = getPlatform().findWindowHelperBinary()
  if (!helperPath) return null

  const args =
    getPlatformRuntime() === 'windows'
      ? [helperPath, 'indicator']
      : [helperPath]

  const proc = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const reader = proc.stdout.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line !== '') {
          try {
            const event = JSON.parse(line) as MoveEvent
            if (
              event.type === 'move' &&
              typeof event.x === 'number' &&
              typeof event.y === 'number'
            ) {
              onMove?.(event.x, event.y)
            }
          } catch {
            /* ignore non-protocol stdout */
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
  })()

  function send(command: Record<string, unknown>) {
    proc.stdin.write(JSON.stringify(command) + '\n')
    proc.stdin.flush()
  }

  return {
    show(frame, status, theme) {
      send({
        command: 'show',
        ...frame,
        status: statusToWire(status),
        ...(theme ? { theme } : {}),
      })
    },
    hide() {
      send({ command: 'hide' })
    },
    setStatus(status) {
      send({ command: 'status', status: statusToWire(status) })
    },
    setTheme(theme) {
      send({ command: 'theme', theme })
    },
    dispose() {
      try {
        send({ command: 'quit' })
      } catch {
        /* already gone */
      }
    },
  }
}
