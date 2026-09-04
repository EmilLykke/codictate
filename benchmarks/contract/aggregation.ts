/**
 * Pooling: turning many Benchmark Runs over overlapping clip sets into one number per
 * bucket, without counting a clip twice and without averaging averages.
 *
 * v1 could not do this. Its leaves are aggregates - a rate, a denominator, a count -
 * so two runs of the same Combination could only be compared by depth, and
 * `--aggregate` resolved them by keeping the deeper one and discarding the other
 * entirely (`benchmarks/README.md`, "depth wins over recency"). That is the right call
 * for aggregate leaves and it throws away real measurements. With a `clipId` per Sample
 * the resolution becomes per clip: disjoint runs union, an overlapping rerun replaces
 * only the clips it re-measured, and the earlier run's other clips survive.
 *
 * Two rules from `benchmarks/stt/results-schema.ts` carry over unchanged, because they
 * are about honesty rather than about v1:
 *
 * - A leaf with no denominator is **skipped**, never treated as zero. A missing
 *   `referenceWords` means "this measurement cannot be pooled", and folding it in as
 *   zero errors over zero words is a perfect score for a clip nobody scored.
 * - A missing count means **not counted**, not zero. `failures` was the field that
 *   could never be backfilled, and the same applies to a `responseMs` that is absent
 *   on a Sample whose status says it succeeded.
 *
 * Pure. The caller loads the records.
 */

