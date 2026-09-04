/**
 * Reading v2 run records, and pooling them into the leaves a report renders.
 *
 * The v1 read path has its own coverage in `sample-cursor.test.ts` and
 * `results-archive.manual.ts` and is untouched here. What is new is the resolution rule:
 * v1 could only keep the deeper of two leaves and discard the other run entirely, because
 * a rate and a count have no clips to intersect. With a Sample per clip the resolution is
 * per clip - disjoint runs union, an overlapping rerun replaces only the clipIds it
 * re-measured - and every failure mode of getting that wrong is a plausible number:
 * double-counted clips inflate a denominator, a dropped run silently shallows a depth,
 * and an incomplete run contributing "the clips it did finish" publishes a measurement
 * nobody checked against a plan.
 */

import { describe, expect, test } from "bun:test";
import {
  parseRunRecordV2,
  pooledV2Leaves,
  v1DatasetLocation,
  V2_RECORDS_DIRNAME,
  CODICTATE_V2_HARNESS,
  assertSingleRunnableAsrHarness,
} from "./results-schema";
import { CODICTATE_TIMING_REGIME } from "./runner";
import {
  buildRunPlan,
  fingerprintV2Record,
  runPlanRef,
  SCHEMA_VERSION,
  type RunPlan,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "../contract";

/** `count` distinct Danish clipIds, in a stable order. */
function clipIds(count: number, offset = 0): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `fleurs/da_dk/audio/test/1${String(i + offset).padStart(18, "0")}.wav`,
  );
}

const POOL = clipIds(1_000);

function planFor(from: number, to: number, runId: string): RunPlan {
  return buildRunPlan({
    runId,
    datasetId: "fleurs/da_dk",
    harness: CODICTATE_V2_HARNESS,
    model: "large-v3-turbo-q5_0",
    consumableClipIds: POOL,
    warmupClipIds: [],
    fromIndex: from,
    toIndex: to,
    createdAt: "2026-09-04T08:00:00.000Z",
  });
}

function sampleOf(
  clipId: string,
  overrides: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  return {
    clipId,
    audioDurationSec: 5,
    responseMs: 1_000,
    status: "ok",
    wordErrors: 1,
    referenceWords: 10,
    charErrors: 2,
    referenceChars: 50,
    isWarmup: false,
    overhead: { timingRegime: CODICTATE_TIMING_REGIME, inferenceMs: null },
    ...overrides,
  };
}

function recordFor(
  plan: RunPlan,
  options: {
    status?: "completed" | "incomplete";
    completedAt?: string | null;
    startedAt?: string;
    sample?: (clipId: string, index: number) => SampleMeasurementV2;
    clipIds?: readonly string[];
  } = {},
): RunRecordV2 {
  const status = options.status ?? "completed";
  const source = options.clipIds ?? plan.orderedClipIds;
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    status,
    startedAt: options.startedAt ?? "2026-09-04T08:00:00.000Z",
    completedAt:
      options.completedAt ??
      (status === "completed" ? "2026-09-04T09:00:00.000Z" : null),
    harness: CODICTATE_V2_HARNESS,
    model: plan.model,
    datasetId: plan.datasetId,
    plan: runPlanRef(plan),
    fingerprintV2: plan.fingerprintV2,
    samples: source.map(
      (clipId, index) => options.sample?.(clipId, index) ?? sampleOf(clipId),
    ),
  };
}

describe("v1DatasetLocation", () => {
  test("a contract datasetId names the corpus and the key", () => {
    expect(v1DatasetLocation("fleurs/da_dk")).toEqual({
      field: "fleurs",
      datasetKey: "da_dk",
    });
    expect(v1DatasetLocation("librispeech/test-clean")).toEqual({
      field: "librispeech",
      datasetKey: "test-clean",
    });
  });

  test("an unknown corpus is refused rather than guessed", () => {
    // Guessing is how a FLEURS locale ends up filed as a LibriSpeech split and rendered
    // under the wrong condition label - and CER is scored for one corpus and not the
    // other, so the guess changes a published number.
    expect(v1DatasetLocation("commonvoice/da")).toBeNull();
    expect(v1DatasetLocation("da_dk")).toBeNull();
    expect(v1DatasetLocation("fleurs/")).toBeNull();
  });
});

