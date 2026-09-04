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
  HVISKE_ASR_HARNESS,
  type AsrHarnessId,
} from "../../src/shared/asr-harness";
import {
  getSpeechModel,
  isHviskeSpeechModelId,
} from "../../src/shared/speech-models";
import type { ModelDatasetResult } from "./runner";

/**
 * Harness labels that may legitimately appear as a Harness key in a result file on
 * disk. Deliberately NOT `ASR_HARNESS_IDS`.
 *
 * Two different concepts used to share one type, and separating them is the point of
 * this constant:
 *
 * - **Runnable Harness** (`ASR_HARNESS_IDS` in src/shared/asr-harness.ts) - what a new
 *   Benchmark Run may execute. Use it for `--harness` validation and for building a
 *   run plan. Only ever shrinks when a Harness is retired from the build.
 * - **Archived Harness label** (this list) - what a Harness key in a result file on
 *   disk may say. Append-only: a label enters when a Harness is first run and never
 *   leaves, because the measurements keyed by it never go away.
 *
 * Every read path - parse, migrate, flatten, report, coverage, checkpoint resume -
 * must validate against this list. Validating disk data against the runnable set is
 * how the archive gets silently dropped: `results/2026-08-17_15-15-49_crispasr-vs-
 * whisper/stt.json` holds the whisper-cli measurements that justified retiring
 * whisper-cli, the three older runs are entirely whisper-cli, none of it can ever be
 * measured again, and a `continue` on an unrecognised key throws it away without a
 * word.
 *
 * `whisper-cli` is historical and NOT runnable. It stays here permanently.
 */
export const BENCHMARK_HARNESS_LABELS = ["crispasr", "whisper-cli"] as const;

export type BenchmarkHarnessLabel = (typeof BENCHMARK_HARNESS_LABELS)[number];

/**
 * Compile-time guard: every runnable Harness must also be an archived label, since
 * running one writes its name to disk. Adding a Harness to `ASR_HARNESS_IDS` without
 * adding it here fails `bun run tsc` on this line.
 */
export type RunnableHarnessesAreArchivedLabels =
  AsrHarnessId extends BenchmarkHarnessLabel ? true : never;

export function isBenchmarkHarnessLabel(
  value: unknown,
): value is BenchmarkHarnessLabel {
  return (
    typeof value === "string" &&
    (BENCHMARK_HARNESS_LABELS as readonly string[]).includes(value)
  );
}

/**
 * The Harness bucket whose rows render with a bare Model ID, in reports and charts.
 * Tracks the shipping Harness, so an unlabelled row always means "what users get".
 */
export const DEFAULT_HARNESS_LABEL: BenchmarkHarnessLabel = DEFAULT_ASR_HARNESS;

/**
 * The Harness that produced result files written before Harness was a dimension.
 *
 * Those three runs predate crispasr entirely, so this is a fact about the archive and
 * not a default: it must never be re-pointed at `DEFAULT_HARNESS_LABEL`. Doing so
 * silently re-attributes 34 Speech Models' worth of whisper-cli measurements to the
 * shipping Harness, which then reads as crispasr coverage that was never measured.
 */
export const PRE_HARNESS_ARCHIVE_LABEL: BenchmarkHarnessLabel = "whisper-cli";

/**
 * Results for one dataset: model results grouped by the Harness that produced them.
 *
 * Leaves are `ModelDatasetResult`, whose `referenceWords` is optional on purpose. The
 * runs written before that field existed have no denominator on disk, and reading is
 * append-only for the same reason Harness labels are: those measurements can never be
 * taken again, so a missing denominator has to load rather than throw. A consumer that
 * pools accuracy must skip - or backfill, see
 * `benchmarks/scripts/backfill-reference-words.ts` - the leaves that lack it, not
 * assume every leaf has one.
 */
export type HarnessModelResults = Partial<
  Record<BenchmarkHarnessLabel, Record<string, ModelDatasetResult>>
>;

export type DatasetResults = Record<string, HarnessModelResults>;

/**
 * Separator between a Model ID and a non-default Harness in a flattened key.
 * Model IDs never contain `@`, so the key round-trips.
 */
const VARIANT_SEPARATOR = "@";

/**
 * The report/chart row identity for one Benchmark Combination.
 *
 * Default-Harness results keep the bare Model ID, so a run under the shipping Harness
 * alone renders exactly as it did before the Harness dimension existed. Every other
 * archived Harness is named in the key, which is what keeps a report that mixes the
 * archive with new runs readable.
 */
export function makeVariantKey(
  harness: BenchmarkHarnessLabel,
  modelId: string,
): string {
  return harness === DEFAULT_HARNESS_LABEL
    ? modelId
    : `${modelId}${VARIANT_SEPARATOR}${harness}`;
}

export function parseVariantKey(key: string): {
  modelId: string;
  harness: BenchmarkHarnessLabel;
} {
  const index = key.lastIndexOf(VARIANT_SEPARATOR);
  if (index === -1) return { modelId: key, harness: DEFAULT_HARNESS_LABEL };

  const suffix = key.slice(index + 1);
  // Archived labels, not runnable ones: `modelId@whisper-cli` has to keep round-tripping
  // after whisper-cli stops being runnable, or every archived row loses its Harness.
  if (!isBenchmarkHarnessLabel(suffix)) {
    return { modelId: key, harness: DEFAULT_HARNESS_LABEL };
  }
  return { modelId: key.slice(0, index), harness: suffix };
}

