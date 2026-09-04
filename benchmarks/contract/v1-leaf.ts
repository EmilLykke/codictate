/**
 * The **v2-on-v1 leaf**: v2 pooled data written into the shape a v1 result file expects.
 *
 * Both harnesses publish through the v1 results tree, because the website, the reports and
 * the charts read that tree and none of them is being rewritten for v2. So both write a
 * v1-shaped leaf carrying v2 numbers - and this shape belonged to neither repository's
 * contract module, which is exactly how it diverged: Codictate wrote the pooled speed
 * summary as `speedV2`, the external harness wrote it as `speed`, nothing asserted the
 * name, and `benchmarks/stt/charts.py` read `speedV2`, missed it on every external row,
 * fell back to `meanRTF`, and plotted a differently-defined RTF **up to 28x the contract
 * value** against Codictate's. One missing string comparison, one published chart that was
 * wrong for one of the two products it existed to compare.
 *
 * Hence this module. The field name is pinned, the field set is pinned, each field's
 * meaning is written down, a guard enforces it, and
 * `fixtures/v2-on-v1-leaf.json` is a golden leaf both repositories assert against.
 *
 * The leaf is **open**: a repository may add fields of its own (Codictate writes
 * `peakRSS_MB`, which is meaningless for a foreign process). What is pinned is the shared
 * set below, and a consumer must treat anything else as optional.
 */

import type { SpeedSummary } from "./aggregation";

/**
 * The canonical field name for the pooled v2 speed summary on a v1-shaped leaf.
 *
 * **`speedV2`, in both repositories.** Version-scoped on purpose: a bare `speed` is the
 * name a v1 field would have had, so it invites a reader to treat it as one and it gives a
 * v3 nowhere to go. Exported as a constant so a writer can key off it and a test can
 * assert it, rather than three files each spelling it out.
 */
export const LEAF_SPEED_V2_FIELD = "speedV2";

/**
 * The Codictate-only inference diagnostic, as it appears on a leaf.
 *
 * The numerator and denominator travel with the rate for the same reason `referenceWords`
 * sits beside `wer`: a rate cannot be pooled without the denominator it was divided by,
 * and the only other duration on the leaf is `totalAudioSec`, which is a different set of
 * Samples. See `aggregation.ts::pooledInferenceRtf`.
 */
export interface LeafInferenceDiagnostic {
  /** `null` whenever no Sample reported `overhead.inferenceMs`. Never zero. */
  inferenceRtf: number | null;
  inferenceMs: number;
  inferenceAudioSec: number;
  inferenceSampleCount: number;
  inferenceSkippedCount: number;
}

/**
 * The pooled v2 speed summary as written under `speedV2`.
 *
 * `SpeedSummary` carries `responseMs` and `audioDurationSec` - the filtered numerator and
 * denominator behind `responseMsPerAudioSec` - and they are **required on a v2 leaf**.
 * They are what makes the v2 speed number poolable across leaves: a ratio cannot be
 * weighted, so a consumer combining conditions sums these two and divides once. Averaging
 * `responseMsPerAudioSec` or `wallRtf` across leaves is a mean of means.
 *
 * A leaf **without** them can only display its own per-condition `wallRtf`. It must not
 * contribute to a cross-condition pooled figure, and a consumer must **count and caption**
 * such leaves rather than invent a weight for them - `totalAudioSec` is the nearest thing
 * on the leaf and it covers a different, unfiltered set of Samples.
 */
export interface LeafSpeedV2 extends SpeedSummary, LeafInferenceDiagnostic {}

/**
 * The failure breakdown, when a harness has more than one way to fail.
 *
 * Nested under the pinned taxonomy: `timeout + failed === failures`, because `failures` is
 * the **total** unsuccessful count and `timeout` is a subset of it. The archive already
 * means this - a v1 leaf carries `"failures": 1` beside
 * `"failuresByStatus": {"timeout": 1, "failed": 0}`.
 */
export interface LeafFailuresByStatus {
  timeout: number;
  failed: number;
}

