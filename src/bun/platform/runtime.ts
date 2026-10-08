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
        supportsStreamMode: true,
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
  /**
   * SHA-256 required before a downloaded model is installed. Every `url` resolves a fixed
   * Hugging Face commit, so this is that commit's LFS oid for the file.
   */
  readonly sha256: string
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
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/f302c64a2269a69fb27b2f9473b362f5bb8e78d8/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    expectedSizeBytes: 1_929_903_264,
    sizeLabel: '~2 GB',
    noThink: false,
    sha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
  },
  quality: {
    tier: 'quality',
    displayName: 'Qwen3 4B',
    filename: 'Qwen3-4B-Q4_K_M.gguf',
    path: join(MODELS_DIR, 'Qwen3-4B-Q4_K_M.gguf'),
    url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a5a1ad1120/Qwen3-4B-Q4_K_M.gguf',
    expectedSizeBytes: 2_497_281_312,
    sizeLabel: '~2.5 GB',
    noThink: true,
    sha256: 'f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a',
  },
  's1-mini': {
    tier: 's1-mini',
    displayName: 'S1-mini by Superwhisper',
    filename: 's1-mini-q4_k_m.gguf',
    path: join(MODELS_DIR, 's1-mini-q4_k_m.gguf'),
    url: 'https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/34add00a48a2e5d24e5a4ee5405a99620a3a240c/s1-mini-q4_k_m.gguf',
    expectedSizeBytes: 484_219_808,
    sizeLabel: '~484 MB',
    noThink: true,
    sha256: '3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634',
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
