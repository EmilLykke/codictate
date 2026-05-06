import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PlatformCapabilities,
  PlatformRuntime,
} from '../../shared/platform'
import type { FormatterModelTier } from '../../shared/types'

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
        supportsFormatting: true,
        supportsCorrectionObserver: false,
        supportsNativeIndicator: true,
      }
    case 'linux':
      return {
        platform,
        supportsMacPermissionFlow: false,
        supportsStreamMode: false,
        supportsFormatting: true,
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
export const DICTIONARY_CONFIG_PATH = join(
  APP_DATA_DIR,
  'dictionary-config.json'
)
export const LEGACY_CONFIG_PATH = join(APP_DATA_DIR, 'app-config.json')
export const RECORDING_PATH = join(tmpdir(), 'codictate-recording.wav')
export const DEFAULT_HISTORY_DIR = join(homedir(), 'Documents', 'Codictate')

export interface FormatterModelConfig {
  readonly tier: FormatterModelTier
  readonly displayName: string
  readonly filename: string
  readonly path: string
  readonly url: string
  /** Fallback size for progress tracking when server omits Content-Length. */
  readonly expectedSizeBytes: number
  /** Human-readable size shown in UI. */
  readonly sizeLabel: string
  /** When true, /no_think is prepended to user prompt to disable reasoning mode (Qwen3). */
  readonly noThink: boolean
}

export const FORMATTER_MODELS: Record<
  FormatterModelTier,
  FormatterModelConfig
> = {
  fast: {
    tier: 'fast',
    displayName: 'Qwen2.5 3B',
    filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    path: join(MODELS_DIR, 'Qwen2.5-3B-Instruct-Q4_K_M.gguf'),
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    expectedSizeBytes: 2_020_000_000,
    sizeLabel: '~2 GB',
    noThink: false,
  },
  quality: {
    tier: 'quality',
    displayName: 'Qwen3 4B',
    filename: 'Qwen3-4B-Q4_K_M.gguf',
    path: join(MODELS_DIR, 'Qwen3-4B-Q4_K_M.gguf'),
    url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    expectedSizeBytes: 2_600_000_000,
    sizeLabel: '~2.5 GB',
    noThink: true,
  },
}

export function getFormatterModelConfig(
  tier: FormatterModelTier
): FormatterModelConfig {
  return FORMATTER_MODELS[tier]
}

// Legacy: kept for platform implementations that call getFormatterModelPath().
// Points to the fast-tier model path.
export const FORMATTER_MODEL_PATH = FORMATTER_MODELS.fast.path
