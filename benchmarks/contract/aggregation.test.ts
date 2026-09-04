/**
 * Pooling: the buckets, the union, the replacement, and the two averages that must
 * never be published.
 *
 * Two regression witnesses live here.
 *
 * The first is the **two-harness case**: Wispr Flow and Codictate both measure
 * `fleurs/da_dk/audio/test/12149430079508542992.wav`, because measuring the same clips
 * with both products is the entire point of the publication batch. The first cut of
 * `poolSamples` treated that as a conflict and threw, which would have failed on the
 * first pooled read of the thing this project exists to produce. Buckets, not throws.
 *
 * The second is `pooledWer` against a deliberately unbalanced two-dataset fixture, where
 * the pooled rate and the mean of the two per-dataset rates are 10.4% and 30.0%. Both
 * look like a WER. Only one of them is the accuracy of the combined sample, and
 * `benchmarks/README.md` has said so since `referenceWords` was added - a mean of means
 * weights a 908-clip Spanish pool the same as a 5-clip smoke slice.
 */

import { describe, expect, test } from "bun:test";
import {
  compatibilityKey,
  median,
  p90,
  percentileNearestRank,
  pooledCer,
  pooledInferenceRtf,
  pooledSampleCount,
  pooledSpeed,
  pooledWer,
  poolSamples,
  seriesSamples,
  type PoolResult,
} from "./aggregation";
import { contiguousCursor } from "./selection";
import {
  fingerprintV2Record,
  isSuccessfulSample,
  SCHEMA_VERSION,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "./schema";

function baseSample(clipId: string): SampleMeasurementV2 {
  return {
    clipId,
    audioDurationSec: 10,
    responseMs: 1000,
    status: "ok",
    wordErrors: 1,
    referenceWords: 10,
    charErrors: 2,
    referenceChars: 50,
    isWarmup: false,
  };
}

/**
 * A well-formed Codictate Sample: `direct-adapter` provenance and nothing else, which is
 * all that regime needs to be speed-compatible.
 *
 * The default fixture carries provenance on purpose. A fixture without it would be
 * speed-incompatible, so every speed assertion in this file would quietly be measuring
 * the exclusion path rather than the arithmetic.
 */
function sample(
  clipId: string,
  over: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  const { overhead, ...rest } = over;
  return {
    ...baseSample(clipId),
    ...rest,
    overhead: { timingRegime: "direct-adapter", ...overhead },
  };
}

/** A well-formed Wispr Flow Sample: keydown edge, monotonic clock. */
function flowSample(
  clipId: string,
  over: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  const { overhead, ...rest } = over;
  return {
    ...baseSample(clipId),
    ...rest,
    overhead: {
      timingRegime: "ui-observed-paste",
      hotkeyEdge: "keydown",
      timingClock: "monotonic",
      ...overhead,
    },
  };
}

/** A Sample recording exactly the provenance it is given, and no more. */
function rawSample(
  clipId: string,
  over: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  return { ...baseSample(clipId), ...over };
}

function run(
  runId: string,
  samples: SampleMeasurementV2[],
  over: Partial<RunRecordV2> = {},
): RunRecordV2 {
  const clipIds = samples.map((s) => s.clipId);
  const fingerprint = fingerprintV2Record(clipIds);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: "completed",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T01:00:00.000Z",
    harness: "codictate",
    model: "large-v3-turbo-q5_0",
    datasetId: "fleurs/da_dk",
    plan: {
      runId,
      datasetId: "fleurs/da_dk",
      fromIndex: 0,
      toIndex: samples.length,
      clipCount: samples.length,
      fingerprintV2: fingerprint,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    fingerprintV2: fingerprint,
    samples,
    ...over,
  };
}

const clip = (i: number) => `fleurs/da_dk/audio/test/c${i}.wav`;
const huClip = (i: number) => `fleurs/hu_hu/audio/test/c${i}.wav`;

/** The single bucket a one-series fixture pools into. */
function onlyBucket(result: PoolResult) {
  expect(result.buckets.length).toBe(1);
  return result.buckets[0];
}

describe("disjoint continuations pool", () => {
  test("the union is the clips of both, once each, in one bucket", () => {
    const first = run(
      "2026-09-01_a",
      [0, 1, 2].map((i) => sample(clip(i))),
    );
    const second = run(
      "2026-09-02_b",
      [3, 4].map((i) => sample(clip(i))),
      {
        startedAt: "2026-09-02T00:00:00.000Z",
        completedAt: "2026-09-02T01:00:00.000Z",
      },
    );

    const bucket = onlyBucket(poolSamples([first, second]));
    expect(bucket.samples.map((s) => s.clipId)).toEqual(
      [0, 1, 2, 3, 4].map(clip),
    );
    expect(bucket.replaced).toEqual([]);
    expect(bucket.runIds).toEqual(["2026-09-01_a", "2026-09-02_b"]);
    // No double counting: five clips, five denominators, five responses.
    expect(pooledWer(bucket.samples).references).toBe(50);
    expect(pooledSpeed(bucket.samples).sampleCount).toBe(5);
    expect(pooledSpeed(bucket.samples).attemptedCount).toBe(5);
  });
});

describe("nothing competes across compatibility buckets", () => {
  const flowRun = run("2026-09-03_flow", [sample(clip(0), { wordErrors: 4 })], {
    harness: "wispr-flow",
    model: "wispr-flow",
    startedAt: "2026-09-03T00:00:00.000Z",
    completedAt: "2026-09-03T01:00:00.000Z",
  });
  const codictateRun = run("2026-09-01_codictate", [
    sample(clip(0), { wordErrors: 1 }),
  ]);

  test("two harnesses measuring the same clip give two buckets and no throw", () => {
    // The publication batch in miniature. A clipId is dataset-scoped and deliberately
    // not harness-scoped, so this is the normal case and not a conflict.
    const pooled = poolSamples([flowRun, codictateRun]);
    expect(pooled.buckets.length).toBe(2);
    expect(pooled.skippedRuns).toEqual([]);

    const byHarness = new Map(pooled.buckets.map((b) => [b.harness, b]));
    expect(
      byHarness.get("codictate")?.samples.map((s) => s.wordErrors),
    ).toEqual([1]);
    expect(
      byHarness.get("wispr-flow")?.samples.map((s) => s.wordErrors),
    ).toEqual([4]);
    // Neither displaced the other, even though the Flow run is the newer one.
    expect(byHarness.get("codictate")?.replaced).toEqual([]);
    expect(byHarness.get("wispr-flow")?.replaced).toEqual([]);
  });

  test("the two buckets are separately poolable and separately labelled", () => {
    const pooled = poolSamples([flowRun, codictateRun]);
    for (const bucket of pooled.buckets) {
      expect(pooledSpeed(bucket.samples).sampleCount).toBe(1);
      expect(bucket.key).toBe(
        compatibilityKey({
          schemaVersion: bucket.schemaVersion,
          harness: bucket.harness,
          model: bucket.model,
          datasetId: bucket.datasetId,
        }),
      );
    }
  });

  test("buckets come back in a deterministic order", () => {
    const forwards = poolSamples([flowRun, codictateRun]).buckets.map(
      (b) => b.key,
    );
    const backwards = poolSamples([codictateRun, flowRun]).buckets.map(
      (b) => b.key,
    );
    expect(backwards).toEqual(forwards);
    expect(forwards).toEqual([...forwards].sort());
  });

  test("two models measuring the same clip do not compete either", () => {
    const turbo = run("2026-09-05_turbo", [sample(clip(0), { wordErrors: 1 })]);
    const large = run(
      "2026-09-06_large",
      [sample(clip(0), { wordErrors: 9 })],
      {
        model: "large-v3-q5_0",
        completedAt: "2026-09-06T01:00:00.000Z",
      },
    );
    expect(compatibilityKey(turbo)).not.toBe(compatibilityKey(large));
    const pooled = poolSamples([turbo, large]);
    expect(pooled.buckets.length).toBe(2);
    expect(pooled.buckets.flatMap((b) => b.samples).length).toBe(2);
  });

  test("a mislabelled datasetId separates instead of joining the wrong series", () => {
    const right = run("2026-09-01_right", [sample(clip(0))]);
    const mislabelled = run("2026-09-02_wrong", [sample(clip(0))], {
      datasetId: "fleurs/da-dk",
      completedAt: "2026-09-02T01:00:00.000Z",
    });
    expect(poolSamples([right, mislabelled]).buckets.length).toBe(2);
  });
});

describe("an overlapping rerun replaces only the clips it re-measured", () => {
  const older = run(
    "2026-09-01_first",
    [0, 1, 2, 3].map((i) => sample(clip(i), { wordErrors: 5 })),
  );
  const rerun = run(
    "2026-09-05_rerun",
    [2, 3, 4].map((i) => sample(clip(i), { wordErrors: 0 })),
    {
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T01:00:00.000Z",
    },
  );

  test("the newer measurement wins on the shared clips", () => {
    const bucket = onlyBucket(poolSamples([older, rerun]));
    const byClip = new Map(bucket.samples.map((s) => [s.clipId, s]));
    expect(byClip.get(clip(2))?.runId).toBe("2026-09-05_rerun");
    expect(byClip.get(clip(3))?.wordErrors).toBe(0);
    expect(bucket.replaced.map((r) => r.clipId)).toEqual([clip(2), clip(3)]);
    expect(bucket.replaced[0]).toEqual({
      clipId: clip(2),
      keptRunId: "2026-09-05_rerun",
      droppedRunId: "2026-09-01_first",
    });
  });

  test("the older run's other clips survive", () => {
    const bucket = onlyBucket(poolSamples([older, rerun]));
    const byClip = new Map(bucket.samples.map((s) => [s.clipId, s]));
    expect(byClip.get(clip(0))?.runId).toBe("2026-09-01_first");
    expect(byClip.get(clip(1))?.wordErrors).toBe(5);
    // Five unique clips from a 4-clip run and a 3-clip run: 4 + 3 = 7 is what a sum of
    // slice sizes would say, and it is what `sampleCount` must never be.
    expect(bucket.samples.length).toBe(5);
    expect(pooledSpeed(bucket.samples).sampleCount).toBe(5);
    expect(pooledWer(bucket.samples).errors).toBe(5 + 5 + 0 + 0 + 0);
  });

  test("replacement inside a bucket is never an error", () => {
    expect(() => poolSamples([older, rerun])).not.toThrow();
    expect(() => poolSamples([rerun, older])).not.toThrow();
  });

  test("the input order of the runs does not change the answer", () => {
    const forwards = onlyBucket(poolSamples([older, rerun])).samples;
    const backwards = onlyBucket(poolSamples([rerun, older])).samples;
    expect(backwards.map((s) => `${s.clipId}:${s.runId}`)).toEqual(
      forwards.map((s) => `${s.clipId}:${s.runId}`),
    );
  });

  test("two runs finishing at the same instant tie-break on run id", () => {
    const a = run("2026-09-05_aaa", [sample(clip(0), { wordErrors: 9 })], {
      completedAt: "2026-09-05T01:00:00.000Z",
    });
    const b = run("2026-09-05_bbb", [sample(clip(0), { wordErrors: 1 })], {
      completedAt: "2026-09-05T01:00:00.000Z",
    });
    expect(onlyBucket(poolSamples([a, b])).samples[0].runId).toBe(
      "2026-09-05_bbb",
    );
    expect(onlyBucket(poolSamples([b, a])).samples[0].runId).toBe(
      "2026-09-05_bbb",
    );
  });

  test("ISO offsets are ordered by instant, not lexicographically", () => {
    const olderOffset = run(
      "2026-09-05_offset",
      [sample(clip(0), { wordErrors: 9 })],
      { completedAt: "2026-09-05T01:00:00+02:00" },
    );
    const newerUtc = run(
      "2026-09-05_utc",
      [sample(clip(0), { wordErrors: 1 })],
      { completedAt: "2026-09-05T00:30:00.000Z" },
    );
    expect(
      onlyBucket(poolSamples([newerUtc, olderOffset])).samples[0].wordErrors,
    ).toBe(1);
  });
});

describe("an incomplete run is not a measurement", () => {
  const completed = run(
    "2026-09-01_done",
    [0, 1].map((i) => sample(clip(i))),
  );
  const interrupted = run(
    "2026-09-09_killed",
    [0, 1, 2, 3].map((i) => sample(clip(i), { wordErrors: 0 })),
    { status: "incomplete", completedAt: null },
  );

  test("it contributes nothing to the pool, not even its finished clips", () => {
    const pooled = poolSamples([completed, interrupted]);
    const bucket = onlyBucket(pooled);
    expect(bucket.samples.length).toBe(2);
    expect(bucket.samples.every((s) => s.runId === "2026-09-01_done")).toBe(
      true,
    );
    expect(bucket.runIds).toEqual(["2026-09-01_done"]);
    expect(pooled.skippedRuns).toEqual([
      { runId: "2026-09-09_killed", reason: "incomplete" },
    ]);
    // Its newer, better numbers do not win, because it never lost or won: it is a
    // resume source.
    expect(pooledWer(bucket.samples).errors).toBe(2);
  });

  test("it does not advance the cursor", () => {
    const ordered = [0, 1, 2, 3].map(clip);
    const bucket = onlyBucket(poolSamples([completed, interrupted]));
    expect(
      contiguousCursor(
        ordered,
        bucket.samples.map((s) => s.clipId),
      ),
    ).toBe(2);
  });

  test("a v1 record is skipped on its schema version", () => {
    const legacy = run("2026-05-08_v1", [sample(clip(0))], {
      schemaVersion: 1 as unknown as typeof SCHEMA_VERSION,
    });
    const pooled = poolSamples([legacy]);
    expect(pooled.buckets).toEqual([]);
    expect(pooled.skippedRuns).toEqual([
      { runId: "2026-05-08_v1", reason: "schema" },
    ]);
  });
});

describe("warmups are recorded and never scored", () => {
  const withWarmups = run("2026-09-01_warm", [
    sample("w0.wav", { isWarmup: true, wordErrors: 7 }),
    sample("w1.wav", { isWarmup: true, wordErrors: 7 }),
    sample(clip(0)),
    sample(clip(1)),
  ]);

  test("they are excluded from the pool, from sampleCount and from accuracy", () => {
    const bucket = onlyBucket(poolSamples([withWarmups]));
    expect(bucket.samples.map((s) => s.clipId)).toEqual([clip(0), clip(1)]);
    expect(pooledSampleCount(withWarmups.samples)).toBe(2);
    expect(pooledSpeed(withWarmups.samples).sampleCount).toBe(2);
    expect(pooledSpeed(withWarmups.samples).attemptedCount).toBe(2);
    expect(pooledWer(bucket.samples).errors).toBe(2);
  });

  test("replaying them in every session does not multiply them", () => {
    const secondSession = run(
      "2026-09-02_warm",
      [
        sample("w0.wav", { isWarmup: true }),
        sample("w1.wav", { isWarmup: true }),
        sample(clip(2)),
      ],
      {
        startedAt: "2026-09-02T00:00:00.000Z",
        completedAt: "2026-09-02T01:00:00.000Z",
      },
    );
    const bucket = onlyBucket(poolSamples([withWarmups, secondSession]));
    expect(bucket.samples.length).toBe(3);
    expect(bucket.replaced).toEqual([]);
  });
});

describe("accuracy is pooled, never a mean of means", () => {
  // Deliberately unbalanced: one Danish clip with a terrible score, a thousand Spanish
  // words with a good one. The two numbers are 10.4% and 30.0%.
  const danish = [
    sample("fleurs/da_dk/audio/test/c0.wav", {
      wordErrors: 5,
      referenceWords: 10,
      charErrors: 25,
      referenceChars: 50,
    }),
  ];
  const spanish = Array.from({ length: 10 }, (_, i) =>
    sample(`fleurs/es_419/audio/test/c${i}.wav`, {
      wordErrors: 10,
      referenceWords: 100,
      charErrors: 20,
      referenceChars: 500,
    }),
  );

  test("pooled WER is sum(errors) / sum(referenceWords)", () => {
    const pooled = pooledWer([...danish, ...spanish]);
    expect(pooled.errors).toBe(105);
    expect(pooled.references).toBe(1010);
    expect(pooled.rate).toBeCloseTo(105 / 1010, 12);
  });

  test("it disagrees with the mean of the two per-dataset rates", () => {
    const pooled = pooledWer([...danish, ...spanish]);
    const perDataset = [pooledWer(danish).rate, pooledWer(spanish).rate];
    expect(perDataset).toEqual([0.5, 0.1]);
    const meanOfMeans = (0.5 + 0.1) / 2;
    expect(meanOfMeans).toBeCloseTo(0.3, 12);
    expect(pooled.rate).not.toBeCloseTo(meanOfMeans, 3);
    expect(pooled.rate).toBeCloseTo(0.103960396, 6);
  });

  test("pooled CER follows the same formula on its own denominator", () => {
    const pooled = pooledCer([...danish, ...spanish]);
    expect(pooled.errors).toBe(225);
    expect(pooled.references).toBe(5050);
    expect(pooled.rate).toBeCloseTo(225 / 5050, 12);
  });

  test("a leaf with no denominator is skipped, never counted as zero", () => {
    // The archived-v1 case: `referenceWords` did not exist when those runs were
    // written, and folding one in as zero errors over zero words is a perfect score for
    // a clip nobody scored.
    const pooled = pooledWer([
      ...danish,
      { wordErrors: 3 },
      { referenceWords: 100 },
      { wordErrors: null, referenceWords: null },
    ]);
    expect(pooled.errors).toBe(5);
    expect(pooled.references).toBe(10);
    expect(pooled.leafCount).toBe(1);
    expect(pooled.skippedCount).toBe(3);
    expect(pooled.rate).toBe(0.5);
  });

  test("no usable leaf gives null, not zero", () => {
    const pooled = pooledWer([{ wordErrors: 3 }]);
    expect(pooled.rate).toBeNull();
    expect(pooled.references).toBe(0);
  });

  test("negative and fractional counts are malformed leaves, not arithmetic", () => {
    const pooled = pooledWer([
      { wordErrors: -1, referenceWords: 10 },
      { wordErrors: 1.5, referenceWords: 10 },
      { wordErrors: 1, referenceWords: -10 },
      { wordErrors: 1, referenceWords: 2.5 },
      { wordErrors: 2, referenceWords: 20 },
    ]);
    expect(pooled).toEqual({
      rate: 0.1,
      errors: 2,
      references: 20,
      leafCount: 1,
      skippedCount: 4,
    });
  });
});

describe("cross-dataset pooling happens above the buckets", () => {
  const daRun = run("2026-09-01_da", [
    sample(clip(0), { wordErrors: 5, referenceWords: 10 }),
  ]);
  const huRun = run(
    "2026-09-01_hu",
    Array.from({ length: 10 }, (_, i) =>
      sample(huClip(i), { wordErrors: 10, referenceWords: 100 }),
    ),
    { datasetId: "fleurs/hu_hu" },
  );

  test("one series, two dataset buckets, one pooled WER", () => {
    const pooled = poolSamples([daRun, huRun]);
    expect(pooled.buckets.length).toBe(2);
    expect(pooled.buckets.map((b) => b.datasetId)).toEqual([
      "fleurs/da_dk",
      "fleurs/hu_hu",
    ]);

    const series = seriesSamples(pooled, {
      harness: "codictate",
      model: "large-v3-turbo-q5_0",
    });
    expect(series.length).toBe(11);
    // Summed denominators, not averaged rates: 105/1010, not (0.5 + 0.1)/2.
    const acrossDatasets = pooledWer(series);
    expect(acrossDatasets.errors).toBe(105);
    expect(acrossDatasets.references).toBe(1010);
    expect(acrossDatasets.rate).toBeCloseTo(105 / 1010, 12);
  });

  test("it selects one series and never mixes two", () => {
    const flowRun = run("2026-09-02_flow", [sample(clip(0))], {
      harness: "wispr-flow",
      model: "wispr-flow",
    });
    const pooled = poolSamples([daRun, huRun, flowRun]);
    expect(pooled.buckets.length).toBe(3);
    expect(
      seriesSamples(pooled, {
        harness: "codictate",
        model: "large-v3-turbo-q5_0",
      }).length,
    ).toBe(11);
    expect(
      seriesSamples(pooled, { harness: "wispr-flow", model: "wispr-flow" })
        .length,
    ).toBe(1);
    expect(
      seriesSamples(pooled, { harness: "nobody", model: "nothing" }),
    ).toEqual([]);
  });
});

describe("speed counts failures and never prices them", () => {
  const samples = [
    sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
    sample(clip(1), { responseMs: 2000, audioDurationSec: 10 }),
    sample(clip(2), {
      status: "failed",
      responseMs: null,
      audioDurationSec: 10,
    }),
    sample(clip(3), {
      status: "timeout",
      responseMs: null,
      audioDurationSec: 10,
    }),
    sample("w0.wav", {
      isWarmup: true,
      responseMs: 99999,
      audioDurationSec: 10,
    }),
  ];

  test("only successful Samples reach the ratio, and every attempt is counted", () => {
    const speed = pooledSpeed(samples);
    // 3000 ms over 20 s of successfully transcribed audio. Counting the failed and the
    // timed-out clips' 20 s in the denominator would make the product look twice as
    // fast for having refused two clips.
    expect(speed.responseMsPerAudioSec).toBe(150);
    expect(speed.attemptedCount).toBe(4);
    expect(speed.respondedCount).toBe(2);
    expect(speed.sampleCount).toBe(4);
  });

  test("failureCount is every unsuccessful Sample and timeoutCount is the subset", () => {
    // Nested, not disjoint, because that is what the v1 archive already means: a leaf
    // carries `"failures": 1` beside `"failuresByStatus": {"timeout": 1, "failed": 0}`,
    // so the disjoint reading would silently change every archived `failures` number.
    const speed = pooledSpeed(samples);
    expect(speed.failureCount).toBe(2);
    expect(speed.timeoutCount).toBe(1);
    expect(speed.timeoutCount).toBeLessThanOrEqual(speed.failureCount);
    expect(speed.attemptedCount).toBe(
      speed.respondedCount + speed.failureCount,
    );
  });

  test("the invariant holds on every shape, including all-timeout", () => {
    for (const fixture of [
      samples,
      [],
      [sample(clip(0))],
      [0, 1, 2].map((i) =>
        sample(clip(i), { status: "timeout" as const, responseMs: null }),
      ),
      [sample(clip(0), { responseMs: null })],
    ]) {
      const speed = pooledSpeed(fixture);
      expect(speed.attemptedCount).toBe(
        speed.respondedCount + speed.failureCount,
      );
    }
  });

  test("an ok Sample with no responseMs is malformed, not instant", () => {
    const speed = pooledSpeed([
      sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
      sample(clip(1), { responseMs: null }),
    ]);
    expect(speed.responseMsPerAudioSec).toBe(100);
    expect(speed.respondedCount).toBe(1);
    expect(speed.attemptedCount).toBe(2);
    // It did not respond, so the invariant puts it in failureCount - and it did not
    // time out, so it is not in timeoutCount.
    expect(speed.failureCount).toBe(1);
    expect(speed.timeoutCount).toBe(0);
  });

  test("no successful Sample gives null, not zero", () => {
    const speed = pooledSpeed([
      sample(clip(0), { status: "failed", responseMs: null }),
    ]);
    expect(speed.responseMsPerAudioSec).toBeNull();
    expect(speed.wallRtf).toBeNull();
    expect(speed.medianResponseMs).toBeNull();
    expect(speed.p90ResponseMs).toBeNull();
    expect(speed.failureCount).toBe(1);
  });

  test("wallRtf is the response ratio in seconds, derived once", () => {
    // The published RTF. `charts.py` arithmetically averaged per-dataset RTFs, which is
    // a mean of means on the speed axis; there is one derivation and it lives here.
    const speed = pooledSpeed(samples);
    expect(speed.wallRtf).toBe(0.15);
    expect(speed.wallRtf).toBe((speed.responseMsPerAudioSec as number) / 1000);
  });

  test("median and p90 are the successful responses only", () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      sample(clip(i), { responseMs: (i + 1) * 100 }),
    );
    const speed = pooledSpeed([
      ...ten,
      sample(clip(99), { status: "timeout", responseMs: null }),
    ]);
    expect(speed.medianResponseMs).toBe(550);
    expect(speed.p90ResponseMs).toBe(900);
  });
});

