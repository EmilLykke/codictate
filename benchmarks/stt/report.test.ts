/**
 * The report's arithmetic, and the two sentences it is obliged to print.
 *
 * Worth pinning because a mean of per-dataset rates is a *plausible* number. It has the
 * right units, it moves in the right direction, and on a balanced sample it is close
 * enough to the pooled answer to look right - so nothing downstream disagrees with it. On
 * an unbalanced sample it is not close: the fixture below is 11.5% pooled against 30.0%
 * averaged, and only one of those is the accuracy of the sample that was measured.
 *
 * The label tests are here rather than in a doc check because three surfaces in two
 * repositories have to print one sentence, and the only one of them that is not
 * TypeScript is `charts.py`. A Python file cannot import a TypeScript constant, so the
 * literal is duplicated there and pinned here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accuracyLeafOf,
  generateMarkdownReport,
  pooledCerForConditions,
  pooledFailures,
  pooledSpeedForConditions,
  pooledWerForConditions,
  type BenchmarkResults,
} from "./report";
import type { ModelDatasetResult } from "./runner";
import {
  INSTRUMENTATION_ASYMMETRY_LABEL,
  pooledSpeed,
  pooledWer,
} from "../contract";

/**
 * A leaf as the archive and the runner write them.
 *
 * `wordErrors` is deliberately left off unless a test needs it, so the default path
 * exercises the archived shape: a rate and a denominator, with the error count derived.
 */
function leaf(
  wer: number,
  referenceWords: number | undefined,
  overrides: Partial<ModelDatasetResult> = {},
): ModelDatasetResult {
  return {
    wer,
    ...(referenceWords === undefined ? {} : { referenceWords }),
    meanRTF: 0.2,
    peakRSS_MB: null,
    utteranceCount: referenceWords === undefined ? 10 : referenceWords / 10,
    failures: 0,
    totalAudioSec: 100,
    totalWallSec: 20,
    ...overrides,
  };
}

function conditions(models: Record<string, ModelDatasetResult | undefined>[]): {
  key: string;
  label: string;
  models: Record<string, ModelDatasetResult>;
}[] {
  return models.map((byModel, index) => ({
    key: index === 0 ? "da_dk" : "hu_hu",
    label: index === 0 ? "Danish" : "Hungarian",
    models: Object.fromEntries(
      Object.entries(byModel).filter(([, value]) => value !== undefined),
    ) as Record<string, ModelDatasetResult>,
  }));
}

/** A pooled speed summary with the two filtered sums and a consistent ratio. */
function speedV2(totals: { responseMs: number; audioDurationSec: number }) {
  const ratio =
    totals.audioDurationSec > 0
      ? totals.responseMs / totals.audioDurationSec
      : null;
  return {
    ...pooledSpeed([]),
    ...totals,
    responseMsPerAudioSec: ratio,
    wallRtf: ratio === null ? null : ratio / 1000,
    inferenceRtf: null,
    inferenceMs: 0,
    inferenceAudioSec: 0,
    inferenceSampleCount: 0,
    inferenceSkippedCount: 0,
  };
}

