/**
 * What has already been benchmarked, aggregated across every Benchmark Run in
 * `benchmarks/results/`.
 *
 * Two questions come out of one scan, because they come out of the same files:
 *
 * - **Coverage** - has this Benchmark Combination been measured, and how deep? A property
 *   of a Combination, one (Harness, Speech Model, dataset, language) tuple, not of a
 *   Speech Model, and the same Combination can exist at different depths across runs.
 *   Coverage keeps the deepest run seen.
 * - **The sample cursor** - *which* clips has it been measured on? An offset into the
 *   dataset's ordered manifest, taken from the `sampleRange` each leaf records. See
 *   `sample-cursor.ts` for what makes that offset meaningful.
 *
 * The run directories are the source of truth for both. `benchmarks/results/stt.json`,
 * the root aggregate written by `--aggregate`, is deliberately not read: it is a merge of
 * the same measurements, so counting it would double-count every Combination in it - and
 * for the cursor that would be worse than double-counting a badge, since the aggregate
 * carries leaves copied out of runs whose ranges are already accounted for.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isBenchmarkHarnessLabel,
  normalizeDatasetResults,
  parseRunRecordV2,
  V2_RECORDS_DIRNAME,
  type BenchmarkHarnessLabel,
} from "./results-schema";
import {
  contiguousCursor,
  isCompletedRunRecordV2,
  isRunPlan,
  maxMeasuredEnd,
  pooledSampleCount,
  type RunPlan,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "../contract";
import {
  deepestCursorForDataset,
  emptyCursorIndex,
  foldRecordedRanges,
  type CursorIndex,
  type RecordedRange,
  type SampleRange,
} from "./sample-cursor";

/** harness -> modelId -> datasetKey -> deepest sample count recorded. */
export type CoverageIndex = Record<
  string,
  Record<string, Record<string, number>>
>;

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** Unrecognised Harness keys already reported, so one bad file warns once. */
const warnedUnknownHarnesses = new Set<string>();

/** One leaf of one run, reduced to the facts both indices are built from. */
interface LeafFact {
  harness: string;
  modelId: string;
  datasetKey: string;
  utteranceCount: number;
  range?: SampleRange;
}

interface RunFacts {
  datasetKeys: string[];
  leaves: LeafFact[];
}

/**
 * A `sampleRange` read off disk, or `undefined` if the field is absent or malformed.
 *
 * Malformed reads as absent rather than as zero: absent means "position unknown", which is
 * the safe answer, where a partly-parsed range would place a measurement somewhere it
 * never was.
 */
function parseSampleRange(
  raw: unknown,
  leafName: string,
): SampleRange | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    console.warn(`Warning: ${leafName} has a non-object sampleRange; ignored.`);
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const { startIndex, endIndex, manifestFingerprint } = candidate;
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    typeof manifestFingerprint !== "string" ||
    manifestFingerprint === "" ||
    (startIndex as number) < 0 ||
    (endIndex as number) < (startIndex as number)
  ) {
    console.warn(
      `Warning: ${leafName} has an unreadable sampleRange (${JSON.stringify(raw)}); ignored, so it contributes no cursor.`,
    );
    return undefined;
  }
  return {
    startIndex: startIndex as number,
    endIndex: endIndex as number,
    manifestFingerprint,
  };
}

/**
 * Reduce one run's `librispeech` / `fleurs` blocks to leaf facts.
 *
 * Goes through `normalizeDatasetResults`, so the three pre-harness runs are read under the
 * Harness that produced them rather than skipped.
 */
