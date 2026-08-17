import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'
import {
  ASR_HARNESS_ENV_VAR,
  DEFAULT_ASR_HARNESS,
  FALLBACK_ASR_HARNESS,
  HVISKE_ASR_HARNESS,
  HVISKE_ENABLE_ENV_VAR,
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

export interface ResolvedAsrHarness {
  /** The Harness whose binary was actually resolved, which may not be the requested one. */
  harness: AsrHarnessId
  binary: string
}

const loggedMissingHarnesses = new Set<AsrHarnessId>()

/**
 * Resolve a Harness to a binary, degrading to `whisper-cli` when the requested Harness has
 * no binary in this build.
 *
 * The default Harness is crispasr, which ships as a vendored binary plus its own ggml
 * libraries. If that copy is missing or unreadable, throwing here would take out every
 * Dictation; running the same flags through whisper-cli only costs speed. So callers get
 * the Harness that actually resolved, and report that rather than what they asked for.
 *
 * Not used for hviske runs: those pin `--backend cohere`, a flag `whisper-cli` does not
 * have, so a degrade would build an invalid command.
 */
export async function resolveAsrHarnessBinary(
  harness: AsrHarnessId = DEFAULT_ASR_HARNESS
): Promise<ResolvedAsrHarness> {
  try {
    return { harness, binary: await findAsrHarnessBinary(harness) }
  } catch (err) {
    if (harness === FALLBACK_ASR_HARNESS) throw err

    if (!loggedMissingHarnesses.has(harness)) {
      loggedMissingHarnesses.add(harness)
      log('whisper', 'ASR harness binary missing, falling back', {
        harness,
        fallbackHarness: FALLBACK_ASR_HARNESS,
        error: String(err),
      })
    }

    return {
      harness: FALLBACK_ASR_HARNESS,
      binary: await findAsrHarnessBinary(FALLBACK_ASR_HARNESS),
    }
  }
}

let loggedHarnessOverride = false

/**
 * True when the main process is running out of a source checkout rather than a
 * packaged app: only a checkout has the repo's `package.json` above `src/`.
 *
 * This is what makes both dev-only switches dev-only: the Harness override and the hviske
 * gate. Gating on a source checkout, rather than trusting an env var alone, means a
 * released build cannot be moved off the shipping Harness, or shown the prep-only hviske
 * Speech Models, by an environment variable inherited from whatever launched it.
 */
function isRunningFromSourceCheckout(): boolean {
  return existsSync(join(import.meta.dir, '../../../../package.json'))
}

/** Env flags are opt-in: anything but an explicit affirmative value reads as off. */
function isEnvFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return false
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * The Harness the app transcribes with: crispasr, unless this is a source checkout AND the
 * dev-only `CODICTATE_ASR_HARNESS` env var names another one (in practice `whisper-cli`,
 * to compare against the Harness Codictate shipped before). There is deliberately no
 * user-facing picker (docs/adr/0002-asr-harness-abstraction.md).
 *
 * This covers every Whisper run including translate: `-tr` was measured equivalent on both
 * Harnesses, so translate has no Harness of its own.
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

/**
 * Whether the prep-only hviske Speech Models may be touched at all (downloaded or
 * transcribed with).
 *
 * This gate is deliberately independent of which Harness is the default. It used to be
 * "is the app on crispasr", which was safe only while crispasr was a dev-only opt-in;
 * now that crispasr is the shipping Harness that test would be true for every user, and
 * would expose the hviske Speech Models in the tray menu, the Home screen and the download
 * path for a Mirror that does not exist yet, so every download would 404.
 *
 * So hviske requires all of: a source checkout, an explicit `CODICTATE_ENABLE_HVISKE`
 * affirmative, and a resolved Harness that can actually load the weights. A released build
 * can never satisfy the first, and no default satisfies the second. Callers that see false
 * must fall back to default behaviour rather than attempt an hviske run.
 */
export function isHviskeEnabled(): boolean {
  if (!isRunningFromSourceCheckout()) return false
  if (!isEnvFlagEnabled(process.env[HVISKE_ENABLE_ENV_VAR])) return false
  return resolveAppAsrHarness() === HVISKE_ASR_HARNESS
}