/** The `sampleRange` a single-run leaf may carry. See `benchmarks/stt/sample-cursor.ts`. */
export interface LeafSampleRange {
  startIndex: number;
  endIndex: number;
  manifestFingerprint: string;
}

/**
 * The pinned shared shape of a v1 leaf carrying v2 data.
 *
 * Required / optional / forbidden is decided per field below, and each decision is a
 * consumer that would otherwise get a different number from the two harnesses.
 */
export interface V2OnV1Leaf {
  /** `wordErrors / referenceWords`. Pooled, never a mean of per-clip rates. */
  wer: number;
  /**
   * **Required.** The denominator `wer` was divided by.
   *
   * Without it a consumer cannot re-pool this leaf with another, and an unweighted mean
   * of leaf rates is a different number from the accuracy of the combined sample.
   */
  referenceWords: number;
  /**
   * **Required on a v2 leaf**, and this is a parity fix rather than a preference.
   *
   * Codictate wrote it and the external harness did not, so `charts.py::_leaf_word_errors`
   * used an exact integer for one product and a derived float (`wer * referenceWords`) for
   * the other - two numerators of different kinds pooled into one published rate, with
   * float error accumulating on only one side of the comparison. Requiring it on every
   * new leaf leaves the derived-float path where it belongs: reading the archive, which
   * predates the field and can never be re-measured.
   */
  wordErrors: number;
  /** Optional as a set: absent for LibriSpeech, present for FLEURS. All three or none. */
  cer?: number;
  referenceChars?: number;
  charErrors?: number;
  /**
   * **Legacy, and unfiltered.** Session wall clock over audio, over **all** scored
   * Samples.
   *
   * `meanRTF`, `totalWallSec` and `totalAudioSec` keep their v1 meaning exactly. They are
   * the only speed numbers an archived leaf carries, and the archived values were computed
   * this way, so redefining them makes every new run incomparable to the archive it is
   * published beside - silently, because the field name does not change.
   *
   * In particular they are **not** filtered by `timing.ts::speedCompatible`. All
   * provenance-filtered v2 speed lives under `speedV2` and nowhere else.
   */
  meanRTF: number;
  /** Legacy, unfiltered. See `meanRTF`. */
  totalWallSec: number;
  /** Legacy, unfiltered. See `meanRTF`. */
  totalAudioSec: number;
  /** Scored utterances behind this leaf: pooled unique scored clips, never a sum of slices. */
  utteranceCount: number;
  /**
   * **Required.** Total unsuccessful scored utterances, **timeouts included**.
   *
   * `0` is a different claim from omitting the field: one says nothing failed, the other
   * says nobody counted. Only the archive may omit it.
   */
  failures: number;
  /**
   * **Optional**, and consistent when present: `timeout + failed === failures`.
   *
   * Not required, because Codictate has no timeout to report - a `TranscriptionResult` is
   * `ok` or `failed` and nothing else (`docs/adr/0006-dictation-returns-an-outcome.md`) -
   * so it would have to write `{ timeout: 0, failed: n }`, a zero that states a fact about
   * a type union rather than about the run and reads as "we never timed out". Not
   * forbidden either, because the external harness really does time out and suppressing
   * that breakdown would throw away the only place the distinction is recorded.
   */
  failuresByStatus?: LeafFailuresByStatus;
  /**
   * **Required on a v2 leaf.** The pooled v2 speed summary. See `LEAF_SPEED_V2_FIELD`.
   */
  speedV2: LeafSpeedV2;
  /**
   * **Optional, and absent on a leaf that pools more than one run.**
   *
   * A `sampleRange` is one `[startIndex, endIndex)` against one ordering. A pooled leaf
   * spans the ranges of every run behind it, so any single range on it would be a false
   * claim about which offsets it covers - and a cursor derived from that claim would skip
   * clips nobody transcribed. `assertV2OnV1Leaf` enforces the absence when it is told the
   * run count.
   */
  sampleRange?: LeafSampleRange;
}