describe("speed provenance gates the ratio and nothing else", () => {
  test("a direct-adapter Sample with no hotkey fields is counted", () => {
    // The trap, as a test. Filtering on `hotkeyEdge`/`timingClock` alone would exclude
    // every Codictate Sample - a direct adapter call has no hotkey to have an edge - and
    // silently zero out Codictate speed, which is the opposite of the defect being fixed.
    const speed = pooledSpeed([
      sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
      sample(clip(1), { responseMs: 2000, audioDurationSec: 10 }),
    ]);
    expect(speed.respondedCount).toBe(2);
    expect(speed.speedExcludedCount).toBe(0);
    expect(speed.responseMsPerAudioSec).toBe(150);
    expect(speed.wallRtf).toBe(0.15);
  });

  test("a Flow Sample with full provenance is counted", () => {
    const speed = pooledSpeed([
      flowSample(clip(0), { responseMs: 3000, audioDurationSec: 10 }),
    ]);
    expect(speed.speedExcludedCount).toBe(0);
    expect(speed.responseMsPerAudioSec).toBe(300);
  });

  test("a Flow Sample missing hotkeyEdge leaves the ratio but keeps everything else", () => {
    // ~81-90 ms optimistic per clip, measured. Out of the ratio; still attempted, still
    // responded, and its wordErrors are still a valid measurement of the transcript.
    const legacy = rawSample(clip(1), {
      responseMs: 100,
      audioDurationSec: 10,
      wordErrors: 3,
      referenceWords: 10,
      overhead: { timingRegime: "ui-observed-paste", timingClock: "monotonic" },
    });
    const good = flowSample(clip(0), {
      responseMs: 3000,
      audioDurationSec: 10,
    });

    const speed = pooledSpeed([good, legacy]);
    expect(speed.attemptedCount).toBe(2);
    expect(speed.respondedCount).toBe(2);
    expect(speed.speedExcludedCount).toBe(1);
    expect(speed.failureCount).toBe(0);
    expect(speed.attemptedCount).toBe(
      speed.respondedCount + speed.failureCount,
    );
    // The ratio and the raw list cover respondedCount - speedExcludedCount = 1 Sample.
    expect(speed.responseMsPerAudioSec).toBe(300);
    expect(speed.medianResponseMs).toBe(3000);
    expect(speed.p90ResponseMs).toBe(3000);
    // Accuracy is untouched: the defect moved a timestamp, not a transcript.
    expect(pooledWer([good, legacy]).errors).toBe(1 + 3);
    expect(pooledWer([good, legacy]).references).toBe(20);
    expect(speed.sampleCount).toBe(2);
  });

  test("a wall clock or the wrong key edge is excluded too", () => {
    const uiObserved = "ui-observed-paste" as const;
    for (const overhead of [
      {
        timingRegime: uiObserved,
        hotkeyEdge: "keyup",
        timingClock: "monotonic",
      },
      { timingRegime: uiObserved, hotkeyEdge: "keydown", timingClock: "wall" },
      { timingRegime: uiObserved },
    ]) {
      const speed = pooledSpeed([rawSample(clip(0), { overhead })]);
      expect(speed.speedExcludedCount).toBe(1);
      expect(speed.responseMsPerAudioSec).toBeNull();
      expect(speed.respondedCount).toBe(1);
    }
  });

  test("an absent timingRegime is excluded, conservatively", () => {
    // Guessing would mean publishing an ~85 ms-optimistic Flow number as comparable.
    // Excluding a Sample is recoverable; that is not.
    const noOverhead = pooledSpeed([rawSample(clip(0))]);
    expect(noOverhead.speedExcludedCount).toBe(1);
    expect(noOverhead.responseMsPerAudioSec).toBeNull();
    expect(noOverhead.wallRtf).toBeNull();

    const emptyOverhead = pooledSpeed([rawSample(clip(0), { overhead: {} })]);
    expect(emptyOverhead.speedExcludedCount).toBe(1);
    const nulledRegime = pooledSpeed([
      rawSample(clip(0), { overhead: { timingRegime: null } }),
    ]);
    expect(nulledRegime.speedExcludedCount).toBe(1);
  });

  test("wallRtf is derived from the filtered numerator, not the unfiltered one", () => {
    // The subtle leak: an unfiltered sum here would be (3000 + 100) / 20 = 155 ms/s and
    // republish the excluded Sample's optimism under a different field name.
    const speed = pooledSpeed([
      flowSample(clip(0), { responseMs: 3000, audioDurationSec: 10 }),
      rawSample(clip(1), {
        responseMs: 100,
        audioDurationSec: 10,
        overhead: { timingRegime: "ui-observed-paste" },
      }),
    ]);
    expect(speed.responseMsPerAudioSec).toBe(300);
    expect(speed.wallRtf).toBe(0.3);
    expect(speed.wallRtf).not.toBe(0.155);
    expect(speed.wallRtf).toBe((speed.responseMsPerAudioSec as number) / 1000);
  });

  test("a mixed pooled bucket reports a nonzero excluded count", () => {
    const flowRun = run(
      "2026-09-03_flow",
      [
        flowSample(clip(0), { responseMs: 3000 }),
        flowSample(clip(1), { responseMs: 3200 }),
        rawSample(clip(2), {
          responseMs: 100,
          overhead: { timingRegime: "ui-observed-paste", hotkeyEdge: "keyup" },
        }),
      ],
      { harness: "wispr-flow", model: "wispr-flow" },
    );
    const bucket = onlyBucket(poolSamples([flowRun]));
    const speed = pooledSpeed(bucket.samples);
    expect(speed.attemptedCount).toBe(3);
    expect(speed.respondedCount).toBe(3);
    expect(speed.speedExcludedCount).toBe(1);
    expect(speed.medianResponseMs).toBe(3100);
    // Coverage is untouched: all three clips were measured.
    expect(speed.sampleCount).toBe(3);
    expect(pooledSampleCount(bucket.samples)).toBe(3);
  });

  test("the invariant survives every exclusion shape", () => {
    for (const fixture of [
      [rawSample(clip(0))],
      [flowSample(clip(0)), rawSample(clip(1))],
      [
        sample(clip(0)),
        rawSample(clip(1), { status: "failed" as const, responseMs: null }),
        rawSample(clip(2), { status: "timeout" as const, responseMs: null }),
      ],
    ]) {
      const speed = pooledSpeed(fixture);
      expect(speed.attemptedCount).toBe(
        speed.respondedCount + speed.failureCount,
      );
      expect(speed.speedExcludedCount).toBeLessThanOrEqual(
        speed.respondedCount,
      );
    }
  });
});

