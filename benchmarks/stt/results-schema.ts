/**
 * Benchmark result shape and the migration for files written before ASR Harness
 * became a dimension.
 *
 * On disk, results are keyed `librispeech[dataset][harness][modelId]`. Result
 * files from before that change have no harness level and are read as
 * `whisper-cli`, which is what they were run with. See
 * docs/adr/0002-asr-harness-abstraction.md.
 */

import {
  DEFAULT_ASR_HARNESS,
  isAsrHarnessId,
  type AsrHarnessId,
} from '../../src/shared/asr-harness'
import { getSpeechModel } from '../../src/shared/speech-models'
import type { ModelDatasetResult } from './runner'

/** Results for one dataset: model results grouped by the Harness that produced them. */
export type HarnessModelResults = Partial<
  Record<AsrHarnessId, Record<string, ModelDatasetResult>>
>

export type DatasetResults = Record<string, HarnessModelResults>

/**
 * Separator between a Model ID and a non-default Harness in a flattened key.
 * Model IDs never contain `@`, so the key round-trips.
 */
const VARIANT_SEPARATOR = '@'

/**
 * The report/chart row identity for one Benchmark Combination.
 *
 * Results from the default Harness keep the bare Model ID so reports of runs that
 * only used `whisper-cli` render exactly as they did before the Harness dimension
 * existed.
 */
export function makeVariantKey(
  harness: AsrHarnessId,
  modelId: string
): string {
  return harness === DEFAULT_ASR_HARNESS
    ? modelId
    : `${modelId}${VARIANT_SEPARATOR}${harness}`
}

export function parseVariantKey(key: string): {
  modelId: string
  harness: AsrHarnessId
} {
  const index = key.lastIndexOf(VARIANT_SEPARATOR)
  if (index === -1) return { modelId: key, harness: DEFAULT_ASR_HARNESS }

  const suffix = key.slice(index + 1)
  if (!isAsrHarnessId(suffix)) {
    return { modelId: key, harness: DEFAULT_ASR_HARNESS }
  }
  return { modelId: key.slice(0, index), harness: suffix }
}

/** The Model ID a flattened report key refers to, dropping any Harness suffix. */
export function variantModelId(key: string): string {
  return parseVariantKey(key).modelId
}

function looksHarnessKeyed(value: object): boolean {
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every(isAsrHarnessId)
}

/**
 * Read one dataset's results, wrapping the pre-harness shape under `whisper-cli`.
 * An empty object is ambiguous and is returned as empty rather than guessed at.
 */
export function normalizeDatasetResults(raw: unknown): DatasetResults {
  if (!raw || typeof raw !== 'object') return {}

  const out: DatasetResults = {}
  for (const [datasetKey, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!value || typeof value !== 'object') continue

    if (looksHarnessKeyed(value)) {
      out[datasetKey] = value as HarnessModelResults
    } else {
      out[datasetKey] = {
        [DEFAULT_ASR_HARNESS]: value as Record<string, ModelDatasetResult>,
      }
    }
  }
  return out
}

/**
 * Collapse the harness level into variant keys, giving the flat
 * `[dataset][key]` shape the report and chart code consume.
 */
export function flattenDatasetResults(
  results: DatasetResults
): Record<string, Record<string, ModelDatasetResult>> {
  const flat: Record<string, Record<string, ModelDatasetResult>> = {}
  for (const [datasetKey, byHarness] of Object.entries(results)) {
    const models: Record<string, ModelDatasetResult> = {}
    for (const [harness, byModel] of Object.entries(byHarness)) {
      if (!isAsrHarnessId(harness) || !byModel) continue
      for (const [modelId, result] of Object.entries(byModel)) {
        models[makeVariantKey(harness, modelId)] = result
      }
    }
    flat[datasetKey] = models
  }
  return flat
}

/**
 * Which Harness bucket a model's results belong in.
 *
 * Only the Whisper Speech Engine has more than one Harness. Parakeet runs through
 * its own helper, so its numbers are identical whichever Harness the run selected
 * and always land in the default bucket rather than being duplicated per Harness.
 */
export function harnessBucketForModel(
  modelId: string,
  harness: AsrHarnessId
): AsrHarnessId {
  return getSpeechModel(modelId)?.engine === 'whisperkit'
    ? DEFAULT_ASR_HARNESS
    : harness
}

/** Read one Benchmark Combination out of the nested shape. */
export function getCombinationResult(
  results: DatasetResults,
  datasetKey: string,
  harness: AsrHarnessId,
  modelId: string
): ModelDatasetResult | undefined {
  return results[datasetKey]?.[harness]?.[modelId]
}

/** Write one Benchmark Combination into the nested shape, creating levels as needed. */
export function setCombinationResult(
  results: DatasetResults,
  datasetKey: string,
  harness: AsrHarnessId,
  modelId: string,
  result: ModelDatasetResult
): void {
  const byHarness = (results[datasetKey] ??= {})
  const byModel = (byHarness[harness] ??= {})
  byModel[modelId] = result
}
