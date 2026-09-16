import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'

const PERMISSION_URLS: Record<PermissionType, string> = {
  inputMonitoring:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  documents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
}

export class MacOSPlatformProvider implements PlatformProvider {
  getDataDir(): string {
    return join(homedir(), 'Library', 'Application Support', 'codictate')
  }

  getTempPath(filename: string): string {
    return join(tmpdir(), filename)
  }

  playSound(filePath: string): void {
    Bun.spawn(['afplay', filePath])
  }

  openUrl(url: string): void {
    Bun.spawn(['open', url])
  }

  getPermissionSettingsUrl(type: PermissionType): string | null {
    return PERMISSION_URLS[type] ?? null
  }

  getFormatterModelPath(): string {
    return FORMATTER_MODEL_PATH
  }
}