function runFacts(
  runName: string,
  parsed: { librispeech?: unknown; fleurs?: unknown },
): RunFacts {
  const datasetKeys = new Set<string>();
  const leaves: LeafFact[] = [];

  for (const block of [parsed.librispeech, parsed.fleurs]) {
    for (const [datasetKey, byHarness] of Object.entries(
      normalizeDatasetResults(block),
    )) {
      datasetKeys.add(datasetKey);
      for (const [harness, byModel] of Object.entries(byHarness)) {
        if (!byModel) continue;
        // Keyed by whatever the file says, including retired Harnesses, so archived
        // Combinations still count as measured. An unrecognised label is still recorded -
        // dropping measured data is worse than an odd bucket - but it says so out loud
        // rather than creating a phantom bucket in silence.
        if (
          !isBenchmarkHarnessLabel(harness) &&
          !warnedUnknownHarnesses.has(harness)
        ) {
          warnedUnknownHarnesses.add(harness);
          console.warn(
            `Warning: result files contain unknown ASR Harness key "${harness}". Add it to BENCHMARK_HARNESS_LABELS if it is a real archived Harness.`,
          );
        }
        for (const [modelId, result] of Object.entries(byModel)) {
          leaves.push({
            harness,
            modelId,
            datasetKey,
            utteranceCount: result.utteranceCount,
            range: parseSampleRange(
              (result as { sampleRange?: unknown }).sampleRange,
              `${runName} ${datasetKey}/${harness}/${modelId}`,
            ),
          });
        }
      }
    }
  }

  return { datasetKeys: [...datasetKeys], leaves };
}

/**
 * The ranges one run's `stt.json` records, as parsed JSON rather than as a path.
 *
 * The pure seam of the scan below: `loadCoverage` is the same walk plus the filesystem and
 * the cache, and the tests drive this directly so the cursor can be checked against a
 * fixture without a temporary directory. Handed the object `JSON.parse` produced, so it
 * sees both on-disk shapes exactly as a run directory does.
 */
export function recordedRangesFromRun(
  runName: string,
  parsed: { librispeech?: unknown; fleurs?: unknown },
): RecordedRange[] {
  return runFacts(runName, parsed)
    .leaves.filter((leaf) => leaf.range !== undefined)
    .map((leaf) => ({
      runName,
      harness: leaf.harness,
      modelId: leaf.modelId,
      datasetKey: leaf.datasetKey,
      utteranceCount: leaf.utteranceCount,
      range: leaf.range!,
    }));
}

// -- Disk cache --

/**
 * Cached leaf facts, keyed by run directory and invalidated by `stt.json`'s size and
 * mtime.
 *
 * A cache and nothing more: every entry can be recomputed from the run directory, the
 * results tree stays the source of truth, and deleting the file only costs a rescan. It
 * exists because the cursor is consulted on every run and the archive only grows.
 */
const CACHE_VERSION = 2;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  facts: RunFacts;
}

interface CacheFile {
  version: number;
  runs: Record<string, CacheEntry>;
}

function cachePathFor(resultsBaseDir: string): string {
  return join(dirname(resultsBaseDir), ".cache", "results-scan.json");
}