/**
 * The publishable v2 wall-clock RTF for a leaf, or `null`.
 *
 * **Never falls back to `meanRTF`, and that is the whole reason this function exists.**
 * `charts.py` did exactly that fallback - `speed.get("wallRtf", r.get("meanRTF"))` - so an
 * external leaf that wrote its summary under the wrong key silently rendered a legacy,
 * differently-defined, unfiltered number in a v2 chart, at 2.8 against Codictate's 0.1.
 *
 * A missing `speedV2.wallRtf` means **"no publishable v2 speed"**. It does not mean "use
 * the legacy number": `meanRTF` is session wall clock over all scored Samples and
 * `speedV2.wallRtf` is the provenance-filtered response quotient. They answer different
 * questions and they are not interchangeable at any confidence level. A row with no v2
 * speed is drawn empty, or omitted, or labelled legacy - it is never quietly filled in.
 */
/**
 * The two numbers a leaf must carry for its speed to be poolable with another leaf's.
 *
 * `null` when the leaf cannot join a pooled figure. A consumer combining conditions sums
 * these across leaves and divides once, and counts and captions the leaves that returned
 * `null` rather than weighting them by something else.
 */
export function poolableSpeedTotals(leaf: {
  speedV2?: { responseMs?: number; audioDurationSec?: number } | null;
}): { responseMs: number; audioDurationSec: number } | null {
  const responseMs = leaf.speedV2?.responseMs;
  const audioDurationSec = leaf.speedV2?.audioDurationSec;
  return isFiniteNumber(responseMs) && isFiniteNumber(audioDurationSec)
    ? { responseMs, audioDurationSec }
    : null;
}

export function publishableWallRtf(leaf: {
  speedV2?: { wallRtf?: number | null } | null;
}): number | null {
  const wallRtf = leaf.speedV2?.wallRtf;
  return typeof wallRtf === "number" && Number.isFinite(wallRtf)
    ? wallRtf
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isSpeedSummaryShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const speed = value as Record<string, unknown>;
  const nullableRates = [
    "responseMsPerAudioSec",
    "wallRtf",
    "medianResponseMs",
    "p90ResponseMs",
    "inferenceRtf",
  ];
  const counts = [
    "attemptedCount",
    "respondedCount",
    "speedExcludedCount",
    "missingDurationCount",
    "failureCount",
    "timeoutCount",
    "sampleCount",
    "inferenceSampleCount",
    "inferenceSkippedCount",
  ];
  return (
    nullableRates.every((field) => isNullableFiniteNumber(speed[field])) &&
    counts.every((field) => Number.isInteger(speed[field])) &&
    // The poolable numerator and denominator. Required: without them this leaf's speed
    // cannot join a cross-condition pooled figure at all.
    isFiniteNumber(speed.responseMs) &&
    isFiniteNumber(speed.audioDurationSec) &&
    isFiniteNumber(speed.inferenceMs) &&
    isFiniteNumber(speed.inferenceAudioSec)
  );
}

/**
 * Whether a summary's rate agrees with the sums it is supposed to have come from.
 *
 * Cheap, and it is what keeps the pinned numerator and denominator honest: a writer that
 * accumulates its own totals beside the ratio - as the Codictate harness did, in a second
 * copy of the filtering - can drift from it, and then a per-leaf figure and a cross-leaf
 * pooled figure disagree with nothing on the leaf to say which is wrong.
 */
function rateAgreesWithSums(speed: Record<string, unknown>): string | null {
  const { responseMs, audioDurationSec, responseMsPerAudioSec, wallRtf } =
    speed;
  if (!isFiniteNumber(responseMs) || !isFiniteNumber(audioDurationSec)) {
    return null;
  }

  if (audioDurationSec <= 0) {
    return responseMsPerAudioSec === null
      ? null
      : `speedV2 has no poolable audio (${audioDurationSec} s) but responseMsPerAudioSec ` +
          `is ${responseMsPerAudioSec}; with nothing to divide by it must be null`;
  }
  if (!isFiniteNumber(responseMsPerAudioSec)) {
    return (
      `speedV2 has ${audioDurationSec} s of poolable audio but responseMsPerAudioSec is ` +
      `not a number`
    );
  }
  if (!isFiniteNumber(wallRtf)) {
    return `speedV2 has ${audioDurationSec} s of poolable audio but wallRtf is not a number`;
  }
  const implied = responseMs / audioDurationSec;
  if (Math.abs(implied - responseMsPerAudioSec) > 1e-6 * Math.max(1, implied)) {
    return (
      `speedV2 responseMs ${responseMs} over audioDurationSec ${audioDurationSec} implies ` +
      `${implied} ms/s but responseMsPerAudioSec says ${responseMsPerAudioSec}`
    );
  }
  if (Math.abs(wallRtf - responseMsPerAudioSec / 1000) > 1e-9) {
    return `speedV2 wallRtf ${wallRtf} is not responseMsPerAudioSec / 1000`;
  }
  return null;
}

