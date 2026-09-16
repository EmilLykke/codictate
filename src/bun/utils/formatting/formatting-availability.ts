import { findBinary, requireRuntimeBinary } from '../../platform/binaries'
import { existsSync } from 'fs'
import { getFormatterModelConfig } from '../../../bun/platform/runtime'
import type { FormatterModelTier } from '../../../shared/types'

/** Resolve the vendored llama-completion binary path. Throws if the build hasn't run. */
export async function findLlamaBinaryPath(): Promise<string> {
  return requireRuntimeBinary('llama')
}

/**
 * Whether the platform can run the formatter at all (vendored llama-completion
 * binary is present). A separate check (`isFormatterModelInstalled`) decides
 * whether the model has been downloaded yet.
 */
export function detectFormattingAvailable(): boolean {
  return findBinary('llama') !== null
}

/** True if the GGUF for the given tier has been downloaded. */
export function isFormatterModelInstalled(tier: FormatterModelTier): boolean {
  return existsSync(getFormatterModelConfig(tier).path)
}
