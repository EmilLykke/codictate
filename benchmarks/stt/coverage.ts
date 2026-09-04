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
  type BenchmarkHarnessLabel,
} from "./results-schema";
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