/**
 * Everything wrong with a v2-on-v1 leaf, as a list of complaints. Empty means valid.
 *
 * Same device as `selection.ts::runPlanComplaints`, for the same reason: one
 * implementation behind a predicate and an assertion, and all the problems reported at
 * once.
 *
 * `runIds` is the number of runs pooled into the leaf. Supply it to get the
 * `sampleRange`-must-be-absent rule checked; without it that rule cannot be evaluated and
 * is skipped rather than guessed.
 */
export function v2OnV1LeafComplaints(
  value: unknown,
  context?: { pooledRunCount?: number },
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["it is not an object"];
  }
  const leaf = value as Record<string, unknown>;
  const complaints: string[] = [];

  for (const field of [
    "wer",
    "referenceWords",
    "wordErrors",
    "meanRTF",
    "totalWallSec",
    "totalAudioSec",
    "utteranceCount",
    "failures",
  ]) {
    if (!isFiniteNumber(leaf[field])) {
      complaints.push(`${field} must be a finite number`);
    }
  }
  for (const field of [
    "referenceWords",
    "wordErrors",
    "utteranceCount",
    "failures",
  ]) {
    if (
      isFiniteNumber(leaf[field]) &&
      (!Number.isInteger(leaf[field]) || leaf[field] < 0)
    ) {
      complaints.push(`${field} must be a non-negative integer`);
    }
  }

  // The rate and the counts have to agree, or the leaf cannot be re-pooled: a consumer
  // reading `wer` and a consumer reading `wordErrors / referenceWords` would publish two
  // different numbers off one leaf.
  if (
    isFiniteNumber(leaf.wer) &&
    isFiniteNumber(leaf.wordErrors) &&
    isFiniteNumber(leaf.referenceWords) &&
    leaf.referenceWords > 0
  ) {
    const impliedErrors = leaf.wer * leaf.referenceWords;
    if (
      Math.abs(impliedErrors - leaf.wordErrors) >
      1e-6 * Math.max(1, leaf.wordErrors)
    ) {
      complaints.push(
        `wer ${leaf.wer} over referenceWords ${leaf.referenceWords} implies ` +
          `${impliedErrors} word errors but wordErrors says ${leaf.wordErrors}`,
      );
    }
  }

  const cerFields = ["cer", "referenceChars", "charErrors"];
  const cerPresent = cerFields.filter((field) => leaf[field] !== undefined);
  if (cerPresent.length !== 0 && cerPresent.length !== cerFields.length) {
    complaints.push(
      `cer, referenceChars and charErrors are all present or all absent, got only ` +
        `${cerPresent.join(", ")}`,
    );
  }
  for (const field of ["referenceChars", "charErrors"]) {
    if (
      leaf[field] !== undefined &&
      isFiniteNumber(leaf[field]) &&
      (!Number.isInteger(leaf[field]) || leaf[field] < 0)
    ) {
      complaints.push(`${field} must be a non-negative integer`);
    }
  }

  if (leaf[LEAF_SPEED_V2_FIELD] === undefined) {
    complaints.push(
      `${LEAF_SPEED_V2_FIELD} is required on a v2 leaf. A summary written under any other ` +
        `name is invisible to every consumer, which is how an external row was plotted from ` +
        `meanRTF instead`,
    );
  } else if (!isSpeedSummaryShape(leaf[LEAF_SPEED_V2_FIELD])) {
    complaints.push(
      `${LEAF_SPEED_V2_FIELD} is not a complete pooled speed summary`,
    );
  } else {
    const disagreement = rateAgreesWithSums(
      leaf[LEAF_SPEED_V2_FIELD] as Record<string, unknown>,
    );
    if (disagreement !== null) complaints.push(disagreement);
  }
  if ("speed" in leaf) {
    complaints.push(
      `"speed" is not the field name for a pooled v2 summary - it is "${LEAF_SPEED_V2_FIELD}"`,
    );
  }

  const byStatus = leaf.failuresByStatus;
  if (byStatus !== undefined) {
    if (!byStatus || typeof byStatus !== "object") {
      complaints.push("failuresByStatus must be an object when present");
    } else {
      const breakdown = byStatus as Record<string, unknown>;
      const statuses = ["timeout", "failed"];
      if (!statuses.every((status) => Number.isInteger(breakdown[status]))) {
        complaints.push(
          "failuresByStatus needs integer timeout and failed counts",
        );
      } else if (
        isFiniteNumber(leaf.failures) &&
        (breakdown.timeout as number) + (breakdown.failed as number) !==
          leaf.failures
      ) {
        // Nested, not disjoint: `failures` is the total and `timeout` is a subset.
        complaints.push(
          `failuresByStatus sums to ` +
            `${(breakdown.timeout as number) + (breakdown.failed as number)} but failures ` +
            `says ${leaf.failures}; failures is the total including timeouts`,
        );
      }
    }
  }

  if (leaf.sampleRange !== undefined) {
    const range = leaf.sampleRange as Record<string, unknown>;
    if (
      !range ||
      typeof range !== "object" ||
      !Number.isInteger(range.startIndex) ||
      !Number.isInteger(range.endIndex) ||
      typeof range.manifestFingerprint !== "string"
    ) {
      complaints.push(
        "sampleRange must be { startIndex, endIndex, manifestFingerprint }",
      );
    }
    if ((context?.pooledRunCount ?? 1) > 1) {
      complaints.push(
        `sampleRange must be absent on a leaf pooling ${context?.pooledRunCount} runs: one ` +
          `range cannot describe several, and a cursor derived from it would claim clips ` +
          `nobody transcribed`,
      );
    }
  }

  return complaints;
}