function readCache(path: string): CacheFile {
  if (!existsSync(path)) return { version: CACHE_VERSION, runs: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    if (parsed?.version !== CACHE_VERSION || typeof parsed.runs !== "object") {
      return { version: CACHE_VERSION, runs: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, runs: {} };
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // A cache that cannot be written is a slower scan, not a failed run.
  }
}

export interface Coverage {
  index: CoverageIndex;
  /** Every dataset key seen in any run, so a model can be judged partial vs complete. */
  knownDatasetKeys: string[];
  runCount: number;
  /** Where each Benchmark Combination has got to in each dataset's ordered manifest. */
  cursors: CursorIndex;
}

export interface LoadCoverageOptions {
  /**
   * Default true. Set false to neither read nor write the scan cache - for tests, and for
   * anything that must observe the tree exactly as it is on disk.
   */
  cache?: boolean;
}

/**
 * Read every completed run's `stt.json`. Incomplete runs (checkpoint present, no
 * `stt.json`) contribute nothing; their results are not final, and a cursor taken from a
 * half-finished run would consume clips whose measurements were thrown away.
 */
export function loadCoverage(
  resultsBaseDir: string,
  options?: LoadCoverageOptions,
): Coverage {
  const index: CoverageIndex = {};
  const datasetKeys = new Set<string>();
  const ranges: RecordedRange[] = [];
  let runCount = 0;

  if (!existsSync(resultsBaseDir)) {
    return {
      index,
      knownDatasetKeys: [],
      runCount,
      cursors: emptyCursorIndex(),
    };
  }

  const useCache = options?.cache ?? true;
  const cachePath = cachePathFor(resultsBaseDir);
  const cache = useCache
    ? readCache(cachePath)
    : { version: CACHE_VERSION, runs: {} };
  const fresh: CacheFile = { version: CACHE_VERSION, runs: {} };
  let cacheChanged = false;

  for (const entry of readdirSync(resultsBaseDir).sort()) {
    if (!RUN_DIR_PATTERN.test(entry)) continue;
    const jsonPath = join(resultsBaseDir, entry, "stt.json");
    if (!existsSync(jsonPath)) continue;

    const stat = statSync(jsonPath);
    const cached = cache.runs[entry];
    let facts: RunFacts;
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      Array.isArray(cached.facts?.leaves)
    ) {
      facts = cached.facts;
    } else {
      let parsed: { librispeech?: unknown; fleurs?: unknown };
      try {
        parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
      } catch {
        continue;
      }
      facts = runFacts(entry, parsed);
      cacheChanged = true;
    }

    fresh.runs[entry] = { mtimeMs: stat.mtimeMs, size: stat.size, facts };
    runCount += 1;

    for (const key of facts.datasetKeys) datasetKeys.add(key);
    for (const leaf of facts.leaves) {
      if (leaf.utteranceCount > 0) {
        const byDataset = ((index[leaf.harness] ??= {})[leaf.modelId] ??= {});
        byDataset[leaf.datasetKey] = Math.max(
          byDataset[leaf.datasetKey] ?? 0,
          leaf.utteranceCount,
        );
      }
      if (leaf.range) {
        ranges.push({
          runName: entry,
          harness: leaf.harness,
          modelId: leaf.modelId,
          datasetKey: leaf.datasetKey,
          utteranceCount: leaf.utteranceCount,
          range: leaf.range,
        });
      }
    }
  }

  if (useCache) {
    const dropped = Object.keys(cache.runs).some((name) => !fresh.runs[name]);
    if (cacheChanged || dropped) writeCache(cachePath, fresh);
  }

  return {
    index,
    knownDatasetKeys: [...datasetKeys].sort(),
    runCount,
    cursors: foldRecordedRanges(ranges),
  };
}

export interface ModelCoverage {
  /** Dataset keys this Combination has results for, at any depth. */
  datasetKeys: string[];
  /** Shallowest run among those datasets - the depth the whole set is comparable at. */
  minSamples: number;
  /** True when some but not all known dataset keys are covered. */
  partial: boolean;
}

export function modelCoverage(
  coverage: Coverage,
  harness: BenchmarkHarnessLabel,
  modelId: string,
): ModelCoverage | null {
  const byDataset = coverage.index[harness]?.[modelId];
  if (!byDataset) return null;

  const datasetKeys = Object.keys(byDataset).sort();
  if (datasetKeys.length === 0) return null;

  return {
    datasetKeys,
    minSamples: Math.min(...datasetKeys.map((k) => byDataset[k])),
    partial: datasetKeys.length < coverage.knownDatasetKeys.length,
  };
}

/**
 * One-line coverage badge for a model row in the benchmark TUI.
 *
 * Two numbers, because they answer different questions and can legitimately disagree.
 * "measured" is how many utterances the deepest run scored; "cursor" is how far into the
 * ordered clip list the next session will start. A Combination measured 50 clips in the
 * three pre-d8b91ee LibriSpeech runs shows `measured 50, cursor 0`, which is the truth:
 * those clips were drawn in an ordering no offset survives, so the next session starts at
 * the beginning. See `scripts/backfill-sample-ranges.ts`.
 */
