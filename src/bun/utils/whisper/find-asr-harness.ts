import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'
import {
  ASR_HARNESS_ENV_VAR,
  DEFAULT_ASR_HARNESS,
  isAsrHarnessId,
  type AsrHarnessId,
} from '../../../shared/asr-harness'
import { log } from '../logger'

/**
 * Where each ASR Harness binary lives, in resolution order: inside the built app
 * bundle first, then the repo's `vendors/` tree for dev runs.
 *
 * crispasr sits in its own `native-helpers/crispasr/` subdirectory because it
 * ships ggml libraries whose names collide with llama-completion's.
 */
const CANDIDATE_PATHS: Record<AsrHarnessId, string[]> =
  getPlatformRuntime() === 'windows'
    ? {
        'whisper-cli': [
          join(import.meta.dir, '../native-helpers/whisper-cli.exe'),
          join(import.meta.dir, '../../../../vendors/whisper/whisper-cli.exe'),
        ],
        crispasr: [
          join(import.meta.dir, '../native-helpers/crispasr/crispasr.exe'),
          join(import.meta.dir, '../../../../vendors/crispasr/crispasr.exe'),
        ],
      }
    : {
        'whisper-cli': [
          join(import.meta.dir, '../native-helpers/whisper-cli'),
          join(import.meta.dir, '../../../../vendors/whisper/whisper-cli'),
        ],
        crispasr: [
          join(import.meta.dir, '../native-helpers/crispasr/crispasr'),
          join(import.meta.dir, '../../../../vendors/crispasr/crispasr'),
        ],
      }

const NOT_FOUND_REMEDIATION: Record<AsrHarnessId, string> = {
  'whisper-cli':
    getPlatformRuntime() === 'windows'
      ? 'whisper-cli.exe not found. Run `bun run build:native:windows-helper` and let Electrobun prebuild vendor whisper.cpp, then rebuild the app.'
      : 'whisper-cli not found. Run `bun run build:native` so whisper.cpp is vendored, then rebuild the app.',
  crispasr:
    'crispasr not found. Run `bun run scripts/pre-build.ts --crispasr-only` to vendor it, then rebuild the app.',
}

const resolvedPaths = new Map<AsrHarnessId, string>()

export async function findAsrHarnessBinary(
  harness: AsrHarnessId = DEFAULT_ASR_HARNESS
): Promise<string> {
  const cached = resolvedPaths.get(harness)
  if (cached) return cached

  for (const candidate of CANDIDATE_PATHS[harness]) {
    if (await Bun.file(candidate).exists()) {
      resolvedPaths.set(harness, candidate)
      return candidate
    }
  }

  throw new Error(NOT_FOUND_REMEDIATION[harness])
}

export async function findWhisperCliBinary(): Promise<string> {
  return findAsrHarnessBinary('whisper-cli')
}

let loggedHarnessOverride = false

/**
 * True when the main process is running out of a source checkout rather than a
 * packaged app: only a checkout has the repo's `package.json` above `src/`.
 *
 * This is what makes the Harness override dev-only. Gating on it, rather than
 * trusting the env var alone, means a released build cannot be pushed onto the
 * unproven Harness by an environment variable inherited from whatever launched it.
 */
function isRunningFromSourceCheckout(): boolean {
  return existsSync(join(import.meta.dir, '../../../../package.json'))
}

/**
 * The Harness the app transcribes with. Always the default unless this is a source
 * checkout AND the dev-only `CODICTATE_ASR_HARNESS` env var names another one; there
 * is deliberately no user-facing picker
 * (docs/adr/0002-asr-harness-abstraction.md).
 */
export function resolveAppAsrHarness(): AsrHarnessId {
  const override = process.env[ASR_HARNESS_ENV_VAR]?.trim()
  if (!override) return DEFAULT_ASR_HARNESS

  if (!isRunningFromSourceCheckout()) {
    if (!loggedHarnessOverride) {
      loggedHarnessOverride = true
      log(
        'whisper',
        'ignoring ASR harness override outside a source checkout',
        {
          [ASR_HARNESS_ENV_VAR]: override,
        }
      )
    }
    return DEFAULT_ASR_HARNESS
  }

  if (!isAsrHarnessId(override)) {
    if (!loggedHarnessOverride) {
      loggedHarnessOverride = true
      log('whisper', 'ignoring unknown ASR harness override', {
        [ASR_HARNESS_ENV_VAR]: override,
      })
    }
    return DEFAULT_ASR_HARNESS
  }

  if (!loggedHarnessOverride) {
    loggedHarnessOverride = true
    log('whisper', 'ASR harness overridden by env', { harness: override })
  }
  return override
}