describe("pooled accuracy is not a mean of means", () => {
  test("a deliberately unbalanced two-dataset fixture disagrees, by a lot", () => {
    // 100 errors over 1000 words at 10%, and 20 errors over 40 words at 50%. Pooled:
    // 120 / 1040 = 11.5%. Averaged: (10% + 50%) / 2 = 30%. Two conditions whose rates
    // are close average to something close to the pooled answer, which is exactly why
    // this bug survived - so both the sizes and the rates are unbalanced here.
    const unbalanced = conditions([
      { m: leaf(0.1, 1_000) },
      { m: leaf(0.5, 40) },
    ]);

    const pooled = pooledWerForConditions("m", unbalanced);
    expect(pooled.errors).toBe(120);
    expect(pooled.references).toBe(1_040);
    expect(pooled.rate).toBeCloseTo(120 / 1_040, 12);
    expect(pooled.rate! * 100).toBeCloseTo(11.538, 3);

    // What the report used to print: the unweighted mean of 10% and 50%.
    const meanOfMeans = (0.1 + 0.5) / 2;
    expect(meanOfMeans).toBe(0.3);
    // 11.5% against 30.0%. A 40-clip condition weighted like a 1000-word one.
    expect(Math.abs(pooled.rate! - meanOfMeans)).toBeGreaterThan(0.18);
  });

  test("the rendered report prints the pooled number, not the averaged one", () => {
    const markdown = generateMarkdownReport(
      resultsWith({
        da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 1_000) } },
        hu_hu: { crispasr: { "large-v3-turbo-q5_0": leaf(0.5, 40) } },
      }),
    );

    // 88.5% pooled accuracy. The averaged answer would have rendered 70.0%.
    expect(markdown).toContain("88.5%");
    expect(markdown).not.toContain("70.0%");
    expect(markdown).toContain("Pooled Overall");
  });

  test("a leaf with no denominator is skipped, never counted as zero", () => {
    // The runs written before `referenceWords` existed have no denominator on disk and
    // can never be re-measured. Folding one in as zero errors over zero words is a
    // perfect score for a clip nobody scored; folding it in as a rate over an assumed
    // denominator is worse, because it looks like a measurement.
    const mixed = conditions([
      { m: leaf(0.1, 1_000) },
      { m: leaf(0.5, undefined) },
    ]);

    const pooled = pooledWerForConditions("m", mixed);
    expect(pooled.rate).toBeCloseTo(0.1, 12);
    expect(pooled.leafCount).toBe(1);
    expect(pooled.skippedCount).toBe(1);
  });

  test("every leaf lacking a denominator leaves the rate null, not zero", () => {
    const pooled = pooledWerForConditions(
      "m",
      conditions([{ m: leaf(0.1, undefined) }]),
    );
    expect(pooled.rate).toBeNull();
    expect(pooled.skippedCount).toBe(1);
  });

  test("a sentinel leaf for an absent Speech Model contributes nothing", () => {
    // `wer: -1` is what a leaf carries when the weights were not on disk when the run
    // happened. It measured nothing.
    expect(accuracyLeafOf(leaf(-1, 0))).toEqual({});
    const pooled = pooledWerForConditions(
      "m",
      conditions([{ m: leaf(-1, 0) }, { m: leaf(0.2, 100) }]),
    );
    expect(pooled.rate).toBeCloseTo(0.2, 12);
    expect(pooled.skippedCount).toBe(1);
  });

  test("a v2 leaf's whole error count is used rather than re-derived", () => {
    // `wer * referenceWords` recovers the count on an archived leaf, and a float times a
    // float is a float: pooling 25 of them accumulates a rounding error into a published
    // rate. A v2 leaf carries the whole number, so it is read rather than recomputed.
    const v2 = leaf(1 / 3, 3, { wordErrors: 1 });
    expect(accuracyLeafOf(v2).wordErrors).toBe(1);
    const pooled = pooledWer([accuracyLeafOf(v2)]);
    expect(pooled.errors).toBe(1);
  });

  test("CER pools the same way, and is absent where no leaf scored one", () => {
    const withCer = conditions([
      { m: leaf(0.1, 1_000, { cer: 0.02, referenceChars: 5_000 }) },
      { m: leaf(0.5, 40, { cer: 0.4, referenceChars: 200 }) },
    ]);
    const pooled = pooledCerForConditions("m", withCer);
    // 100 + 80 char errors over 5200 chars, not the mean of 2% and 40%.
    expect(pooled.errors).toBeCloseTo(180, 9);
    expect(pooled.references).toBe(5_200);
    expect(pooled.rate).toBeCloseTo(180 / 5_200, 12);

    expect(
      pooledCerForConditions("m", conditions([{ m: leaf(0.1, 100) }])).rate,
    ).toBeNull();
  });
});

describe("pooled speed comes from one set of sums", () => {
  test("the filtered sums pool; the unfiltered legacy totals never weight them", () => {
    // 12000 ms over 80 s from the Samples that survived both filters, beside
    // totalWallSec 18.5 / totalAudioSec 100 over all ten scored. 150 ms/s against
    // 185 ms/s - so a fixture can never be used to argue that reaching for
    // `totalAudioSec` as a weight is harmless.
    const withSums = leaf(0.1, 100, {
      totalWallSec: 18.5,
      totalAudioSec: 100,
      speedV2: speedV2({ responseMs: 12_000, audioDurationSec: 80 }),
    });
    const pooled = pooledSpeedForConditions("m", conditions([{ m: withSums }]));

    expect(pooled.v2MsPerAudioSec).toBeCloseTo(150, 9);
    expect(pooled.v2MsPerAudioSec).not.toBeCloseTo(185, 0);
    expect(pooled.v2Conditions).toBe(1);
    expect(pooled.legacyConditions).toBe(0);
  });

  test("a v2 leaf with no poolable sums is counted, not weighted in", () => {
    // `poolableSpeedTotals` returns null for a zero denominator, and that leaf's 500 s of
    // unfiltered audio must not become a weight: it would multiply a provenance-filtered
    // numerator by an unfiltered denominator.
    const poolable = leaf(0.1, 100, {
      totalWallSec: 18.5,
      totalAudioSec: 100,
      speedV2: speedV2({ responseMs: 12_000, audioDurationSec: 80 }),
    });
    const notPoolable = leaf(0.1, 100, {
      totalWallSec: 900,
      totalAudioSec: 500,
      speedV2: speedV2({ responseMs: 0, audioDurationSec: 0 }),
    });

    const pooled = pooledSpeedForConditions(
      "m",
      conditions([{ m: poolable }, { m: notPoolable }]),
    );
    expect(pooled.v2MsPerAudioSec).toBeCloseTo(150, 9);
    expect(pooled.unpoolableV2Conditions).toBe(1);
    // And it does not leak in through the legacy path either: it has a v2 summary, so its
    // v1 sums are not the archive's.
    expect(pooled.legacyMsPerAudioSec).toBeNull();
  });

  test("an archived leaf with no v2 summary pools only as legacy", () => {
    const archived = leaf(0.12, 1_000, {
      totalWallSec: 20,
      totalAudioSec: 100,
    });
    const pooled = pooledSpeedForConditions("m", conditions([{ m: archived }]));
    expect(pooled.v2MsPerAudioSec).toBeNull();
    expect(pooled.legacyMsPerAudioSec).toBeCloseTo(200, 9);
    expect(pooled.legacyConditions).toBe(1);
  });
});