export function formatModelCoverage(
  coverage: Coverage,
  harness: BenchmarkHarnessLabel,
  modelId: string,
): string {
  const covered = modelCoverage(coverage, harness, modelId);
  if (!covered) return "- never";
  const suffix = covered.partial
    ? ` (${covered.datasetKeys.length}/${coverage.knownDatasetKeys.length} datasets)`
    : "";
  const minCursor = Math.min(
    ...covered.datasetKeys.map((datasetKey) =>
      deepestCursorForDataset(coverage.cursors, harness, modelId, datasetKey),
    ),
  );
  return `✓ measured ${covered.minSamples}, cursor ${minCursor}${suffix}`;
}

// -- The v2 scan: per-Sample records, and the cursor derived from them --

/**
 * File names inside a run's `_v2/` directory.
 *
 * Two files per Benchmark Combination and not one, because they have opposite
 * lifecycles. The plan is written once, before the first clip, and never touched again -
 * that immutability is the whole resume story, and a resumed process re-reads it rather
 * than rebuilding one from the current flags. The record is rewritten after **every**
 * scored clip. Keeping them in one file would mean rewriting the plan 400 times and
 * giving a crash 400 chances to corrupt it.
 */
export const V2_PLAN_SUFFIX = ".plan.json";
export const V2_RECORD_SUFFIX = ".run.json";

