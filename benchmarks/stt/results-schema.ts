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
  ASR_HARNESS_IDS,
  DEFAULT_ASR_HARNESS,
  HVISKE_ASR_HARNESS,
  type AsrHarnessId,
} from "../../src/shared/asr-harness";
import {
  getSpeechModel,
  isHviskeSpeechModelId,
} from "../../src/shared/speech-models";
import { pooledLeafFromSamples, type ModelDatasetResult } from "./runner";
import {
  assertRunRecordAgreesWithPlan,
  isRunRecordV2,
  normalizeRunRecordV2,
  poolSamples,
  type PoolBucket,
  type RunRecordV2,
  type SkippedRun,
} from "../contract";

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
 * Leaves are `ModelDatasetResult`, whose `referenceWords` and `failures` are optional on
 * purpose. The runs written before either field existed have no denominator and no
 * failure count on disk, and reading is append-only for the same reason Harness labels
 * are: those measurements can never be taken again, so a missing field has to load
 * rather than throw. A consumer that pools accuracy must skip - or backfill, see
 * `benchmarks/scripts/backfill-reference-words.ts` - the leaves that lack a denominator,
 * not assume every leaf has one.
 *
 * `failures` is the one field that cannot be backfilled. A denominator can be recounted
 * from the reference transcripts, but nothing on disk records which utterances failed, so
 * an archived leaf without the field means "not counted" and must be reported that way
 * rather than as zero.
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

// -- v2 read support, alongside v1 --

/**
 * Where a Benchmark Run's v2 records live inside its run directory.
 *
 * Underscore-prefixed, which is not decoration: the website's benchmark scan already
 * skips `_`-prefixed directories (that is how `_combined` stays invisible to it), so v2
 * records land beside the v1 `stt.json` without appearing to the v1 reader as an eighth
 * archived run. `codicate-releases` keeps its v2 records under the same rule.
 */
export const V2_RECORDS_DIRNAME = "_v2";

/**
 * The measuring harness name Codictate writes into every v2 record.
 *
 * `codictate`, not `crispasr`. The contract's `harness` is the *measuring* harness - the
 * thing being instrumented, `codictate` or `wispr-flow` - and it is half of the
 * compatibility key that decides whether two measurements of one clip may replace each
 * other. Codictate's own **ASR Harness** is a different dimension with a different
 * meaning, and it is absent from the key because it collapses: `crispasr` is the only
 * runnable one (ADR-0002), so every v2 record that can exist was produced by it, and
 * `whisper-cli`'s archived measurements are v1 aggregate leaves that can never become v2
 * Samples.
 *
 * `assertSingleRunnableAsrHarness` below is the tripwire on that argument. If a second
 * ASR Harness ever becomes runnable, `harness` here has to become `codictate/<harness>`
 * and the contract's `compatibilityKey` has to grow the dimension - otherwise two
 * Harnesses' measurements of one clip would pool as newer-and-older measurements of the
 * same thing, and the newest would publish under the other's name.
 */
export const CODICTATE_V2_HARNESS = "codictate" as const;

/**
 * Refuses to pool v2 records while more than one ASR Harness is runnable.
 *
 * Called from the pooling path rather than left as a comment, because the failure it
 * guards against is silent: a second runnable Harness would produce records that look
 * compatible and are not. Failing here costs a message; not failing costs a leaderboard.
 */
export function assertSingleRunnableAsrHarness(): void {
  if (ASR_HARNESS_IDS.length === 1) return;
  throw new Error(
    `${ASR_HARNESS_IDS.length} ASR Harnesses are runnable (${ASR_HARNESS_IDS.join(", ")}), but a v2 ` +
      `run record records only the measuring harness "${CODICTATE_V2_HARNESS}". Two ASR Harnesses ` +
      `measuring one clip would pool as two measurements of the same series. Put the ASR Harness ` +
      `into the record's harness field and into the contract's compatibilityKey first.`,
  );
}

/**
 * A v2 run record read off disk, or `null` when the file is not one.
 *
 * `null` for a v1 file or for junk - a v1 `stt.json` is not a broken v2 record and must
 * not be reported as one - and a **throw** for a v2 record that contradicts its own plan
 * reference. The asymmetry is deliberate: an unrecognised shape is a reader question, and
 * a v2 record whose fingerprint disagrees with its plan is a corrupted measurement, which
 * has to be loud rather than skipped into silence.
 *
 * `normalizeRunRecordV2` runs first, in front of the type guard, so a record written with
 * the literal `SCHEMA_VERSION` key is rewritten to `schemaVersion` before it is judged.
 * Skipping that step is how an aliased record passes nothing and then vanishes from
 * pooling without a word.
 */
export function parseRunRecordV2(raw: unknown): RunRecordV2 | null {
  const normalized = normalizeRunRecordV2(raw);
  if (!isRunRecordV2(normalized)) return null;
  assertRunRecordAgreesWithPlan(normalized);
  return normalized;
}

/** Where a contract `datasetId` lands in the v1 result tree. */
export interface V1DatasetLocation {
  field: "librispeech" | "fleurs";
  datasetKey: string;
}

/**
 * The v1 `[field][datasetKey]` slot a contract `datasetId` belongs to.
 *
 * `fleurs/da_dk` -> `fleurs.da_dk`, `librispeech/test-clean` -> `librispeech["test-clean"]`.
 * `null` for anything else, because guessing a corpus from a dataset id is how a FLEURS
 * locale ends up filed as a LibriSpeech split and rendered under the wrong condition
 * label.
 */