describe("parseRunRecordV2", () => {
  test("a v1 result file reads as 'not a v2 record', not as a broken one", () => {
    // A v1 `stt.json` is not a damaged v2 record and must not be reported as one: the
    // archive is full of them and every one of them still loads through the v1 path.
    expect(
      parseRunRecordV2({
        description: "main model comparison",
        librispeech: {},
        fleurs: {},
      }),
    ).toBeNull();
    expect(parseRunRecordV2(null)).toBeNull();
    expect(parseRunRecordV2([])).toBeNull();
  });

  test("a record written with the aliased schema key is normalised on ingest", () => {
    // The alias is accepted and then dropped, in front of the type guard. Reading it
    // afterwards is what makes an aliased record pass nothing and vanish from pooling
    // without a word.
    const plan = planFor(0, 2, "run-a/da_dk__crispasr__m");
    const record = recordFor(plan) as unknown as Record<string, unknown>;
    delete record.schemaVersion;
    record.SCHEMA_VERSION = SCHEMA_VERSION;

    const parsed = parseRunRecordV2(record);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(SCHEMA_VERSION);
    expect("SCHEMA_VERSION" in parsed!).toBe(false);
  });

  test("a v2 record whose fingerprint contradicts its plan is loud, not skipped", () => {
    const plan = planFor(0, 2, "run-a/da_dk__crispasr__m");
    const corrupted = {
      ...recordFor(plan),
      fingerprintV2: fingerprintV2Record(["fleurs/da_dk/audio/test/other.wav"]),
    };
    // Skipping it would drop a measurement in silence; the mismatch means the record was
    // assembled from two different plans, and pooling it would attribute one plan's clips
    // to another plan's selection.
    expect(() => parseRunRecordV2(corrupted)).toThrow(/plan says/);
  });
});

