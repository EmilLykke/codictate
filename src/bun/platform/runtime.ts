import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformCapabilities, PlatformRuntime } from '../../shared/platform'

export function getPlatformRuntime(): PlatformRuntime {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'linux'
  }
}

export function getPlatformCapabilities(): PlatformCapabilities {
  const platform = getPlatformRuntime()
  switch (platform) {
    case 'macos':
      return {
        platform,
        supportsMacPermissionFlow: true,
        supportsStreamMode: true,
        supportsFormatting: true,
        supportsCorrectionObserver: true,
        supportsNativeIndicator: true,
      }
    case 'windows':
      return {
        platform,
        supportsMacPermissionFlow: false,
        supportsStreamMode: false,
        supportsFormatting: false,
        supportsCorrectionObserver: false,
        supportsNativeIndicator: false,
      }
    case 'linux':
      return {
        platform,
        supportsMacPermissionFlow: false,
        supportsStreamMode: false,
        supportsFormatting: false,
        supportsCorrectionObserver: false,
        supportsNativeIndicator: false,
      }
  }
}

function resolveAppDataRoot(): string {
  const platform = getPlatformRuntime()
  if (platform === 'windows') {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      join(homedir(), 'AppData', 'Local')
    )
  }
  if (platform === 'macos') {
    return join(homedir(), 'Library', 'Application Support')
  }
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
}

export const APP_DATA_DIR = join(resolveAppDataRoot(), 'codictate')
export const MODELS_DIR = join(APP_DATA_DIR, 'models')
export const LOG_PATH = join(APP_DATA_DIR, 'debug.log')
export const MAIN_CONFIG_PATH = join(APP_DATA_DIR, 'main-config.json')
export const DICTIONARY_CONFIG_PATH = join(APP_DATA_DIR, 'dictionary-config.json')
export const LEGACY_CONFIG_PATH = join(APP_DATA_DIR, 'app-config.json')
export const RECORDING_PATH = join(tmpdir(), 'codictate-recording.wav')
