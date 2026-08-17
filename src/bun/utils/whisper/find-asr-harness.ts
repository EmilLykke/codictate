import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'
import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
} from '../../../shared/asr-harness'

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
        crispasr: [
          join(import.meta.dir, '../native-helpers/crispasr/crispasr.exe'),
          join(import.meta.dir, '../../../../vendors/crispasr/crispasr.exe'),
        ],
      }
    : {
        crispasr: [
          join(import.meta.dir, '../native-helpers/crispasr/crispasr'),
          join(import.meta.dir, '../../../../vendors/crispasr/crispasr'),
        ],
      }

const NOT_FOUND_REMEDIATION: Record<AsrHarnessId, string> = {
  crispasr:
    'crispasr not found. Run `bun run scripts/pre-build.ts --crispasr-only` to vendor it, then rebuild the app.',
}

const resolvedPaths = new Map<AsrHarnessId, string>()

/**
 * The binary for one ASR Harness, or a throw carrying its remediation.
 *
 * crispasr is the only Harness, so there is nothing to degrade to: a missing binary means
 * no Dictation can run, and that has to surface loudly rather than be papered over. It used
 * to fall back to `whisper-cli`, which existed for that purpose alone until the benchmark
 * retired it (docs/adr/0002-asr-harness-abstraction.md).
 */
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
