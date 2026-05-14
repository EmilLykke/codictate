import { findKeyboardHelperBinary } from './find-keyboard-helper'

const FALLBACK = {
  accessibility: false,
  inputMonitoring: false,
  microphone: false,
} as const

export async function checkNativePermissions(): Promise<{
  accessibility: boolean
  inputMonitoring: boolean
  microphone: boolean
}> {
  try {
    const helper = await findKeyboardHelperBinary()
    if (helper.kind !== 'macos') return FALLBACK

    const proc = Bun.spawn([helper.path, '--check-permissions'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const result = await Promise.race([
      Promise.all([proc.stdout.text(), proc.exited]),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill()
          reject(new Error('timeout'))
        }, 3000)
      ),
    ])

    const [stdout, exitCode] = result as [string, number]
    if (exitCode !== 0) {
      console.error(`[permissions] KeyListener exited with code ${exitCode}`)
      return FALLBACK
    }

    const parsed = JSON.parse(stdout.trim()) as Record<string, boolean>
    return {
      accessibility: parsed.accessibility === true,
      inputMonitoring: parsed.inputMonitoring === true,
      microphone: parsed.microphone === true,
    }
  } catch (err) {
    console.error('[permissions] checkNativePermissions failed:', err)
    return FALLBACK
  }
}
