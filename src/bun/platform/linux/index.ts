/**
 * Linux platform implementation.
 *
 * CONTRIBUTING: To add Linux support, implement the native helper binaries
 * listed below and register their artifacts in src/shared/binary-manifest.ts.
 * Each helper must speak the same line-delimited JSON protocol on stdin/stdout
 * as the macOS Swift equivalents — see src/bun/platform/types.ts.
 *
 * Suggested tech stack:
 *   KeyListener   — Rust (rdev or evdev crate) for key capture + xdotool/xclip for paste
 *   MicRecorder   — Rust (cpal + hound) for ALSA/PipeWire recording
 *   WindowHelper  — GTK window or Electrobun BrowserWindow (optional)
 *   ObserverHelper — AT-SPI2 (libatspi) for accessibility text observation
 */

import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'

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

  getFormatterModelPath(): string {
    return FORMATTER_MODEL_PATH
  }
}
