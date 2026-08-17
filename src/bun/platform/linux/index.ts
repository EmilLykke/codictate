/**
 * Linux platform implementation.
 *
 * CONTRIBUTING: To add Linux support, implement the native helper binaries
 * listed below and update the `find*Binary` methods to resolve them.
 * Each helper must speak the same line-delimited JSON protocol on stdin/stdout
 * as the macOS Swift equivalents — see src/bun/platform/types.ts.
 *
 * Suggested tech stack:
 *   KeyListener   — Rust (rdev or evdev crate) for key capture + xdotool/xclip for paste
 *   MicRecorder   — Rust (cpal + hound) for ALSA/PipeWire recording
 *   WindowHelper  — GTK window or Electrobun BrowserWindow (optional)
 *   ObserverHelper — AT-SPI2 (libatspi) for accessibility text observation
 */

import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'

function llamaBinaryCandidates(): string[] {
  return [
    join(import.meta.dir, '../native-helpers/llama-completion'),
    join(process.cwd(), 'vendors/llama/llama-completion'),
  ]
}

function resolveLlamaBinary(): string | null {
  for (const candidate of llamaBinaryCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export class LinuxPlatformProvider implements PlatformProvider {
  getDataDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME
    const base = xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.config')
    return join(base, 'codictate')
  }

  getTempPath(filename: string): string {
    return join(tmpdir(), filename)
  }

  playSound(filePath: string): void {
    // Try PulseAudio first, then ALSA
    if (Bun.which('paplay')) {
      Bun.spawn(['paplay', filePath])
    } else if (Bun.which('aplay')) {
      Bun.spawn(['aplay', '-q', filePath])
    } else {
      console.warn(
        '[Linux] No audio player found (tried paplay, aplay). Install pulseaudio-utils or alsa-utils.'
      )
    }
  }

  openUrl(url: string): void {
    Bun.spawn(['xdg-open', url])
  }

  getPermissionSettingsUrl(_type: PermissionType): string | null {
    return null
  }

  isFormattingAvailable(): boolean {
    return resolveLlamaBinary() !== null
  }

  // ── Unimplemented native helpers ──────────────────────────────────────────

  findKeyListenerBinary(): string {
    throw new Error(
      '[Linux] KeyListener is not yet implemented.\n' +
        'Contribute a binary at native/linux/KeyListener that speaks the same\n' +
        'JSON/stdio protocol as the macOS Swift version — see src/bun/platform/types.ts'
    )
  }

  async findMicRecorderBinary(): Promise<string> {
    throw new Error(
      '[Linux] MicRecorder is not yet implemented.\n' +
        'Contribute a binary at native/linux/MicRecorder that records WAV via\n' +
        'ALSA or PipeWire and speaks the same CLI protocol as the macOS Swift version.'
    )
  }

  findWindowHelperBinary(): string | null {
    return null
  }

  findObserverHelperBinary(): string | null {
    return null
  }

  async findLlamaBinary(): Promise<string> {
    const found = resolveLlamaBinary()
    if (!found) {
      throw new Error(
        'llama-completion not found. Run `bun scripts/pre-build.ts` to build it.'
      )
    }
    return found
  }

  getFormatterModelPath(): string {
    return FORMATTER_MODEL_PATH
  }

  findParakeetHelperBinary(): string {
    throw new Error(
      '[Linux] CodictateParakeetHelper (Core ML) is macOS-only.\n' +
        'Live transcription is not available on Linux.'
    )
  }
}