/** The Model ID a flattened report key refers to, dropping any Harness suffix. */
export function variantModelId(key: string): string {
  return parseVariantKey(key).modelId;
}

/**
 * Whether a dataset's value already has the Harness level.
 *
 * Tested against archived labels: a file keyed `{ "whisper-cli": ..., "crispasr": ... }`
 * must still be recognised as harness-keyed once whisper-cli is no longer runnable.
 * Testing runnable ids here misreads that file as the pre-harness shape and wraps the
 * whole thing again, which turns the Harness names into Model IDs and drops every
 * measurement in it.
 */
function looksHarnessKeyed(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => isBenchmarkHarnessLabel(key));
}

/**
 * Read one dataset's results, wrapping the pre-harness shape under the Harness that
 * actually produced it. An empty object is ambiguous and is returned as empty rather
 * than guessed at.
 *
 * Models are bucketed one at a time rather than in bulk, because Parakeet appears in
 * those files too and never ran under any Harness - see `harnessBucketForModel`.
 */
export function normalizeDatasetResults(raw: unknown): DatasetResults {
  if (!raw || typeof raw !== "object") return {};

  const out: DatasetResults = {};
  for (const [datasetKey, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") continue;

    if (looksHarnessKeyed(value)) {
      out[datasetKey] = value as HarnessModelResults;
      continue;
    }

    const migrated: HarnessModelResults = {};
    for (const [modelId, result] of Object.entries(
      value as Record<string, ModelDatasetResult>,
    )) {
      const bucket = harnessBucketForModel(modelId, PRE_HARNESS_ARCHIVE_LABEL);
      (migrated[bucket] ??= {})[modelId] = result;
    }
    out[datasetKey] = migrated;
  }
  return out;
}

/**
 * Collapse the harness level into variant keys, giving the flat
 * `[dataset][key]` shape the report and chart code consume.
 */
export function flattenDatasetResults(
  results: DatasetResults,
): Record<string, Record<string, ModelDatasetResult>> {
  const flat: Record<string, Record<string, ModelDatasetResult>> = {};
  for (const [datasetKey, byHarness] of Object.entries(results)) {
    const models: Record<string, ModelDatasetResult> = {};
    for (const [harness, byModel] of Object.entries(byHarness)) {
      // Archived labels: guarding on runnable ids here drops every whisper-cli row.
      if (!isBenchmarkHarnessLabel(harness) || !byModel) continue;
      for (const [modelId, result] of Object.entries(byModel)) {
        models[makeVariantKey(harness, modelId)] = result;
      }
    }
    flat[datasetKey] = models;
  }
  return flat;
}

/**
 * Which Harness bucket a model's results belong in.
 *
 * Two Speech Engines ignore the run's selected Harness, and both are recorded under
 * the Harness that actually produced the numbers rather than the one that was asked
 * for:
 *
 * - Parakeet runs through its own helper, so Harness does not apply at all. Its
 *   numbers are identical whichever Harness a run selected, and land in the default
 *   bucket rather than being duplicated per Harness.
 * - hviske GGUF weights load only under crispasr's cohere backend, so `runner.ts`
 *   forces that Harness. Recording an hviske result under any other selected Harness
 *   would attribute crispasr's measurement to a Harness that never ran it.
 */
export function harnessBucketForModel(
  modelId: string,
  harness: BenchmarkHarnessLabel,
): BenchmarkHarnessLabel {
  if (getSpeechModel(modelId)?.engine === "whisperkit") {
    return DEFAULT_HARNESS_LABEL;
  }
  if (isHviskeSpeechModelId(modelId)) return HVISKE_ASR_HARNESS;
  return harness;
}

/** Every archived Harness label that has results in this run, in list order. */
export function harnessLabelsPresent(
  ...results: DatasetResults[]
): BenchmarkHarnessLabel[] {
  const present = new Set<string>();
  for (const datasetResults of results) {
    for (const byHarness of Object.values(datasetResults)) {
      for (const [harness, byModel] of Object.entries(byHarness)) {
        if (byModel && Object.keys(byModel).length > 0) present.add(harness);
      }
    }
  }
  return BENCHMARK_HARNESS_LABELS.filter((label) => present.has(label));
}

/** Read one Benchmark Combination out of the nested shape. */
export function getCombinationResult(
  results: DatasetResults,
  datasetKey: string,
  harness: BenchmarkHarnessLabel,
  modelId: string,
): ModelDatasetResult | undefined {
  return results[datasetKey]?.[harness]?.[modelId];
}

/** Write one Benchmark Combination into the nested shape, creating levels as needed. */
export function setCombinationResult(
  results: DatasetResults,
  datasetKey: string,
  harness: BenchmarkHarnessLabel,
  modelId: string,
  result: ModelDatasetResult,
): void {
  const byHarness = (results[datasetKey] ??= {});
  const byModel = (byHarness[harness] ??= {});
  byModel[modelId] = result;
}