describe("failures: absent means not counted", () => {
  test("a leaf without the field is reported as uncounted, not as zero", () => {
    // The one field a migration could never backfill: nothing on disk records *which*
    // utterances failed. Reporting an absent count as zero says an engine that produced
    // nothing transcribed perfectly.
    const mixed = conditions([
      { m: leaf(0.1, 100, { failures: 2 }) },
      { m: leaf(0.1, 100, { failures: undefined }) },
    ]);

    expect(pooledFailures("m", mixed)).toEqual({
      counted: 2,
      uncountedLeaves: 1,
    });
  });

  test("the rendered report says so in words", () => {
    const markdown = generateMarkdownReport(
      resultsWith({
        da_dk: {
          crispasr: {
            "large-v3-turbo-q5_0": leaf(0.1, 100, { failures: undefined }),
          },
        },
      }),
    );
    expect(markdown).toContain("not counted");
  });

  test("a clean run reports a real zero", () => {
    expect(
      pooledFailures("m", conditions([{ m: leaf(0.1, 100, { failures: 0 }) }])),
    ).toEqual({ counted: 0, uncountedLeaves: 0 });
  });
});

describe("the instrumentation asymmetry label", () => {
  test("the report prints it verbatim", () => {
    const markdown = generateMarkdownReport(
      resultsWith({
        da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 100) } },
      }),
    );
    expect(markdown).toContain(INSTRUMENTATION_ASYMMETRY_LABEL);
  });

  test("charts.py carries the same sentence, character for character", () => {
    // The only surface that cannot import the constant. A paraphrase in one of three
    // surfaces is how a reader ends up believing the two numbers are the same
    // measurement, so the Python literal is pinned to the TypeScript one here - the two
    // string fragments in charts.py, joined, must equal the exported constant exactly.
    const source = readFileSync(join(import.meta.dir, "charts.py"), "utf-8");
    const block = source.slice(
      source.indexOf("INSTRUMENTATION_ASYMMETRY_LABEL = ("),
    );
    const literal = [
      ...block.slice(0, block.indexOf("\n)")).matchAll(/"([^"]*)"/g),
    ]
      .map((match) => match[1])
      .join("");
    expect(literal).toBe(INSTRUMENTATION_ASYMMETRY_LABEL);
  });

  test("the report states that its numbers are pooled", () => {
    const markdown = generateMarkdownReport(
      resultsWith({
        da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 100) } },
      }),
    );
    expect(markdown).toContain("sum(errors) / sum(references)");
  });
});

describe("the sample-size label follows where the number came from", () => {
  test("a v1 claimed range width keeps the v1 wording", () => {
    // The number every archived run carries is the *claimed width* of a range, and it
    // sits exactly `warmupCount` above the deepest `utteranceCount` - 400 against 397,
    // 200 against 197, 50 against 47. Printing that under the pooled wording claims 400
    // measured clips where 397 exist and no v2 Sample does, which is defect 2's own error
    // class on the aggregate path.
    const markdown = generateMarkdownReport(
      resultsWith(
        { da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 100) } } },
        { sampleSize: 400 },
      ),
    );
    expect(markdown).toContain("- **Samples per dataset:** 400");
    expect(markdown).not.toContain("Pooled unique scored clips");
  });

  test("a pooled count says so, and only then", () => {
    const markdown = generateMarkdownReport(
      resultsWith(
        { da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 100) } } },
        { sampleSize: 397, sampleSizeBasis: "pooled-v2" },
      ),
    );
    expect(markdown).toContain(
      "- **Pooled unique scored clips per dataset:** 397",
    );
  });

  test("an archived file, which carries no basis at all, reads as v1", () => {
    // Absence is the archive's answer: none of the eight committed runs has the field.
    const markdown = generateMarkdownReport(
      resultsWith({
        da_dk: { crispasr: { "large-v3-turbo-q5_0": leaf(0.1, 100) } },
      }),
    );
    expect(markdown).toContain("- **Samples per dataset:**");
  });
});

/** A minimal `BenchmarkResults` around one FLEURS block. */
function resultsWith(
  fleurs: BenchmarkResults["fleurs"],
  config: Partial<BenchmarkResults["config"]> = {},
): BenchmarkResults {
  return {
    description: "pooled-accuracy fixture",
    hardware: { chip: "M4", ram: "32 GB", os: "macOS", osVersion: "26.0" },
    runDate: "2026-09-04T12:00:00.000Z",
    config: {
      sampleSize: 104,
      warmupCount: 3,
      normalization: "whisper-basic",
      ...config,
    },
    librispeech: {},
    fleurs,
  };
}
