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

import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'

function llamaBinaryCandidates(): string[] {
  return [
    join(import.meta.dir, '../native-helpers/llama-completion.exe'),
    join(process.cwd(), 'vendors/llama/llama-completion.exe'),
  ]
}

function resolveLlamaBinary(): string | null {
  for (const candidate of llamaBinaryCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const WINDOWS_HELPER_CANDIDATE_PATHS = [
  join(import.meta.dir, '../native-helpers/CodictateWindowsHelper.exe'),
  join(
    process.cwd(),
    'native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe'
  ),
]

function resolveWindowsHelperBinary(): string | null {
  for (const candidate of WINDOWS_HELPER_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

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

  isFormattingAvailable(): boolean {
    return resolveLlamaBinary() !== null
  }

  findKeyListenerBinary(): string {
    const found = resolveWindowsHelperBinary()
    if (!found)
      throw new Error(
        'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe exists, then rebuild.'
      )
    return found
  }

  async findMicRecorderBinary(): Promise<string> {
    const found = resolveWindowsHelperBinary()
    if (!found)
      throw new Error(
        'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe exists, then rebuild.'
      )
    return found
  }

  findWindowHelperBinary(): string | null {
    return resolveWindowsHelperBinary()
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
    const found = resolveWindowsHelperBinary()
    if (!found)
      throw new Error(
        'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe exists, then rebuild.'
      )
    return found
  }
}