export function isV2OnV1Leaf(
  value: unknown,
  context?: { pooledRunCount?: number },
): value is V2OnV1Leaf {
  return v2OnV1LeafComplaints(value, context).length === 0;
}

/** Refuses a malformed v2-on-v1 leaf, naming everything wrong with it. */
export function assertV2OnV1Leaf(
  value: unknown,
  context?: { pooledRunCount?: number; label?: string },
): asserts value is V2OnV1Leaf {
  const complaints = v2OnV1LeafComplaints(value, context);
  if (complaints.length > 0) {
    const subject = context?.label ?? "v2-on-v1 leaf";
    throw new Error(
      `${subject} does not match the published leaf contract: ${complaints.join("; ")}. ` +
        `See docs/BENCHMARK_CONTRACT.md - both harnesses write this shape and every ` +
        `consumer reads it.`,
    );
  }
}

/**
 * The v1 fingerprint formats, for the record: there are **two** and they do not compare.
 *
 * Codictate writes `<count>:<first 16 hex of sha256>`
 * (`benchmarks/stt/sample-cursor.ts::manifestFingerprint`, e.g. `3:efdb04c4041c2ba1`); the
 * external harness writes `sha256:<64 hex>` (e.g. `sha256:966cacb8b651...`). Both are
 * legacy ordering tokens, both stay readable, and neither may ever be compared to the
 * other or to a v2 `fingerprintV2`. Recorded here because a comment asserting a single v1
 * format is how someone eventually writes the comparison.
 */
export const V1_FINGERPRINT_FORMATS = {
  codictate: "<count>:<16 hex>",
  wisprFlow: "sha256:<64 hex>",
} as const;
