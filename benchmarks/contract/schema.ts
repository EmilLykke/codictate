/**
 * The benchmark-v2 record: per-Sample measurements, the run they belong to, and the
 * fingerprint that says which clips a Run Plan named.
 *
 * v1 wrote one aggregate leaf per Benchmark Combination - a rate, a denominator, a
 * count and a `sampleRange` offset. v2 keeps every leaf v1 wrote (they are immutable
 * legacy snapshots and can never be re-measured, see `benchmarks/stt/results-schema.ts`)
 * and adds the thing v1 has no way to reconstruct: **which clip produced which number**.
 * A v1 aggregate leaf must never be re-read as v2 per-clip measurements - there is no
 * inverse - so the two shapes are separate types with separate version markers rather
 * than one optional-heavy union.
 *
 * The only import here is `node:crypto`, for sha256. No filesystem, no clock, no
 * globals: this module is the cross-repository contract, and
 * `dictation-product-benchmark` has to be able to load it - or copy it - and get
 * byte-identical answers.
 */

import { createHash } from "node:crypto";
import { uniqueInOrder } from "./clip-identity";
import { isMeasuringHarness, type MeasuringHarness } from "./harness";
import type { TimingRegime } from "./timing";

/**
 * The record format version. Bumped to 2 by per-Sample measurements.
 *
 * A reader dispatches on this before it reads anything else: a file without it is v1
 * and is read by the v1 path. Never inferred from the presence of a field.
 */
export const SCHEMA_VERSION = 2 as const;

/**
 * The fingerprint algorithm version, and the first line of every fingerprint payload.
 *
 * In the payload rather than beside it so the digest itself changes if the algorithm
 * ever does: a v3 fingerprint over the same clips cannot collide with a v2 one, which
 * is what stops a stale expected value from silently passing a parity test.
 */
export const FINGERPRINT_VERSION = "benchmark-v2" as const;

/**
 * The fingerprint of a Run Plan's ordered clip selection.
 *
 * sha256 over `FINGERPRINT_VERSION` followed by the de-duplicated clipIds, one per
 * line, no trailing newline, truncated to the first 16 lowercase hex characters. Every
 * one of those choices is load-bearing for parity and none of them may be "improved":
 *
 * - **Newline-joined plain text, not JSON.** Two JSON serialisers agree on the value
 *   and not on the bytes (key order, escaping, whitespace), and the fingerprint is
 *   compared across two repositories.
 * - **No sorting.** Plan order is what the fingerprint identifies. `["b","a"]` and
 *   `["a","b"]` are different plans measuring the same clips in a different sequence,
 *   and the golden fixtures assert they fingerprint differently.
 * - **De-duplicated first occurrence.** A plan is asserted duplicate-free
 *   (`assertUniqueClipIds`), so `uniqueInOrder` here is not a repair - it is what makes
 *   a fingerprint recomputed from a pooled clip set equal the plan's fingerprint.
 * - **16 hex characters.** This is an equality token, not a signature. It is read aloud
 *   in error messages and pasted between two repositories, and the same truncation is
 *   already the convention in `benchmarks/stt/sample-cursor.ts::manifestFingerprint`.
 *
 * Distinct from the v1 `manifestFingerprint`, which covers a dataset's *whole ordered pool
 * including the reserved warmups* and answers "do my stored integer offsets still index
 * into this list". This one covers *the clips one plan measures* and answers "did these
 * two runs measure the same clips in the same order".
 *
 * **There are two mutually incomparable v1 formats, not one.** Codictate writes
 * `<count>:<first 16 hex of sha256>` (`benchmarks/stt/sample-cursor.ts`, e.g.
 * `3:efdb04c4041c2ba1`); `dictation-product-benchmark` writes `sha256:<64 hex>` (e.g.
 * `sha256:966cacb8b651...`). Both are legacy ordering tokens for their own repository's
 * manifests and both stay readable forever. No v1 token is ever compared to the other
 * repository's v1 token, and neither is ever compared to a v2 fingerprint - which is why
 * v2 lives under a differently named field carrying its own version string. See
 * `v1-leaf.ts::V1_FINGERPRINT_FORMATS`.
 */