/** One Benchmark Combination's v2 files, as found on disk. */
export interface V2Stage {
  /** The run directory's name, which is also the Benchmark Run's identity. */
  runName: string;
  /** The Combination's id within the run: `<datasetKey>__<harnessBucket>__<modelId>`. */
  stageId: string;
  planPath: string;
  recordPath: string;
  /** `null` when the plan file is absent or unreadable. */
  plan: RunPlan | null;
  /** `null` when the record file is absent, unreadable, or not a v2 record. */
  record: RunRecordV2 | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Plans are validated by the contract's `isRunPlan`, not by a guard written here.
 *
 * There used to be a local `isRunPlanOnDisk` in this file, on the grounds that the
 * contract "never reads a file". That was the wrong grounds: the external harness reads
 * the same plans, so a local validator would have been the second of two hand-rolled
 * guards over one on-disk shape - which is the drift that produced defect 10. The
 * canonical one is also strictly stronger than the local one was, and every extra thing
 * it rejects is a plan that was unsafe to resume: a `fingerprintV2` that does not match
 * its own `orderedClipIds`, `toIndex - fromIndex` disagreeing with the clip count, a
 * duplicate clipId, a v1-shaped fingerprint, and a clip that is both warmed and scored.
 *
 * `isRunPlan` here, because a scan has to survive one bad file and report the rest.
 * `assertRunPlanOnDisk` on the resume path in `run-stt.ts`, where the plan is then
 * trusted completely and every complaint should be printed at once.
 */

/**
 * Every v2 stage under `benchmarks/results/`, complete and incomplete alike.
 *
 * Unfiltered on purpose: the two callers want opposite halves. Aggregation, coverage and
 * the production cursor want the **completed** records only - an incomplete run has not
 * been checked against its plan and its last checkpoint may predate its last clip - while
 * the overlap check that blocks a new run wants exactly the **incomplete** ones, by run
 * id, so it can name the run to resume or discard. Filtering here would have to guess
 * which caller it was serving.
 *
 * Not cached, unlike the v1 scan. The v1 cache is keyed by `stt.json`'s size and mtime,
 * which works because a completed run's file never changes again; a v2 record is rewritten
 * after every scored clip, so a cache would be stale for the whole duration of the run
 * that most needs to be read.
 */
export function loadV2Stages(resultsBaseDir: string): V2Stage[] {
  if (!existsSync(resultsBaseDir)) return [];

  const stages: V2Stage[] = [];
  for (const runName of readdirSync(resultsBaseDir).sort()) {
    if (!RUN_DIR_PATTERN.test(runName)) continue;
    const v2Dir = join(resultsBaseDir, runName, V2_RECORDS_DIRNAME);
    if (!existsSync(v2Dir)) continue;

    for (const fileName of readdirSync(v2Dir).sort()) {
      if (!fileName.endsWith(V2_RECORD_SUFFIX)) continue;
      const stageId = fileName.slice(0, -V2_RECORD_SUFFIX.length);
      const recordPath = join(v2Dir, fileName);
      const planPath = join(v2Dir, `${stageId}${V2_PLAN_SUFFIX}`);
      const planRaw = existsSync(planPath) ? readJson(planPath) : null;
      stages.push({
        runName,
        stageId,
        planPath,
        recordPath,
        plan: isRunPlan(planRaw) ? planRaw : null,
        record: parseRunRecordV2(readJson(recordPath)),
      });
    }
  }
  return stages;
}

/** The completed v2 records: the only ones that feed a cursor, a pool or a report. */
export function completedV2Records(stages: readonly V2Stage[]): RunRecordV2[] {
  return stages
    .map((stage) => stage.record)
    .filter((record): record is RunRecordV2 => isCompletedRunRecordV2(record));
}

/** An unfinished v2 stage, with everything the overlap refusal needs to name it. */
export interface IncompleteV2Stage extends V2Stage {
  plan: RunPlan;
  record: RunRecordV2;
}

/**
 * The unfinished v2 stages, i.e. the runs a new overlapping run must be blocked by.
 *
 * A stage counts as unfinished only when **both** its plan and its record parsed and the
 * record says `incomplete`. A stage whose plan is unreadable cannot be resumed and cannot
 * be described, so blocking a new run on it would leave the operator with an error and no
 * way out; it is reported separately by `unresumableV2Stages` instead.
 */
export function incompleteV2Stages(
  stages: readonly V2Stage[],
): IncompleteV2Stage[] {
  return stages.filter(
    (stage): stage is IncompleteV2Stage =>
      stage.plan !== null &&
      stage.record !== null &&
      stage.record.status === "incomplete",
  );
}

/** Stages on disk that can be neither resumed nor pooled, for a warning line. */
export function unresumableV2Stages(stages: readonly V2Stage[]): V2Stage[] {
  return stages.filter((stage) => stage.plan === null || stage.record === null);
}

/**
 * The three numbers a dataset's v2 coverage is described by, and which is which.
 *
 * Computed over the dataset's whole ordered consumable list rather than over one plan, so
 * it answers "how deep is this Combination" rather than "how far did that run get".
 */
export interface V2DatasetCoverage {
  /**
   * The **contiguous** measured prefix. The production cursor: the only number a
   * continuation starts from and the only one that may be published as a depth.
   */
  cursor: number;
  /**
   * One past the deepest measured clip, holes included. **Non-contiguous, not a cursor**,
   * and never a published depth. Exists because `cursor 397, maxMeasuredEnd 600` is the
   * signal that 103 clips are missing out of the middle.
   */
  maxMeasuredEnd: number;
  /** Pooled unique scored clips. Never a sum of slice sizes. */
  sampleCount: number;
}

/**
 * Where a Combination has got to in a dataset, from its pooled v2 Samples.
 *
 * The clip-set twin of `cursorFor` in `sample-cursor.ts`, which computes the same two
 * numbers from recorded `[start, end)` ranges. Both exist because both kinds of record
 * exist - v1 leaves carry offsets, v2 records carry clip ids - and they are asserted to
 * agree so neither can publish a depth the other cannot back up.
 */
export function v2DatasetCoverage(
  orderedConsumableClipIds: readonly string[],
  samples: readonly SampleMeasurementV2[],
): V2DatasetCoverage {
  const measured = new Set(
    samples.filter((sample) => !sample.isWarmup).map((sample) => sample.clipId),
  );
  return {
    cursor: contiguousCursor(orderedConsumableClipIds, measured),
    maxMeasuredEnd: maxMeasuredEnd(orderedConsumableClipIds, measured),
    sampleCount: pooledSampleCount(samples),
  };
}