import { uniqueInOrder } from "./clip-identity";
import {
  isScoredSample,
  SCHEMA_VERSION,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "./schema";
import {
  responseMsPerAudioSec,
  speedCompatible,
  wallRtfFromResponseRatio,
} from "./timing";

// -- Compatibility buckets --

/**
 * The identity of a *series* of measurements: `(schemaVersion, harness, model,
 * datasetId)`.
 *
 * Pooling **buckets** by this key. It is not a uniqueness guard on `clipId`, and the
 * first cut of this module got that backwards: a `clipId` is dataset-scoped and
 * deliberately **not** harness- or model-scoped, so Wispr Flow and Codictate
 * `large-v3-q5_0` both measure `fleurs/da_dk/audio/test/12149430079508542992.wav`.
 * That is the entire point of the publication batch - the same clips through both
 * products - so treating a second measurement of one clip as a conflict made the
 * pooled read fail on exactly the data this project exists to produce.
 *
 * Within a bucket, one measurement of a clip supersedes another and that is the
 * ordinary rerun case. Across buckets nothing competes: two products measuring one clip
 * are two facts, and there is no sense in which one is newer than the other.
 *
 * `datasetId` is in the key even though a clipId already carries its corpus
 * (`fleurs/da_dk/...`), so a mislabelled record separates into its own bucket rather
 * than silently joining the wrong series.
 */
export function compatibilityKey(run: {
  schemaVersion: number;
  harness: string;
  model: string;
  datasetId: string;
}): string {
  return `v${run.schemaVersion}|${run.harness}|${run.model}|${run.datasetId}`;
}

/** Why a run contributed nothing to any bucket. */
export type PoolSkipReason = "incomplete" | "schema" | "no-scored-samples";

export interface SkippedRun {
  runId: string;
  reason: PoolSkipReason;
}

/** A pooled Sample, tagged with the run that won it. */
export interface PooledSample extends SampleMeasurementV2 {
  /** The run whose measurement of this clip survived pooling. */
  runId: string;
  /** Recency this measurement was ranked by: `completedAt ?? startedAt`. */
  measuredAt: string;
}

/** One clip whose measurement was superseded inside a bucket. */
export interface ReplacedSample {
  clipId: string;
  keptRunId: string;
  droppedRunId: string;
}

/**
 * One compatibility bucket: every clip one (schemaVersion, harness, model, dataset)
 * series has been measured on, once each.
 *
 * The identity fields are spelled out beside the key so a caller can select buckets -
 * "every dataset of this model", "both harnesses on this dataset" - without parsing the
 * key string back apart.
 */
export interface PoolBucket {
  /** `compatibilityKey`. Buckets are returned sorted by it. */
  key: string;
  schemaVersion: number;
  harness: string;
  model: string;
  datasetId: string;
  /** One Sample per unique scored clip, sorted by `clipId`. */
  samples: readonly PooledSample[];
  /** Supersessions inside this bucket, in the order they were resolved. */
  replaced: readonly ReplacedSample[];
  /** Completed runs that contributed to this bucket, sorted by run id. */
  runIds: readonly string[];
}

export interface PoolResult {
  /** One per compatibility bucket, sorted by `key`. Nothing competes across them. */
  buckets: readonly PoolBucket[];
  /** Runs that contributed nothing, and why. */
  skippedRuns: readonly SkippedRun[];
}

/** `completedAt ?? startedAt`: the instant a pooled measurement is ranked by. */
function measuredAt(run: RunRecordV2): string {
  return run.completedAt ?? run.startedAt;
}

/**
 * Which of two measurements of one clip *in the same bucket* wins.
 *
 * Newest by `completedAt ?? startedAt`, then the lexicographically greater `runId`.
 * The tiebreak is not a preference, it is determinism: two runs finishing inside the
 * same millisecond must pool to the same answer on every machine that reads them, or
 * two readers publish two numbers from one archive. Codictate run ids start with a
 * sortable timestamp, so the string comparison is also chronological in practice.
 */
function winsOver(
  candidate: { measuredAt: string; runId: string },
  incumbent: { measuredAt: string; runId: string },
): boolean {
  if (candidate.measuredAt !== incumbent.measuredAt) {
    const candidateMs = Date.parse(candidate.measuredAt);
    const incumbentMs = Date.parse(incumbent.measuredAt);
    if (candidateMs !== incumbentMs) return candidateMs > incumbentMs;
  }
  return candidate.runId > incumbent.runId;
}

interface BucketAccumulator {
  bucket: Omit<PoolBucket, "samples" | "replaced" | "runIds">;
  winners: Map<string, PooledSample>;
  replaced: ReplacedSample[];
  runIds: Set<string>;
}

/**
 * Pool per-Sample measurements into compatibility buckets, keyed inside each bucket by
 * `clipId`.
 *
 * - **Incomplete runs contribute nothing.** Not "contribute their finished clips":
 *   nothing. An unfinished run has not been checked against its plan, its last
 *   checkpoint may predate its last clip, and it is a resume source rather than a
 *   measurement. This is the rule that keeps an interrupted run out of the cursor, out
 *   of coverage and out of publication.
 * - **Warmups contribute nothing**, so the same three clips are not scored once per
 *   session.
 * - **Non-v2 records contribute nothing.** A v1 aggregate leaf has no per-clip
 *   measurements to pool and inventing them is forbidden.
 *
 * Never throws on a clip measured twice. Inside one bucket that is a rerun and the
 * newest wins; across buckets the two measurements live in different buckets and both
 * survive.
 *
 * Samples inside a bucket come back sorted by `clipId`, because a pool has no plan
 * order: it spans runs with different orderings, and any order derived from the inputs
 * would change with the read order of a directory. Order comes from a Run Plan; sums do
 * not need one. Buckets come back sorted by `key` for the same reason.
 */
export function poolSamples(runs: readonly RunRecordV2[]): PoolResult {
  const skippedRuns: SkippedRun[] = [];
  const accumulators = new Map<string, BucketAccumulator>();

  for (const run of runs) {
    if (run.schemaVersion !== SCHEMA_VERSION) {
      skippedRuns.push({ runId: run.runId, reason: "schema" });
      continue;
    }
    if (run.status !== "completed") {
      skippedRuns.push({ runId: run.runId, reason: "incomplete" });
      continue;
    }

    const scored = run.samples.filter(isScoredSample);
    if (scored.length === 0) {
      skippedRuns.push({ runId: run.runId, reason: "no-scored-samples" });
      continue;
    }

    const key = compatibilityKey(run);
    const at = measuredAt(run);
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = {
        bucket: {
          key,
          schemaVersion: run.schemaVersion,
          harness: run.harness,
          model: run.model,
          datasetId: run.datasetId,
        },
        winners: new Map(),
        replaced: [],
        runIds: new Set(),
      };
      accumulators.set(key, accumulator);
    }
    accumulator.runIds.add(run.runId);

    for (const sample of scored) {
      const candidate: PooledSample = {
        ...sample,
        runId: run.runId,
        measuredAt: at,
      };
      const incumbent = accumulator.winners.get(sample.clipId);
      if (!incumbent) {
        accumulator.winners.set(sample.clipId, candidate);
        continue;
      }
      if (winsOver(candidate, incumbent)) {
        accumulator.winners.set(sample.clipId, candidate);
        accumulator.replaced.push({
          clipId: sample.clipId,
          keptRunId: candidate.runId,
          droppedRunId: incumbent.runId,
        });
      } else {
        accumulator.replaced.push({
          clipId: sample.clipId,
          keptRunId: incumbent.runId,
          droppedRunId: candidate.runId,
        });
      }
    }
  }

  const buckets: PoolBucket[] = [...accumulators.values()]
    .map((accumulator) => ({
      ...accumulator.bucket,
      samples: [...accumulator.winners.values()].sort(byClipId),
      replaced: accumulator.replaced,
      runIds: [...accumulator.runIds].sort(),
    }))
    .sort((a, b) => compareStrings(a.key, b.key));

  return { buckets, skippedRuns };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byClipId(a: PooledSample, b: PooledSample): number {
  return compareStrings(a.clipId, b.clipId);
}

/**
 * Every pooled Sample of one (harness, model) series, across all of its dataset
 * buckets.
 *
 * The cross-dataset accuracy path: pooled WER over `da_dk` plus `hu_hu` for one Speech
 * Model is `pooledWer(seriesSamples(result, series))`, which sums the buckets' error
 * counts and reference counts rather than averaging their rates. Flattening is safe
 * here and only here, because a clipId carries its corpus - two dataset buckets of one
 * series cannot name the same clip - whereas flattening across harnesses or models
 * would put two measurements of one clip in one list and count it twice.
 */
export function seriesSamples(
  result: PoolResult,
  series: { harness: string; model: string },
): PooledSample[] {
  return result.buckets
    .filter(
      (bucket) =>
        bucket.harness === series.harness && bucket.model === series.model,
    )
    .flatMap((bucket) => [...bucket.samples]);
}

/** The pooled unique scored clips a bucket covers. Never a sum of slice sizes. */
export function pooledSampleCount(
  samples: readonly SampleMeasurementV2[],
): number {
  return uniqueInOrder(
    samples.filter(isScoredSample).map((sample) => sample.clipId),
  ).length;
}

// -- Accuracy --

/**
 * The two numbers an accuracy pool needs from a leaf, both optional on read.
 *
 * Optional because the archive is append-only: the runs written before
 * `referenceWords` existed have no denominator on disk and can never be re-measured,
 * so a reader has to load them and skip them rather than throw. A v2
 * `SampleMeasurementV2` satisfies this type with every field present.
 */
export interface AccuracyLeafV2 {
  wordErrors?: number | null;
  referenceWords?: number | null;
  charErrors?: number | null;
  referenceChars?: number | null;
}

/**
 * A pooled rate, with the arithmetic that produced it and the leaves it could not use.
 *
 * The counts are returned rather than just the rate for the same reason
 * `benchmarks/README.md` gives for storing `referenceWords`: `errors` is a whole
 * number, so a published rate is checkable by eye. `skippedCount` is returned because a
 * pooled rate over half the leaves is a different claim from one over all of them, and
 * a caller that cannot see the skips will report the first as the second.
 */
export interface PooledAccuracy {
  /** `errors / references`, or `null` when no leaf carried a denominator. */
  rate: number | null;
  errors: number;
  references: number;
  /** Leaves that contributed. */
  leafCount: number;
  /** Leaves skipped for want of a denominator or an error count. */
  skippedCount: number;
}

function pooledRate(
  leaves: readonly AccuracyLeafV2[],
  errorsOf: (leaf: AccuracyLeafV2) => number | null | undefined,
  referencesOf: (leaf: AccuracyLeafV2) => number | null | undefined,
): PooledAccuracy {
  let errors = 0;
  let references = 0;
  let leafCount = 0;
  let skippedCount = 0;

  for (const leaf of leaves) {
    const leafErrors = errorsOf(leaf);
    const leafReferences = referencesOf(leaf);
    // Both halves required. A denominator with no numerator is as unusable as the
    // reverse, and defaulting either to zero is the "perfect score for a clip nobody
    // scored" failure this whole module is built to refuse.
    if (
      typeof leafErrors !== "number" ||
      typeof leafReferences !== "number" ||
      !Number.isFinite(leafErrors) ||
      !Number.isFinite(leafReferences) ||
      !Number.isInteger(leafErrors) ||
      !Number.isInteger(leafReferences) ||
      leafErrors < 0 ||
      leafReferences < 0
    ) {
      skippedCount++;
      continue;
    }
    errors += leafErrors;
    references += leafReferences;
    leafCount++;
  }

  return {
    rate: references > 0 ? errors / references : null,
    errors,
    references,
    leafCount,
    skippedCount,
  };
}

/**
 * `sum(wordErrors) / sum(referenceWords)` over the pooled clips.
 *
 * The only accuracy number that may be published for a combined sample. A mean of
 * per-dataset WERs is a different number - it weights a 908-clip Spanish pool the same
 * as a 5-clip smoke slice - and `benchmarks/contract/aggregation.test.ts` pins a
 * deliberately unbalanced two-dataset fixture where the two disagree, so a regression
 * to means-of-means fails a test rather than shipping a wrong leaderboard.
 *
 * Takes leaves rather than runs so cross-dataset pooling happens **above** the
 * compatibility buckets: hand it `seriesSamples(result, series)` and the denominators
 * add up across datasets by construction.
 */
export function pooledWer(leaves: readonly AccuracyLeafV2[]): PooledAccuracy {
  return pooledRate(
    leaves,
    (leaf) => leaf.wordErrors,
    (leaf) => leaf.referenceWords,
  );
}

/** `sum(charErrors) / sum(referenceChars)`. Same rule, same skips. */
export function pooledCer(leaves: readonly AccuracyLeafV2[]): PooledAccuracy {
  return pooledRate(
    leaves,
    (leaf) => leaf.charErrors,
    (leaf) => leaf.referenceChars,
  );
}

// -- Speed --

/**
 * Nearest-rank percentile of a sorted-ascending copy of `values`.
 *
 * Nearest-rank rather than interpolated, and pinned here rather than left to a chart
 * library: p90 is published, both repositories must produce the same one, and
 * interpolation between two neighbours invents a response time no clip had.
 *
 * `null` for an empty list, never `0`. Zero is the fastest possible response.
 */
export function percentileNearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(percentile * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/**
 * The median: the middle value, or the mean of the two middle values for an even count.
 *
 * Spelled out because the external harness has to match it and "median" has two
 * conventions for an even count. `null` for an empty list.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** p90, nearest-rank on the sorted successful responses. */
export function p90(values: readonly number[]): number | null {
  return percentileNearestRank(values, 0.9);
}

/**
 * Everything a published speed cell needs, per pooled bucket.
 *
 * The counts are not decoration. `respondedCount < attemptedCount` is the whole story
 * behind a good-looking ratio: only successful Samples are in the numerator and the
 * denominator, so a product that times out on its ten slowest clips would otherwise
 * post a faster number than one that answered all of them. The counts are what make
 * that visible, and they are the reason a missing `failures` field in v1 had to read
 * as "not counted" rather than as zero.
 *
 * **`failureCount` is every unsuccessful Sample, timeouts included, and `timeoutCount`
 * is the subset of those that timed out.** Nested rather than disjoint, because that is
 * what the v1 archive already means: a leaf carries `"failures": 1` beside
 * `"failuresByStatus": {"timeout": 1, "failed": 0}`, so reading the two as disjoint
 * would silently change the meaning of every archived `failures` number. The invariant
 * `attemptedCount === respondedCount + failureCount` holds by construction and is
 * asserted in the tests.
 *
 * `speedExcludedCount` and `missingDurationCount` are separate from all of that, and
 * separate from each other. Both name a Sample that **responded** - it is in
 * `respondedCount` and it is not a failure - and cannot be pooled for speed anyway, but
 * for two unrelated reasons, and conflating them would hide whichever is the real problem:
 *
 * - `speedExcludedCount`: the record does not prove which clock and which key edge
 *   produced the `responseMs`. A provenance problem. See `timing.ts::speedCompatible`.
 * - `missingDurationCount`: the Sample has no usable `audioDurationSec`, so it has no
 *   denominator. A corpus problem - `estimateWavDurationSec` in
 *   `benchmarks/scripts/build-manifests.ts` returns `?? 0` for a WAV whose header it
 *   cannot parse, `hydrateDurations` keeps that zero, and `isSampleMeasurementV2` accepts
 *   it, so a zero reaches here as an ordinary-looking number.
 *
 * The ratio, the median and the p90 are all computed over
 * `respondedCount - speedExcludedCount - missingDurationCount` Samples, and both fields
 * are here so that shortfall is visible rather than inferred from a suspiciously round
 * number.
 */
export interface SpeedSummary {
  /** `sum(successful responseMs) / sum(successful audioDurationSec)`. */
  responseMsPerAudioSec: number | null;
  /**
   * The ratio's **numerator**: milliseconds of response, summed over the Samples that
   * survived both filters.
   *
   * On the summary beside the rate because **a ratio is not a weightable quantity**. A
   * consumer pooling several leaves - overall accuracy across `da_dk` and `hu_hu`, say -
   * has to sum these two and divide; averaging `responseMsPerAudioSec` or `wallRtf`
   * across leaves is a mean of means, which is defect 9's error class one level up on the
   * speed axis. Without the numerator and the denominator there is no honest way to do it,
   * and the only durations otherwise on a leaf (`totalAudioSec`) cover a *different*,
   * unfiltered set of Samples.
   *
   * This is the identical argument `pooledInferenceRtf` already makes for returning
   * `inferenceMs` and `audioDurationSec`, and the one `benchmarks/README.md` makes for
   * storing `referenceWords` beside `wer`. The contract was inconsistent with itself until
   * these two were pinned.
   *
   * Filtered, not raw: these are the accumulators behind `responseMsPerAudioSec`, so
   * provenance-incompatible and no-denominator Samples are already out of both.
   */
  responseMs: number;
  /** The ratio's **denominator**: seconds of audio behind `responseMs`. See above. */
  audioDurationSec: number;
  /**
   * Published wall-clock RTF: `responseMsPerAudioSec / 1000`.
   *
   * Derived rather than measured, and carried in the summary so the report and the
   * charts cannot each derive their own. `benchmarks/stt/charts.py` arithmetically
   * averaged per-dataset RTFs, which is a mean of means on the speed axis.
   */
  wallRtf: number | null;
  /** Raw response ms, successful only. */
  medianResponseMs: number | null;
  /** Raw response ms, successful only, nearest-rank. */
  p90ResponseMs: number | null;
  /** Scored Samples in the pool, whatever their status. */
  attemptedCount: number;
  /**
   * Successful Samples: `status: "ok"` with a numeric `responseMs`.
   *
   * Counted whatever their timing provenance - responding is a fact about the product,
   * and provenance is a fact about our instrumentation. Keeping the two apart is what
   * lets `attemptedCount === respondedCount + failureCount` stay true while a legacy
   * Sample is still kept out of the ratio.
   */
  respondedCount: number;
  /**
   * Responded Samples excluded from the ratio, the median and the p90 by
   * `timing.ts::speedCompatible` - a **provenance** problem.
   *
   * Not a failure and not an attempt that went missing.
   */
  speedExcludedCount: number;
  /**
   * Responded, provenance-clean Samples excluded because they have no usable
   * `audioDurationSec` - a **denominator** problem.
   *
   * Kept apart from `speedExcludedCount` because the two say different things about what
   * is wrong and want different fixes: one is re-instrumenting the harness, the other is
   * re-converting a WAV. A single "excluded" number would hide whichever one is happening.
   */
  missingDurationCount: number;
  /** Every unsuccessful Sample, **timeouts included**. */
  failureCount: number;
  /** The timed-out subset of `failureCount`. */
  timeoutCount: number;
  /** Pooled unique scored clips. Never a sum of slice sizes. */
  sampleCount: number;
}

/**
 * A `responseMs` that can be added to a numerator: finite and not negative.
 *
 * `typeof x === "number"` is not this check. It admits `NaN`, `Infinity` and negatives,
 * all three of which reach a pooled sum and none of which announces itself.
 */
function isUsableResponseMs(responseMs: number | null): responseMs is number {
  return (
    typeof responseMs === "number" &&
    Number.isFinite(responseMs) &&
    responseMs >= 0
  );
}

/**
 * An `audioDurationSec` that can be added to a denominator: finite and strictly positive.
 *
 * Strictly positive, because zero is the value a WAV with an unreadable header produces
 * (`estimateWavDurationSecFromBytes` returns `?? 0`) and it is indistinguishable from a
 * real measurement once it is in a sum. Matches the guard `pooledInferenceRtf` already
 * applies.
 */
function isUsableDurationSec(audioDurationSec: number): boolean {
  return Number.isFinite(audioDurationSec) && audioDurationSec > 0;
}

/**
 * Pool speed over already-pooled Samples.
 *
 * Warmups are dropped first. Failures and timeouts are counted and contribute to no
 * numerator and no denominator: their `responseMs` is `null`, and treating it as zero
 * would price a failure as an instant transcription.
 *
 * A `status: "ok"` Sample whose `responseMs` is not a **finite, non-negative number** is
 * malformed rather than fast: `null`, `NaN`, `Infinity` and a negative are all treated as
 * "did not respond". Each of the three was reachable and none was loud. `NaN` propagates
 * through the sum and turns the whole bucket's ratio into `NaN`, which then serialises to
 * `null` and simply removes the bar from a chart. A negative acts as a **discount** on
 * every other clip in the bucket - one `-900 ms` Sample beside one honest `1000 ms / 10 s`
 * Sample moved the ratio from 100 to 5 ms/s, which is the same *optimistic* error
 * direction as the Flow start-timestamp bug this contract exists to remove.
 * `responseMsFromWindow` already refuses a negative window at measurement time; a record
 * read back off disk never went through it, so the check has to exist on both sides.
 * Malformed Samples are excluded from `respondedCount` and therefore land in
 * `failureCount` - which is defined as everything that did not respond, so the invariant
 * holds without another counter.
 *
 * Two further skips apply to Samples that *did* respond, in this precedence, so that no
 * Sample is counted twice and both repositories count identically:
 *
 * 1. **Provenance** (`speedExcludedCount`): the record cannot prove which clock and key
 *    edge produced the number, so the number cannot be trusted whatever its denominator.
 * 2. **Denominator** (`missingDurationCount`): `audioDurationSec` is absent, zero,
 *    negative or non-finite. This is the module's own "missing denominator means skip,
 *    never zero" rule, which speed was the one place not to honour: a zero
 *    `audioDurationSec` used to add its `responseMs` to the numerator and nothing to the
 *    denominator, silently inflating ms-per-audio-second - 100 to 600 ms/s on a two-Sample
 *    bucket - with no counter to show it had happened.
 *
 * Both skips apply to the **median and p90 list as well as the ratio**, so every speed
 * number in the summary describes the same set of Samples. A raw latency needs no
 * denominator and could technically survive skip 2, but a bucket whose median and ratio
 * covered different Samples is exactly the quiet divergence this contract exists to
 * prevent - and a clip whose WAV header will not parse is a clip whose audio may be
 * truncated, which makes its latency suspect too.
 *
 * The boundary is otherwise exact, and it is the whole point of the filtering:
 * **speed numerator, denominator and raw list only.** `attemptedCount`, `sampleCount` and
 * every accuracy number are computed over the unfiltered scored set, because none of these
 * defects moved a transcript.
 *
 * `wallRtf` is derived from the **filtered** ratio, which is the subtle way this could
 * have leaked: deriving it from an unfiltered sum would republish the excluded Samples'
 * optimism under a different field name.
 */
export function pooledSpeed(
  samples: readonly SampleMeasurementV2[],
): SpeedSummary {
  const scored = samples.filter(isScoredSample);

  let totalResponseMs = 0;
  let totalAudioDurationSec = 0;
  let timeoutCount = 0;
  let respondedCount = 0;
  let speedExcludedCount = 0;
  let missingDurationCount = 0;
  const poolableResponseMs: number[] = [];

  for (const sample of scored) {
    if (sample.status === "timeout") {
      timeoutCount++;
      continue;
    }
    if (sample.status === "failed") continue;
    if (!isUsableResponseMs(sample.responseMs)) continue;

    // It responded. Whether we may pool its response is a separate question.
    respondedCount++;
    if (!speedCompatible(sample)) {
      speedExcludedCount++;
      continue;
    }
    if (!isUsableDurationSec(sample.audioDurationSec)) {
      missingDurationCount++;
      continue;
    }

    poolableResponseMs.push(sample.responseMs);
    totalResponseMs += sample.responseMs;
    totalAudioDurationSec += sample.audioDurationSec;
  }

  const ratio = responseMsPerAudioSec(totalResponseMs, totalAudioDurationSec);

  return {
    responseMsPerAudioSec: ratio,
    responseMs: totalResponseMs,
    audioDurationSec: totalAudioDurationSec,
    wallRtf: wallRtfFromResponseRatio(ratio),
    medianResponseMs: median(poolableResponseMs),
    p90ResponseMs: p90(poolableResponseMs),
    attemptedCount: scored.length,
    respondedCount,
    speedExcludedCount,
    missingDurationCount,
    // Total unsuccessful, timeouts included. See the type's doc comment.
    failureCount: scored.length - respondedCount,
    timeoutCount,
    sampleCount: pooledSampleCount(scored),
  };
}

/**
 * The Codictate-only inference RTF, pooled. **A secondary diagnostic.**
 *
 * `(sum(overhead.inferenceMs) / 1000) / sum(audioDurationSec)` over the Samples that
 * carry the field. It measures the Speech Engine's own compute and excludes everything
 * around it, so it is **not comparable to any Wispr Flow number** - a UI-observed paste
 * has no inference boundary to measure. Never publish it as the headline speed and
 * never put it in the same column as `wallRtf`.
 *
 * Samples with no `overhead.inferenceMs` are **skipped**, not counted as zero: the
 * field is mandated for Codictate v2 records, so an absent one means the record predates
 * the mandate or the Harness did not report it, and zero inference time is not a fact
 * about anything. `skippedCount` is returned so a caller can see how thin the diagnostic
 * is.
 */
export interface PooledInferenceRtf {
  /** `(inferenceMs / 1000) / audioDurationSec`, or `null` when nothing contributed. */
  rtf: number | null;
  inferenceMs: number;
  audioDurationSec: number;
  /** Samples that contributed. */
  leafCount: number;
  /** Samples skipped for want of `overhead.inferenceMs` or a duration. */
  skippedCount: number;
}

export function pooledInferenceRtf(
  samples: readonly SampleMeasurementV2[],
): PooledInferenceRtf {
  let inferenceMs = 0;
  let audioDurationSec = 0;
  let leafCount = 0;
  let skippedCount = 0;

  for (const sample of samples) {
    if (!isScoredSample(sample)) continue;
    const reported = sample.overhead?.inferenceMs;
    if (
      typeof reported !== "number" ||
      !Number.isFinite(reported) ||
      !(sample.audioDurationSec > 0)
    ) {
      skippedCount++;
      continue;
    }
    inferenceMs += reported;
    audioDurationSec += sample.audioDurationSec;
    leafCount++;
  }

  return {
    rtf: audioDurationSec > 0 ? inferenceMs / 1000 / audioDurationSec : null,
    inferenceMs,
    audioDurationSec,
    leafCount,
    skippedCount,
  };
}
