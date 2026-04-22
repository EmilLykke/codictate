import { mkdirSync, appendFileSync } from 'fs'
import { writeNativePasteboard } from './clipboard/native-pasteboard-bridge'
import { APP_DATA_DIR, LOG_PATH } from '../platform/runtime'

const DEBUG_AUTO_DISABLE_MS = 5 * 60 * 1_000 // 5 minutes
const RING_BUFFER_MAX = 500

const LOG_DIR = APP_DATA_DIR

let debugEnabled = false
let autoDisableTimer: ReturnType<typeof setTimeout> | null = null
const ringBuffer: string[] = []
let onAutoDisableCallback: (() => void) | null = null

export function setOnAutoDisable(cb: () => void) {
  onAutoDisableCallback = cb
}

function formatLine(
  tag: string,
  message: string,
  data?: Record<string, unknown>
): string {
  const ts = new Date().toISOString()
  const dataPart = data ? '  ' + JSON.stringify(data) : ''
  return `[${ts}] [${tag}] ${message}${dataPart}`
}

function appendToBuffer(line: string) {
  ringBuffer.push(line)
  if (ringBuffer.length > RING_BUFFER_MAX) {
    ringBuffer.shift()
  }
}

function appendToFile(line: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_PATH, line + '\n')
  } catch {
    // Swallow file write errors — logging must never crash the app
  }
}

export function log(
  tag: string,
  message: string,
  data?: Record<string, unknown>
) {
  if (!debugEnabled) return
  const line = formatLine(tag, message, data)
  appendToBuffer(line)
  appendToFile(line)
}

export function enableDebug() {
  // Clear existing timer so re-enabling resets the 5-minute window
  if (autoDisableTimer !== null) {
    clearTimeout(autoDisableTimer)
  }

  debugEnabled = true

  const sessionLine = formatLine(
    'logger',
    'Debug logging enabled — session start'
  )
  appendToBuffer(sessionLine)
  appendToFile(sessionLine)

  autoDisableTimer = setTimeout(() => {
    autoDisableTimer = null
    disableDebug()
    onAutoDisableCallback?.()
  }, DEBUG_AUTO_DISABLE_MS)
}

export function disableDebug() {
  if (autoDisableTimer !== null) {
    clearTimeout(autoDisableTimer)
    autoDisableTimer = null
  }

  // Write the disable marker before turning off so it lands in the file
  const line = formatLine('logger', 'Debug logging disabled')
  appendToBuffer(line)
  appendToFile(line)

  debugEnabled = false
}

export function isDebugEnabled(): boolean {
  return debugEnabled
}

export async function copyLogToClipboard() {
  const content = ringBuffer.join('\n')
  if (writeNativePasteboard(content)) return
  console.warn('[logger] Copy debug log skipped (KeyListener not running yet).')
}