export function fingerprintV2(clipIds: readonly string[]): string {
  const payload = [FINGERPRINT_VERSION, ...uniqueInOrder(clipIds)].join("\n");
  return createHash("sha256")
    .update(payload, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * The on-disk shape of a v2 fingerprint. **Both repositories write exactly this.**
 *
 * ```json
 * "fingerprintV2": { "version": "benchmark-v2", "value": "d28f996584b02f28" }
 * ```
 *
 * The field name and the embedded `version` are belt and braces, and each catches a
 * different mistake:
 *
 * - The **field name** `fingerprintV2` is never `fingerprint`, so a v1 record's
 *   `manifestFingerprint` and a v2 record's fingerprint cannot land in the same slot.
 *   A reader that knows only v1 sees a field it does not read; a reader that wants v2
 *   asks for a field a v1 file does not have and gets `undefined` instead of a
 *   `<count>:<hex>` string it would then compare as equal-to-nothing.
 * - The embedded **`version`** travels with the value. A fingerprint is passed around
 *   detached from its record - inside a Run Plan, in an error message, in a stage
 *   report - and a bare 16-hex string carries no clue which algorithm produced it.
 *
 * A v3 gets a new field name *and* a new version string. Never re-point this one.
 */
export interface FingerprintV2 {
  version: typeof FINGERPRINT_VERSION;
  /** 16 lowercase hex characters. */
  value: string;
}

/** The fingerprint of these clipIds, in the shape that goes on disk. */
export function fingerprintV2Record(clipIds: readonly string[]): FingerprintV2 {
  return { version: FINGERPRINT_VERSION, value: fingerprintV2(clipIds) };
}

const HEX_16 = /^[0-9a-f]{16}$/;

export function isFingerprintV2(value: unknown): value is FingerprintV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FingerprintV2>;
  return (
    candidate.version === FINGERPRINT_VERSION &&
    typeof candidate.value === "string" &&
    HEX_16.test(candidate.value)
  );
}

/** Whether a fingerprint matches these clipIds. Version-checked, never coerced. */
export function fingerprintV2Matches(
  fingerprint: unknown,
  clipIds: readonly string[],
): boolean {
  return (
    isFingerprintV2(fingerprint) && fingerprint.value === fingerprintV2(clipIds)
  );
}

// -- Per-Sample measurements --

/**
 * What happened when the Harness was asked for this clip.
 *
 * Three states, not two, because a timeout and a refusal are different facts about the
 * product under test and only one of them is a bug in the harness. Both are excluded
 * from every speed and accuracy numerator and both are counted, which is the rule v1
 * could not express: an archived leaf with no `failures` field means "not counted", and
 * reporting that as zero is what this union exists to prevent.
 */
export const SAMPLE_STATUSES = ["ok", "timeout", "failed"] as const;

export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export function isSampleStatus(value: unknown): value is SampleStatus {
  return (
    typeof value === "string" &&
    (SAMPLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Harness-specific overhead, kept out of `responseMs` and recorded beside it.
 *
 * A slot rather than a field per product, because the two Harnesses measure different
 * things and neither should have to carry the other's nulls. Wispr Flow records the
 * UI-observed extras its regime creates (`stabilityDelayMs`, `pollIntervalMs`,
 * `observation`, the paste-detection mode); Codictate records the inference wall time
 * that backs its secondary diagnostic RTF. Nothing in here is ever an input to a
 * published metric - `responseMs` is the metric, and anything that would change it
 * belongs inside or outside the timing window, not in a side channel. See
 * `timing.ts` for the two regimes.
 */
export interface SampleOverheadV2 {
  /**
   * The Speech Engine's own compute time for this clip, in milliseconds.
   *
   * **Mandated for Codictate v2 records.** It is the denominator-free half of the
   * Codictate-only inference RTF (`aggregation.ts::pooledInferenceRtf`), which is a
   * secondary diagnostic and is never comparable to a Wispr Flow number - a UI-observed
   * paste has no inference boundary to measure. It is deliberately *not* `responseMs`:
   * the published metric is the adapter call boundary, and this is what happened inside
   * it.
   *
   * `null` or absent means the Harness did not report it, and a Sample that does not
   * report it is **skipped** by the diagnostic rather than counted as zero inference.
   */
  inferenceMs?: number | null;
  /**
   * Which instrumentation took this Sample's `responseMs`. **Mandated on every v2
   * Sample, by both Harnesses.**
   *
   * It is the discriminator `timing.ts::speedCompatible` needs, and the reason it has to
   * be on the record rather than inferred from the Harness name: the rule for a
   * UI-observed Sample is stricter than the rule for a direct-adapter one, and a
   * predicate that guessed the regime from `harness` would be wrong the first time
   * either repository grows a second measuring mode. An **absent** value is treated as
   * speed-incompatible, deliberately - see `speedCompatible`.
   */
  timingRegime?: TimingRegime | null;
  /**
   * Which key edge the UI-observed `startedAt` was taken on: `"keydown"`, or the name of
   * whatever else it was.
   *
   * Required to be `"keydown"` for a `ui-observed-paste` Sample to enter pooled speed.
   * Anything else - notably a timestamp taken after `post(hotkey)` returned - excluded
   * the modifier-to-key sleep and reads ~81-90 ms optimistic per clip. Meaningless for
   * `direct-adapter`, which has no hotkey, and absent there rather than faked.
   */
  hotkeyEdge?: string | null;
  /**
   * Which clock the window's two timestamps came from: `"monotonic"`, or the name of
   * whatever else it was.
   *
   * Required to be `"monotonic"` for a `ui-observed-paste` Sample to enter pooled speed.
   * A wall clock can step sideways mid-window, and the resulting `responseMs` is not
   * wrong in a way anything downstream can detect.
   */
  timingClock?: string | null;
  [field: string]: number | string | boolean | null | undefined;
}

/**
 * One clip, measured once.
 *
 * Error *counts* rather than rates, and denominators rather than nothing: pooling is
 * `sum(errors) / sum(references)` and a rate cannot be pooled without the denominator
 * it was divided by. `benchmarks/README.md` already says an unweighted mean of
 * per-dataset WERs is a different number and must never be published; storing counts
 * per clip is what makes the pooled number the only one that is cheap to compute.
 */
export interface SampleMeasurementV2 {
  /** Canonical identity. See `clip-identity.ts`. */
  clipId: string;
  /**
   * FLEURS TSV column 0. Metadata: several clips share one `sentenceId`, so it is
   * never identity, never a dedup key and never a fingerprint input.
   */
  sentenceId?: string;
  /** Denominator of every speed metric. Seconds of audio in the clip. */
  audioDurationSec: number;
  /**
   * The measured response, or `null` when there was nothing to measure.
   *
   * `null` on a failure or a timeout, and `null` is not zero: a zero here would be a
   * free transcription in the pooled ratio. A `status: "ok"` Sample with a `null`
   * `responseMs` is malformed and is excluded from the ratio *and* from
   * `respondedCount`, for the same reason a leaf with no denominator is skipped.
   *
   * `NaN`, `Infinity` and negative values are malformed in exactly the same way and are
   * treated identically by `isSuccessfulSample` and `pooledSpeed`. The type guard still
   * *accepts* them onto a record, deliberately: one bad Sample must not make a whole run
   * unreadable, so it loads and the pooling skips it and counts it.
   */
  responseMs: number | null;
  status: SampleStatus;
  /** Word-level edit distance to the reference. A whole number. */
  wordErrors: number;
  /** Reference word count: the denominator `wordErrors` is scored against. */
  referenceWords: number;
  /** Character-level edit distance to the reference. A whole number. */
  charErrors: number;
  /** Reference character count. */
  referenceChars: number;
  /**
   * A replayed warmup rather than a measured Sample.
   *
   * Recorded rather than dropped, so a resumed run can prove it warmed the model, and
   * excluded from `sampleCount`, from aggregation and from the completed-scored-clip
   * set. The exclusion has to be explicit in both directions: completed-ID filtering
   * that removed warmups would stop them replaying, and pooling that kept them would
   * score the same three clips in every session of every run.
   */
  isWarmup: boolean;
  /** Harness-specific overhead. Never an input to a published metric. */
  overhead?: SampleOverheadV2;
  /** The engine's own words on a failure. For logs, never for a metric. */
  failureDiagnostic?: string;
}

export function isSampleMeasurementV2(
  value: unknown,
): value is SampleMeasurementV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SampleMeasurementV2>;
  return (
    typeof candidate.clipId === "string" &&
    candidate.clipId.length > 0 &&
    typeof candidate.audioDurationSec === "number" &&
    (candidate.responseMs === null ||
      typeof candidate.responseMs === "number") &&
    isSampleStatus(candidate.status) &&
    typeof candidate.wordErrors === "number" &&
    typeof candidate.referenceWords === "number" &&
    typeof candidate.charErrors === "number" &&
    typeof candidate.referenceChars === "number" &&
    typeof candidate.isWarmup === "boolean" &&
    (candidate.sentenceId === undefined ||
      typeof candidate.sentenceId === "string")
  );
}

/** A Sample that counts: measured, not a replayed warmup. */
export function isScoredSample(sample: SampleMeasurementV2): boolean {
  return !sample.isWarmup;
}

/**
 * A Sample that contributes to speed: it succeeded and it has a number.
 *
 * The only samples in any speed numerator. Failures and timeouts contribute to
 * `attemptedCount`, `failureCount` and `timeoutCount` and to nothing else.
 */
export function isSuccessfulSample(sample: SampleMeasurementV2): boolean {
  return (
    !sample.isWarmup &&
    sample.status === "ok" &&
    typeof sample.responseMs === "number" &&
    Number.isFinite(sample.responseMs) &&
    sample.responseMs >= 0
  );
}

// -- The run record --

/**
 * Whether the process that wrote this record finished the plan it was given.
 *
 * Explicit on the record and never inferred from "does it have as many samples as the
 * plan asked for", because the two answers differ in the one case that matters: a run
 * killed after its last clip but before it wrote its footer has every Sample and is
 * still not a completed run. **Only `completed` runs feed the production cursor,
 * aggregation, coverage, staging or publication.** An `incomplete` record is a resume
 * source and nothing else.
 */
export const RUN_STATUSES = ["completed", "incomplete"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: unknown): value is RunStatus {
  return (
    typeof value === "string" &&
    (RUN_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The plan a run record points back at: everything needed to say *what was selected*,
 * without the plan's clip list.
 *
 * The full ordered list lives in the plan file (`selection.ts::RunPlan`); the record
 * carries the reference plus the fingerprint, which is what makes "did these two runs
 * measure the same thing" a string comparison rather than a list diff.
 */
export interface RunPlanRefV2 {
  runId: string;
  batchId?: string;
  datasetId: string;
  /** First selected index into the dataset's ordered consumable list, inclusive. */
  fromIndex: number;
  /** One past the last selected index. */
  toIndex: number;
  /** Scored clips the plan names. `toIndex - fromIndex`. */
  clipCount: number;
  fingerprintV2: FingerprintV2;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * One Benchmark Run, as written to disk.
 *
 * **The on-disk shape both repositories write.** The external harness serialises the
 * same field names with the same meanings, so a pooling reader loads either without a
 * per-repository adapter:
 *
 * ```json
 * {
 *   "schemaVersion": 2,
 *   "runId": "2026-09-04_08-17-28_v2-da-first-400",
 *   "status": "completed",
 *   "startedAt": "2026-09-04T08:17:28.000Z",
 *   "completedAt": "2026-09-04T09:02:11.000Z",
 *   "harness": "codictate",
 *   "model": "large-v3-turbo-q5_0",
 *   "datasetId": "fleurs/da_dk",
 *   "plan": { "runId": "...", "datasetId": "fleurs/da_dk", "fromIndex": 0,
 *             "toIndex": 400, "clipCount": 400,
 *             "fingerprintV2": { "version": "benchmark-v2", "value": "d28f996584b02f28" },
 *             "createdAt": "2026-09-04T08:17:20.000Z" },
 *   "fingerprintV2": { "version": "benchmark-v2", "value": "d28f996584b02f28" },
 *   "samples": [ { "clipId": "fleurs/da_dk/audio/test/1214...wav", "...": "..." } ]
 * }
 * ```
 *
 * `fingerprintV2` is repeated at the top level rather than only inside `plan`, because
 * compatibility is checked on every pooled record and a reader should not have to
 * reach through a nested plan reference to do it. `assertRunRecordAgreesWithPlan`
 * below is the guard that keeps the copy honest.
 */
export interface RunRecordV2 {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  status: RunStatus;
  /** ISO 8601, set before the first clip. */
  startedAt: string;
  /** ISO 8601, set when the plan is finished. `null` while `status` is incomplete. */
  completedAt: string | null;
  /**
   * Which **Measuring Harness** produced this record. A closed union, not a string.
   *
   * Not the ASR Harness that executes a Speech Engine inside Codictate - see
   * `harness.ts` for why the two senses must not be assignable to each other.
   */
  harness: MeasuringHarness;
  /** The Speech Model or the product under test. */
  model: string;
  /** `fleurs/da_dk`, `librispeech/test-clean`, ... */
  datasetId: string;
  plan: RunPlanRefV2;
  fingerprintV2: FingerprintV2;
  samples: SampleMeasurementV2[];
  batchId?: string;
  /** Free-text run note. Rendered, never parsed. */
  description?: string;
}

export function isRunPlanRefV2(value: unknown): value is RunPlanRefV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunPlanRefV2>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.datasetId === "string" &&
    typeof candidate.fromIndex === "number" &&
    typeof candidate.toIndex === "number" &&
    typeof candidate.clipCount === "number" &&
    typeof candidate.createdAt === "string" &&
    isFingerprintV2(candidate.fingerprintV2)
  );
}

/**
 * Whether an unknown value read off disk is a v2 run record.
 *
 * Checks `schemaVersion` first, so a v1 file is rejected on its first field instead of
 * failing later on a missing `samples` array. A v1 file is not a broken v2 file and
 * must not be reported as one.
 */
export function isRunRecordV2(value: unknown): value is RunRecordV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunRecordV2>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.runId === "string" &&
    isRunStatus(candidate.status) &&
    typeof candidate.startedAt === "string" &&
    (candidate.completedAt === null ||
      typeof candidate.completedAt === "string") &&
    isMeasuringHarness(candidate.harness) &&
    typeof candidate.model === "string" &&
    typeof candidate.datasetId === "string" &&
    isRunPlanRefV2(candidate.plan) &&
    isFingerprintV2(candidate.fingerprintV2) &&
    Array.isArray(candidate.samples) &&
    candidate.samples.every(isSampleMeasurementV2)
  );
}

/**
 * The on-disk key for the record format version: **`schemaVersion`**, camelCase, matching
 * the archive's style. The exported constant is `SCHEMA_VERSION`.
 */
export const SCHEMA_VERSION_KEY = "schemaVersion";

/**
 * The one alias a reader may accept, and only through `normalizeRunRecordV2`.
 *
 * A record written with the *constant's* name as its key is legible to a human and
 * invisible to `isRunRecordV2`, which is the dangerous combination: the guard rejects it,
 * the reader logs nothing, and the run vanishes from pooling while still sitting on disk.
 * So the alias is normalised on ingest - before the guard, never after - and never
 * written.
 */
const SCHEMA_VERSION_KEY_ALIAS = "SCHEMA_VERSION";

/**
 * Rewrite the accepted schema-version alias to the canonical key, on ingest.
 *
 * Returns the value unchanged when there is nothing to normalise, so it is safe to put in
 * front of every read. Never the other way round: `schemaVersion` wins if both keys are
 * present, and the alias is dropped rather than kept, so a normalised record cannot
 * round-trip the alias back to disk.
 */
export function normalizeRunRecordV2(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!(SCHEMA_VERSION_KEY_ALIAS in record)) return raw;

  const { [SCHEMA_VERSION_KEY_ALIAS]: aliased, ...rest } = record;
  return {
    ...rest,
    [SCHEMA_VERSION_KEY]: rest[SCHEMA_VERSION_KEY] ?? aliased,
  };
}

/** A completed v2 run: the only kind that feeds a cursor, a pool or a publication. */
export function isCompletedRunRecordV2(value: unknown): value is RunRecordV2 {
  return isRunRecordV2(value) && value.status === "completed";
}

/**
 * Refuses a record whose top-level fingerprint or run id disagrees with its own plan
 * reference.
 *
 * The duplication is for the reader's convenience and this is the price of it. A
 * mismatch means the record was assembled from two different plans, and pooling it
 * would attribute one plan's clips to another plan's selection.
 */
export function assertRunRecordAgreesWithPlan(record: RunRecordV2): void {
  if (record.plan.runId !== record.runId) {
    throw new Error(
      `Run ${record.runId} carries a plan reference for ${record.plan.runId}.`,
    );
  }
  if (record.plan.fingerprintV2.value !== record.fingerprintV2.value) {
    throw new Error(
      `Run ${record.runId} has fingerprint ${record.fingerprintV2.value} but its plan says ` +
        `${record.plan.fingerprintV2.value}. One of the two was copied from another plan.`,
    );
  }
  if (record.status === "completed" && record.completedAt === null) {
    throw new Error(
      `Run ${record.runId} is marked completed with no completedAt. Recency in pooling is ` +
        `taken from completedAt, so a completed run without one cannot be ordered.`,
    );
  }
}