export function v1DatasetLocation(datasetId: string): V1DatasetLocation | null {
  const slash = datasetId.indexOf("/");
  if (slash === -1) return null;
  const corpus = datasetId.slice(0, slash);
  const datasetKey = datasetId.slice(slash + 1);
  if (datasetKey.length === 0) return null;
  if (corpus === "fleurs") return { field: "fleurs", datasetKey };
  if (corpus === "librispeech") return { field: "librispeech", datasetKey };
  return null;
}

/** One pooled v2 bucket, as a v1-shaped leaf plus where it belongs in the tree. */
export interface PooledV2Leaf extends V1DatasetLocation {
  /** The archived Harness bucket this leaf is filed under in the v1 tree. */
  harness: BenchmarkHarnessLabel;
  modelId: string;
  /** Pooled unique scored clips. Never a sum of slice sizes. */
  sampleCount: number;
  /** The runs whose Samples survived pooling, sorted. */
  runIds: readonly string[];
  /** Clips whose earlier measurement was superseded by a later run. */
  replacedCount: number;
  leaf: ModelDatasetResult;
}

export interface PooledV2Result {
  leaves: PooledV2Leaf[];
  /** Runs that contributed nothing, and why. Incomplete runs are in here. */
  skippedRuns: readonly SkippedRun[];
  /** Buckets whose `datasetId` does not name a corpus this repository stores. */
  unplaceableBuckets: readonly string[];
  /**
   * Buckets measured by another harness, which this tree cannot represent.
   *
   * `benchmarks/results/` is Codictate's v1 tree: a leaf is filed under an **ASR
   * Harness** bucket (`crispasr`, `whisper-cli`) and rendered as a Codictate row. A
   * `wispr-flow` record has no ASR Harness at all, and `harnessBucketForModel` would hand
   * it `crispasr` - so a Flow measurement would render as a crispasr one, silently and
   * under the wrong product's name.
   *
   * Nothing writes such a record here today. It is refused rather than trusted because
   * this module documents the on-disk shape **both repositories write**, and a shared
   * format is exactly where "nothing does that today" stops being a guarantee.
   */
  foreignHarnessBuckets: readonly string[];
}

/**
 * Pool v2 run records into v1-shaped leaves, one per compatibility bucket.
 *
 * The replacement for `--aggregate`'s depth-wins rule, and a different operation. With
 * aggregate leaves the only resolution available was "keep the deeper one and discard the
 * other entirely", because a rate and a count have no clips to intersect; two runs of
 * `[0, 400)` and `[400, 800)` therefore produced one 400-clip leaf under a `sampleSize`
 * of 800. With a Sample per clip the resolution is per clip: disjoint runs union, an
 * overlapping rerun replaces only the clipIds it re-measured, and the earlier run's other
 * clips survive. `sampleCount` is the pooled unique scored clips and is what the merged
 * `config.sampleSize` reports.
 *
 * Buckets rather than one flat pool, because `clipId` is dataset-scoped and not
 * model-scoped: Wispr Flow and `large-v3-q5_0` both legitimately measure
 * `fleurs/da_dk/audio/test/1214...wav`, and nothing about those two measurements competes.
 * Cross-dataset pooling happens *above* the buckets, by summing each bucket's errors and
 * references - which is why `report.ts` pools leaves rather than runs.
 *
 * Incomplete runs contribute nothing, not even the clips they finished. They appear in
 * `skippedRuns` so a caller can say so out loud.
 */
export function pooledV2Leaves(
  records: readonly RunRecordV2[],
  options?: { computeCer?: (location: V1DatasetLocation) => boolean },
): PooledV2Result {
  assertSingleRunnableAsrHarness();

  const computeCer =
    options?.computeCer ?? ((location) => location.field === "fleurs");
  const pooled = poolSamples(records);
  const leaves: PooledV2Leaf[] = [];
  const unplaceableBuckets: string[] = [];
  const foreignHarnessBuckets: string[] = [];

  for (const bucket of pooled.buckets) {
    if (bucket.harness !== CODICTATE_V2_HARNESS) {
      foreignHarnessBuckets.push(bucket.key);
      continue;
    }
    const location = v1DatasetLocation(bucket.datasetId);
    if (!location) {
      unplaceableBuckets.push(bucket.key);
      continue;
    }
    leaves.push({
      ...location,
      // Recovered from the Model ID and the shipping Harness, exactly as the run that
      // wrote the record would have filed it. Sound only while one ASR Harness is
      // runnable, which `assertSingleRunnableAsrHarness` above is the guard for.
      harness: harnessBucketForModel(bucket.model, DEFAULT_HARNESS_LABEL),
      modelId: bucket.model,
      sampleCount: bucket.samples.length,
      runIds: bucket.runIds,
      replacedCount: bucket.replaced.length,
      leaf: pooledLeafFromSamples(bucket.samples, {
        computeCer: computeCer(location),
        // The guard forbids a `sampleRange` on a leaf that pools more than one run: one
        // range cannot describe several, and a cursor derived from it would claim clips
        // nobody transcribed. `pooledLeafFromSamples` never writes one, and this is what
        // makes that a checked property rather than a habit.
        pooledRunCount: bucket.runIds.length,
      }),
    });
  }

  return {
    leaves,
    skippedRuns: pooled.skippedRuns,
    unplaceableBuckets,
    foreignHarnessBuckets,
  };
}

/** The compatibility buckets of these records, for a diagnostic line. */
export function v2Buckets(
  records: readonly RunRecordV2[],
): readonly PoolBucket[] {
  return poolSamples(records).buckets;
}
