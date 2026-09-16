/**
 * Windows platform implementation.
 *
 * CONTRIBUTING: Windows keyboard, paste, device listing, and mic recording are
 * handled by the shared CodictateWindowsHelper Rust binary.
 *
 * Suggested tech stack:
 *   KeyListener   — C# (RegisterHotKey + low-level keyboard hook + SendInput) or Rust (rdev)
 *   MicRecorder   — C# (NAudio/WASAPI) or Rust (cpal + hound)
 *   WindowHelper  — WPF/WinForms floating window or Electrobun BrowserWindow (optional)
 *   ObserverHelper — UI Automation (IUIAutomation) for text observation
 */

import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'

export class WindowsPlatformProvider implements PlatformProvider {
  getDataDir(): string {
    const appData = process.env.APPDATA
    const base = appData ?? join(homedir(), 'AppData', 'Roaming')
    return join(base, 'codictate')
  }

  getTempPath(filename: string): string {
    return join(tmpdir(), filename)
  }

  playSound(filePath: string): void {
    // PowerShell SoundPlayer — works for WAV; MP3 needs a different approach
    Bun.spawn([
      'powershell',
      '-NoProfile',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`,
    ])
  }

  openUrl(url: string): void {
    Bun.spawn(['cmd', '/c', 'start', '', url])
  }

  getPermissionSettingsUrl(_type: PermissionType): string | null {
    return null
  }

  getFormatterModelPath(): string {
    return FORMATTER_MODEL_PATH
  }
}