describe("pooledV2Leaves", () => {
  test("disjoint continuations pool into one leaf, without double counting", () => {
    // Acceptance gate 5, first half, and the exact case defect 2 got wrong: `[0, 400)`
    // then `[400, 800)` used to leave a single 400-Sample leaf under a `sampleSize` of
    // 800. Pooled, it is 800 clips with 800 Samples behind them.
    const first = recordFor(planFor(0, 400, "run-a/da_dk__crispasr__m"));
    const second = recordFor(planFor(400, 800, "run-b/da_dk__crispasr__m"), {
      startedAt: "2026-09-05T08:00:00.000Z",
      completedAt: "2026-09-05T09:00:00.000Z",
    });

    const pooled = pooledV2Leaves([first, second]);
    expect(pooled.leaves).toHaveLength(1);
    const [leaf] = pooled.leaves;
    expect(leaf.sampleCount).toBe(800);
    expect(leaf.runIds).toHaveLength(2);
    expect(leaf.replacedCount).toBe(0);
    // 800 clips at 10 reference words each. 400 + 400, not 400 twice and not 1600.
    expect(leaf.leaf.referenceWords).toBe(8_000);
    expect(leaf.leaf.wordErrors).toBe(800);
    expect(leaf.leaf.utteranceCount).toBe(800);
  });

  test("an overlapping rerun replaces only the clips it re-measured", () => {
    // Acceptance gate 5, second half, and gate 7. The earlier run's non-overlapping clips
    // survive - which is the thing v1 could not do at all, because `--aggregate` had to
    // keep one whole leaf and discard the other.
    const first = recordFor(planFor(0, 400, "run-a/da_dk__crispasr__m"));
    const rerun = recordFor(planFor(200, 300, "run-b/da_dk__crispasr__m"), {
      startedAt: "2026-09-05T08:00:00.000Z",
      completedAt: "2026-09-05T09:00:00.000Z",
      // The rerun measures the same clips and gets a different answer.
      sample: (clipId) => sampleOf(clipId, { wordErrors: 5 }),
    });

    const pooled = pooledV2Leaves([first, rerun]);
    const [leaf] = pooled.leaves;

    // 400 clips, not 500: the 100 re-measured clips are the same clips.
    expect(leaf.sampleCount).toBe(400);
    expect(leaf.replacedCount).toBe(100);
    expect(leaf.leaf.referenceWords).toBe(4_000);
    // 300 clips at 1 error from the first run, 100 at 5 from the rerun.
    expect(leaf.leaf.wordErrors).toBe(300 * 1 + 100 * 5);
  });

  test("an incomplete run contributes nothing, not even the clips it finished", () => {
    // Acceptance gate 3, at the pooling level. An unfinished run has not been checked
    // against its plan and its last checkpoint may predate its last clip, so it is a
    // resume source and not a measurement.
    const finished = recordFor(planFor(0, 100, "run-a/da_dk__crispasr__m"));
    const interrupted = recordFor(
      planFor(100, 500, "run-b/da_dk__crispasr__m"),
      {
        status: "incomplete",
        clipIds: POOL.slice(100, 250),
      },
    );

    const pooled = pooledV2Leaves([finished, interrupted]);
    expect(pooled.leaves[0].sampleCount).toBe(100);
    expect(pooled.skippedRuns).toEqual([
      { runId: "run-b/da_dk__crispasr__m", reason: "incomplete" },
    ]);
  });

  test("warmups are in no leaf, however many sessions replayed them", () => {
    const plan = planFor(0, 10, "run-a/da_dk__crispasr__m");
    const withWarmups: RunRecordV2 = {
      ...recordFor(plan),
      samples: [
        // Three warmups replayed twice, as two resumed sessions would record them.
        ...clipIds(3, 5_000).flatMap((clipId) => [
          sampleOf(clipId, { isWarmup: true }),
          sampleOf(clipId, { isWarmup: true }),
        ]),
        ...plan.orderedClipIds.map((clipId) => sampleOf(clipId)),
      ],
    };

    const [leaf] = pooledV2Leaves([withWarmups]).leaves;
    expect(leaf.sampleCount).toBe(10);
    expect(leaf.leaf.referenceWords).toBe(100);
  });

  test("two products measuring one clip land in two buckets, not in one fight", () => {
    // `clipId` is dataset-scoped and not model- or harness-scoped, and the whole point of
    // a publication batch is measuring the same clips with both products. A pool that
    // refused that case would fail on its first read.
    const codictate = recordFor(planFor(0, 10, "run-a/da_dk__crispasr__m"));
    const otherModel: RunRecordV2 = {
      ...recordFor(planFor(0, 10, "run-b/da_dk__crispasr__other")),
      model: "small-q5_1",
      samples: POOL.slice(0, 10).map((clipId) =>
        sampleOf(clipId, { wordErrors: 3 }),
      ),
    };

    const pooled = pooledV2Leaves([codictate, otherModel]);
    expect(pooled.leaves).toHaveLength(2);
    expect(pooled.leaves.map((leaf) => leaf.modelId).sort()).toEqual([
      "large-v3-turbo-q5_0",
      "small-q5_1",
    ]);
    for (const leaf of pooled.leaves) expect(leaf.sampleCount).toBe(10);
  });

  test("a bucket whose corpus this repository does not store is reported, not filed", () => {
    const foreign: RunRecordV2 = {
      ...recordFor(planFor(0, 5, "run-a/x__crispasr__m")),
      datasetId: "commonvoice/da",
    };
    const pooled = pooledV2Leaves([foreign]);
    expect(pooled.leaves).toHaveLength(0);
    expect(pooled.unplaceableBuckets).toHaveLength(1);
  });

  test("CER is pooled for FLEURS and absent for LibriSpeech", () => {
    // LibriSpeech reference transcripts are already normalised upper-case ASCII, so a
    // character rate over them measures nothing - the same rule the runner applies.
    const fleurs = recordFor(planFor(0, 10, "run-a/da_dk__crispasr__m"));
    const libri: RunRecordV2 = {
      ...recordFor(planFor(0, 10, "run-b/test-clean__crispasr__m")),
      datasetId: "librispeech/test-clean",
    };

    const leaves = pooledV2Leaves([fleurs, libri]).leaves;
    const fleursLeaf = leaves.find((leaf) => leaf.field === "fleurs")!;
    const libriLeaf = leaves.find((leaf) => leaf.field === "librispeech")!;
    expect(fleursLeaf.leaf.cer).toBeCloseTo(2 / 50, 12);
    expect(libriLeaf.leaf.cer).toBeUndefined();
  });

  test("a pooled leaf carries no sampleRange, so it feeds no cursor", () => {
    // A pooled leaf spans the ranges of every run behind it, and there is no single
    // `[startIndex, endIndex)` that describes it. A leaf without a range contributes to
    // no cursor, which is exactly right: `--aggregate` merges leaves already counted.
    const [leaf] = pooledV2Leaves([
      recordFor(planFor(0, 10, "run-a/da_dk__crispasr__m")),
    ]).leaves;
    expect(leaf.leaf.sampleRange).toBeUndefined();
    expect("sampleRange" in leaf.leaf).toBe(false);
  });
});

describe("the v2 record layout", () => {
  test("v2 records live under an underscore-prefixed directory", () => {
    // The website's benchmark scan skips `_`-prefixed directories - that is how
    // `_combined` stays invisible to it - so v2 records sit beside `stt.json` without
    // appearing to the v1 reader as another archived run.
    expect(V2_RECORDS_DIRNAME.startsWith("_")).toBe(true);
  });

  test("the measuring harness is the product, not the ASR Harness", () => {
    expect(CODICTATE_V2_HARNESS).toBe("codictate");
    // And the argument that lets the ASR Harness stay out of the compatibility key is
    // asserted rather than commented: exactly one is runnable.
    expect(() => assertSingleRunnableAsrHarness()).not.toThrow();
  });
});