describe("a Sample with no denominator is skipped and counted", () => {
  test("a zero audioDurationSec does not inflate the ratio", () => {
    // The test that would have caught it. Before the guard, the zero-duration Sample
    // added its 5000 ms to the numerator and 0 s to the denominator, moving the ratio
    // from 100 to 600 ms/s - a 6x inflation with no counter to show it had happened.
    const good = sample(clip(0), { responseMs: 1000, audioDurationSec: 10 });
    const noDuration = sample(clip(1), {
      responseMs: 5000,
      audioDurationSec: 0,
    });

    const speed = pooledSpeed([good, noDuration]);
    expect(speed.responseMsPerAudioSec).toBe(
      pooledSpeed([good]).responseMsPerAudioSec,
    );
    expect(speed.responseMsPerAudioSec).toBe(100);
    expect(speed.wallRtf).toBe(0.1);
    expect(speed.missingDurationCount).toBe(1);
    // It responded and it was attempted; it just has no denominator.
    expect(speed.respondedCount).toBe(2);
    expect(speed.attemptedCount).toBe(2);
    expect(speed.failureCount).toBe(0);
    expect(speed.speedExcludedCount).toBe(0);
  });

  test("this is the same rule the accuracy and inference paths already followed", () => {
    // `pooledRate` skips a leaf missing either half; `pooledInferenceRtf` guards
    // `audioDurationSec > 0`. Speed was the one place that did not.
    const noDuration = sample(clip(0), { audioDurationSec: 0 });
    expect(pooledSpeed([noDuration]).responseMsPerAudioSec).toBeNull();
    expect(pooledSpeed([noDuration]).wallRtf).toBeNull();
    expect(pooledInferenceRtf([noDuration]).rtf).toBeNull();
    expect(pooledWer([{ wordErrors: 3 }]).rate).toBeNull();
  });

  test("a negative or non-finite duration is skipped too", () => {
    for (const audioDurationSec of [
      0,
      -10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const speed = pooledSpeed([sample(clip(0), { audioDurationSec })]);
      expect(speed.missingDurationCount).toBe(1);
      expect(speed.responseMsPerAudioSec).toBeNull();
    }
  });

  test("it leaves the median and p90 as well, so every speed number covers one set", () => {
    const speed = pooledSpeed([
      sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
      sample(clip(1), { responseMs: 5000, audioDurationSec: 0 }),
    ]);
    // A raw latency needs no denominator, but a median over a different set of Samples
    // than the ratio is the quiet divergence this contract exists to prevent.
    expect(speed.medianResponseMs).toBe(1000);
    expect(speed.p90ResponseMs).toBe(1000);
  });

  test("provenance and denominator are counted separately, never twice", () => {
    // Two unrelated problems wanting two different fixes: re-instrument the harness, or
    // re-convert a WAV. Provenance takes precedence - an untrustworthy number cannot be
    // rescued by a good denominator.
    const bothWrong = rawSample(clip(0), { audioDurationSec: 0 });
    const speed = pooledSpeed([bothWrong]);
    expect(speed.speedExcludedCount).toBe(1);
    expect(speed.missingDurationCount).toBe(0);
    expect(
      speed.speedExcludedCount + speed.missingDurationCount,
    ).toBeLessThanOrEqual(speed.respondedCount);
  });

  test("accuracy and coverage are untouched by a missing duration", () => {
    // The audio duration is the speed denominator and nothing else. The transcript was
    // still produced and still scored.
    const noDuration = sample(clip(1), {
      audioDurationSec: 0,
      wordErrors: 3,
      referenceWords: 10,
    });
    const good = sample(clip(0), { wordErrors: 1, referenceWords: 10 });
    expect(pooledWer([good, noDuration]).errors).toBe(4);
    expect(pooledWer([good, noDuration]).references).toBe(20);
    expect(pooledWer([good, noDuration]).skippedCount).toBe(0);
    expect(pooledSpeed([good, noDuration]).sampleCount).toBe(2);
    expect(pooledSampleCount([good, noDuration])).toBe(2);
  });
});

describe("a malformed responseMs is not a response", () => {
  test("NaN does not poison the whole bucket", () => {
    // It used to: NaN propagates through the sum, the ratio comes out NaN, and NaN
    // serialises to null - so a chart simply loses the bar with nothing to explain it.
    const speed = pooledSpeed([
      sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
      sample(clip(1), { responseMs: Number.NaN }),
    ]);
    expect(speed.responseMsPerAudioSec).toBe(100);
    expect(Number.isNaN(speed.responseMsPerAudioSec)).toBe(false);
    expect(speed.respondedCount).toBe(1);
    expect(speed.failureCount).toBe(1);
  });

  test("a negative responseMs is not a discount on every other clip", () => {
    // One -900 ms Sample beside one honest 1000 ms / 10 s Sample moved the ratio from
    // 100 to 5 ms/s: a 20x flattering error, the same optimistic direction as the Flow
    // start-timestamp bug.
    const speed = pooledSpeed([
      sample(clip(0), { responseMs: 1000, audioDurationSec: 10 }),
      sample(clip(1), { responseMs: -900, audioDurationSec: 10 }),
    ]);
    expect(speed.responseMsPerAudioSec).toBe(100);
    expect(speed.respondedCount).toBe(1);
    expect(speed.failureCount).toBe(1);
  });

  test("Infinity is malformed too, and zero is a real measurement", () => {
    expect(
      pooledSpeed([sample(clip(0), { responseMs: Number.POSITIVE_INFINITY })])
        .respondedCount,
    ).toBe(0);
    // A 0 ms response is implausible but it is not malformed, and skipping it would be
    // inventing a rule about plausibility that nothing here can justify.
    const zero = pooledSpeed([
      sample(clip(0), { responseMs: 0, audioDurationSec: 10 }),
    ]);
    expect(zero.respondedCount).toBe(1);
    expect(zero.responseMsPerAudioSec).toBe(0);
  });

  test("isSuccessfulSample agrees with pooledSpeed on all four shapes", () => {
    // Two predicates disagreeing about what "successful" means is how respondedCount and
    // the ratio drift apart.
    for (const responseMs of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const bad = sample(clip(0), { responseMs });
      expect(isSuccessfulSample(bad)).toBe(false);
      expect(pooledSpeed([bad]).respondedCount).toBe(0);
    }
    const ok = sample(clip(0), { responseMs: 1200 });
    expect(isSuccessfulSample(ok)).toBe(true);
    expect(pooledSpeed([ok]).respondedCount).toBe(1);
  });

  test("the invariant survives every malformed shape", () => {
    for (const responseMs of [null, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const speed = pooledSpeed([
        sample(clip(0)),
        sample(clip(1), { responseMs }),
      ]);
      expect(speed.attemptedCount).toBe(
        speed.respondedCount + speed.failureCount,
      );
    }
  });
});

describe("the Codictate-only inference RTF is a diagnostic", () => {
  test("it pools sums, and skips the Samples that do not report it", () => {
    const diagnostic = pooledInferenceRtf([
      sample(clip(0), {
        audioDurationSec: 10,
        overhead: { inferenceMs: 1500 },
      }),
      sample(clip(1), {
        audioDurationSec: 20,
        overhead: { inferenceMs: 4500 },
      }),
      // No overhead at all, an explicit null, and a warmup: none of them contribute.
      sample(clip(2), { audioDurationSec: 10 }),
      sample(clip(3), {
        audioDurationSec: 10,
        overhead: { inferenceMs: null },
      }),
      sample("w0.wav", {
        isWarmup: true,
        audioDurationSec: 10,
        overhead: { inferenceMs: 9999 },
      }),
    ]);
    expect(diagnostic.inferenceMs).toBe(6000);
    expect(diagnostic.audioDurationSec).toBe(30);
    expect(diagnostic.rtf).toBeCloseTo(0.2, 12);
    expect(diagnostic.leafCount).toBe(2);
    expect(diagnostic.skippedCount).toBe(2);
  });

  test("a missing field is skipped, never zero", () => {
    // Zero inference time is not a fact about anything, and a zero would drag the
    // diagnostic down in proportion to how many Samples failed to report.
    const withField = pooledInferenceRtf([
      sample(clip(0), {
        audioDurationSec: 10,
        overhead: { inferenceMs: 2000 },
      }),
    ]);
    const plusSilentOne = pooledInferenceRtf([
      sample(clip(0), {
        audioDurationSec: 10,
        overhead: { inferenceMs: 2000 },
      }),
      sample(clip(1), { audioDurationSec: 10 }),
    ]);
    expect(plusSilentOne.rtf).toBe(withField.rtf);
    expect(plusSilentOne.skippedCount).toBe(1);
  });

  test("nothing reported gives null", () => {
    const diagnostic = pooledInferenceRtf([sample(clip(0))]);
    expect(diagnostic.rtf).toBeNull();
    expect(diagnostic.leafCount).toBe(0);
  });

  test("it is not the published RTF and is a different number", () => {
    // Same Samples, two metrics: inference is what happened inside the adapter call,
    // wallRtf is the call itself. Never the same column, never compared to a Flow row.
    const samples = [
      sample(clip(0), {
        audioDurationSec: 10,
        responseMs: 2000,
        overhead: { inferenceMs: 1500 },
      }),
    ];
    expect(pooledSpeed(samples).wallRtf).toBe(0.2);
    expect(pooledInferenceRtf(samples).rtf).toBeCloseTo(0.15, 12);
  });
});

describe("median and p90 on known lists", () => {
  test("median averages the two middle values for an even count", () => {
    expect(median([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])).toBe(
      550,
    );
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
    // Input order does not matter; the list is sorted first.
    expect(median([3, 1, 2])).toBe(2);
  });

  test("p90 is nearest-rank, never interpolated", () => {
    // ceil(0.9 * 10) = 9, so the 9th smallest. Interpolation would return 910, a
    // response time no clip had.
    expect(p90([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])).toBe(900);
    expect(p90([1, 2, 3])).toBe(3);
    expect(p90([42])).toBe(42);
    expect(p90([])).toBeNull();
  });

  test("the percentile helper clamps to the list", () => {
    expect(percentileNearestRank([1, 2, 3, 4], 0)).toBe(1);
    expect(percentileNearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentileNearestRank([1, 2, 3, 4], 1)).toBe(4);
    expect(percentileNearestRank([1, 2, 3, 4], 2)).toBe(4);
  });
});
