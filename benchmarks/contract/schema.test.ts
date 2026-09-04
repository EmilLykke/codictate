/**
 * Fingerprint v2 parity, and the v2 record shape.
 *
 * The fingerprint is the one value in this contract that has to be byte-identical in
 * two repositories, and the failure mode of a mismatch is the worst kind: both sides
 * compute a plausible 16-hex string, neither crashes, and two runs that measured
 * different clips compare as the same selection. So the expected values are committed
 * as data - `fixtures/fingerprint-v2.json`, copied verbatim to
 * `dictation-product-benchmark/tests/fixtures/` - and asserted, never regenerated. A
 * fixture that recomputes its own expectation cannot detect a parity bug.
 *
 * The fixture is read off disk rather than imported as a TypeScript module on purpose:
 * the artifact the external repo copies is the JSON file, so the JSON file is what has
 * to be under test. A TS transcription of it would be a second source of truth, and the
 * two could disagree with every test still green.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertRunRecordAgreesWithPlan,
  FINGERPRINT_VERSION,
  fingerprintV2,
  fingerprintV2Matches,
  fingerprintV2Record,
  isCompletedRunRecordV2,
  isFingerprintV2,
  isRunRecordV2,
  isSampleMeasurementV2,
  isSuccessfulSample,
  normalizeRunRecordV2,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "./schema";

interface FingerprintFixture {
  version: string;
  cases: { name: string; clipIds: string[]; fingerprint: string }[];
}

const fixture: FingerprintFixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "fingerprint-v2.json"),
    "utf-8",
  ),
);

function fixtureCase(name: string) {
  const found = fixture.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fingerprint-v2.json has no case "${name}"`);
  return found;
}

describe("fingerprint v2 golden fixtures", () => {
  test("the fixture file declares the algorithm version this code implements", () => {
    expect(fixture.version).toBe(FINGERPRINT_VERSION);
    expect(FINGERPRINT_VERSION).toBe("benchmark-v2");
  });

  test("every case round-trips", () => {
    expect(fixture.cases.length).toBe(7);
    for (const entry of fixture.cases) {
      expect(fingerprintV2(entry.clipIds)).toBe(entry.fingerprint);
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("dedup equals the deduped list's fingerprint", () => {
    // Multiplicity is not part of the identity of a selection; order is.
    expect(fixtureCase("dedup").fingerprint).toBe(
      fingerprintV2(["a.wav", "b.wav"]),
    );
    expect(fixtureCase("dedup").fingerprint).toBe(
      fixtureCase("order-matters-b").fingerprint,
    );
  });

  test("order matters", () => {
    expect(fixtureCase("order-matters-a").fingerprint).not.toBe(
      fixtureCase("order-matters-b").fingerprint,
    );
  });

  test("the empty selection has a fingerprint, and it is the version line alone", () => {
    // Not the empty string and not a sentinel. The empty selection is inside this
    // function's domain - `planRange` yields a zero-width range once a cursor reaches the
    // end of a pool - so it has to hash to something stable and unequal to every
    // non-empty selection. A zero-clip plan still may not be *written* to disk:
    // `selection.ts::assertRunPlanOnDisk` refuses one, because there is nothing to resume.
    expect(fixtureCase("empty").fingerprint).toBe(fingerprintV2([]));
    expect(fixtureCase("empty").fingerprint).not.toBe(
      fixtureCase("single").fingerprint,
    );
  });

  test("the real da_dk case is the first 5 column-1 file names in natural order", () => {
    // Documented in the fixture's `realFleursDaFirst5Derivation` and asserted against
    // the real TSV in `fleurs-identity.manual.ts`. Natural on-disk order, not the
    // seeded shuffle: the external repo reproduces these five with `head -5 | cut -f2`
    // rather than re-implementing `seededShuffle(entries, 42)`, which is a Codictate
    // implementation detail and not part of this contract.
    const real = fixtureCase("real-fleurs-da-first-5");
    expect(real.clipIds.length).toBe(5);
    expect(new Set(real.clipIds).size).toBe(5);
    for (const clipId of real.clipIds) {
      expect(clipId).toMatch(/^fleurs\/da_dk\/audio\/test\/\d+\.wav$/);
    }
    expect(real.clipIds[0]).toBe(
      "fleurs/da_dk/audio/test/12149430079508542992.wav",
    );
    expect(fingerprintV2(real.clipIds)).toBe("d28f996584b02f28");
  });

  test("unicode clipIds are hashed as utf-8", () => {
    const unicode = fixtureCase("unicode");
    expect(unicode.clipIds[0]).toContain("æøå");
    expect(fingerprintV2(unicode.clipIds)).toBe(unicode.fingerprint);
  });
});

describe("the on-disk fingerprint shape", () => {
  test("it is a versioned pair under a v2-only field name", () => {
    const record = fingerprintV2Record(["a.wav", "b.wav"]);
    expect(record).toEqual({
      version: "benchmark-v2",
      value: fixtureCase("order-matters-b").fingerprint,
    });
    expect(isFingerprintV2(record)).toBe(true);
  });

  test("a v1 manifest fingerprint is not mistaken for a v2 one", () => {
    // v1 is `<count>:<16 hex>` under `manifestFingerprint`; see
    // `benchmarks/stt/sample-cursor.ts`. Different question, different field, never
    // compared - and the guard says so rather than trusting the field name alone.
    expect(isFingerprintV2("905:0f1e2d3c4b5a6978")).toBe(false);
    // And the *other* v1 format. There are two, they belong to different repositories,
    // and neither is comparable to the other or to a v2 value.
    expect(
      isFingerprintV2(
        "sha256:966cacb8b651000000000000000000000000000000000000000000000000000000",
      ),
    ).toBe(false);
    expect(
      isFingerprintV2({ version: "benchmark-v1", value: "0f1e2d3c4b5a6978" }),
    ).toBe(false);
    expect(isFingerprintV2({ version: "benchmark-v2", value: "NOTHEX" })).toBe(
      false,
    );
  });

  test("fingerprintV2Matches checks the version, not just the digest", () => {
    expect(
      fingerprintV2Matches(fingerprintV2Record(["a.wav"]), ["a.wav"]),
    ).toBe(true);
    expect(
      fingerprintV2Matches(fingerprintV2Record(["a.wav"]), ["b.wav"]),
    ).toBe(false);
    // A bare 16-hex string is not a v2 fingerprint, however right the digest is.
    expect(fingerprintV2Matches(fingerprintV2(["a.wav"]), ["a.wav"])).toBe(
      false,
    );
  });
});

// -- The record shapes --

function sample(over: Partial<SampleMeasurementV2> = {}): SampleMeasurementV2 {
  return {
    clipId: "fleurs/da_dk/audio/test/a.wav",
    audioDurationSec: 10,
    responseMs: 1200,
    status: "ok",
    wordErrors: 2,
    referenceWords: 20,
    charErrors: 5,
    referenceChars: 100,
    isWarmup: false,
    ...over,
  };
}

function runRecord(over: Partial<RunRecordV2> = {}): RunRecordV2 {
  const clipIds = ["fleurs/da_dk/audio/test/a.wav"];
  const fingerprint = fingerprintV2Record(clipIds);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: "2026-09-04_08-17-28_v2-da",
    status: "completed",
    startedAt: "2026-09-04T08:17:28.000Z",
    completedAt: "2026-09-04T09:02:11.000Z",
    harness: "codictate",
    model: "large-v3-turbo-q5_0",
    datasetId: "fleurs/da_dk",
    plan: {
      runId: "2026-09-04_08-17-28_v2-da",
      datasetId: "fleurs/da_dk",
      fromIndex: 0,
      toIndex: 1,
      clipCount: 1,
      fingerprintV2: fingerprint,
      createdAt: "2026-09-04T08:17:20.000Z",
    },
    fingerprintV2: fingerprint,
    samples: [sample()],
    ...over,
  };
}

describe("v2 type guards", () => {
  test("a Sample needs an identity, a duration, a status and both denominators", () => {
    expect(isSampleMeasurementV2(sample())).toBe(true);
    expect(isSampleMeasurementV2(sample({ clipId: "" }))).toBe(false);
    expect(isSampleMeasurementV2({ ...sample(), status: "ok?" })).toBe(false);
    const withoutDenominator: Record<string, unknown> = { ...sample() };
    delete withoutDenominator.referenceWords;
    expect(isSampleMeasurementV2(withoutDenominator)).toBe(false);
    // A failure carries no response, and null is not zero.
    expect(
      isSampleMeasurementV2(sample({ status: "failed", responseMs: null })),
    ).toBe(true);
  });

  test("sentenceId is optional metadata", () => {
    expect(isSampleMeasurementV2(sample({ sentenceId: "1676" }))).toBe(true);
    expect(isSampleMeasurementV2({ ...sample(), sentenceId: 1676 })).toBe(
      false,
    );
  });

  test("only an ok Sample with a number is successful", () => {
    expect(isSuccessfulSample(sample())).toBe(true);
    expect(
      isSuccessfulSample(sample({ status: "timeout", responseMs: null })),
    ).toBe(false);
    // `ok` with no number is malformed, not instant.
    expect(isSuccessfulSample(sample({ responseMs: null }))).toBe(false);
    expect(isSuccessfulSample(sample({ isWarmup: true }))).toBe(false);
  });

  test("a v1 record is rejected on its version, not on a missing field", () => {
    expect(isRunRecordV2(runRecord())).toBe(true);
    expect(isRunRecordV2({ ...runRecord(), schemaVersion: 1 })).toBe(false);
    expect(isRunRecordV2({ config: {}, librispeech: {}, fleurs: {} })).toBe(
      false,
    );
  });

  test("only a completed run is a completed run", () => {
    expect(isCompletedRunRecordV2(runRecord())).toBe(true);
    expect(
      isCompletedRunRecordV2(
        runRecord({ status: "incomplete", completedAt: null }),
      ),
    ).toBe(false);
  });
});

describe("the measuring harness is a closed union on the record", () => {
  test("a record naming an ASR Harness is not a v2 record", () => {
    // `harness` was `string`, so `"crispasr"` - the ASR Harness that executes a Speech
    // Engine - was assignable to the field that names the harness which took the
    // measurement. Two different questions, one type.
    expect(isRunRecordV2(runRecord())).toBe(true);
    expect(
      isRunRecordV2({ ...runRecord(), harness: "crispasr" as never }),
    ).toBe(false);
    expect(isRunRecordV2({ ...runRecord(), harness: "" as never })).toBe(false);
  });

  test("both measuring harnesses are accepted", () => {
    for (const harness of ["codictate", "wispr-flow"] as const) {
      expect(isRunRecordV2({ ...runRecord(), harness })).toBe(true);
    }
  });
});

describe("the on-disk schema-version key", () => {
  test("it is camelCase schemaVersion, matching the archive's style", () => {
    expect(SCHEMA_VERSION_KEY).toBe("schemaVersion");
    expect(SCHEMA_VERSION).toBe(2);
    expect(Object.keys(runRecord())).toContain("schemaVersion");
    expect(Object.keys(runRecord())).not.toContain("SCHEMA_VERSION");
  });

  test("the constant-named alias is normalised on ingest, before the guard", () => {
    // The dangerous combination is legible-to-a-human and invisible-to-the-guard: the
    // record sits on disk, the guard rejects it, nothing is logged, and the run vanishes
    // from pooling. So the alias is rewritten on the way in.
    const record = runRecord() as unknown as Record<string, unknown>;
    delete record.schemaVersion;
    const aliased = { SCHEMA_VERSION: 2, ...record };
    expect(isRunRecordV2(aliased)).toBe(false);
    expect(isRunRecordV2(normalizeRunRecordV2(aliased))).toBe(true);
  });

  test("the canonical key wins and the alias is dropped, so it cannot round-trip", () => {
    const normalized = normalizeRunRecordV2({
      ...runRecord(),
      SCHEMA_VERSION: 1,
    }) as Record<string, unknown>;
    expect(normalized.schemaVersion).toBe(2);
    expect("SCHEMA_VERSION" in normalized).toBe(false);
  });

  test("it is safe in front of every read", () => {
    const record = runRecord();
    expect(normalizeRunRecordV2(record)).toBe(record);
    expect(normalizeRunRecordV2(null)).toBeNull();
    expect(normalizeRunRecordV2([1, 2])).toEqual([1, 2]);
  });
});

describe("the overhead slot", () => {
  test("inferenceMs is the one mandated field, and null is legal", () => {
    expect(
      isSampleMeasurementV2(sample({ overhead: { inferenceMs: 1500 } })),
    ).toBe(true);
    expect(
      isSampleMeasurementV2(sample({ overhead: { inferenceMs: null } })),
    ).toBe(true);
    // Harness-specific extras ride alongside it without a schema change.
    expect(
      isSampleMeasurementV2(
        sample({
          overhead: {
            inferenceMs: 1500,
            observation: "text-change-event",
            pollIntervalMs: null,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("a record must agree with its own plan reference", () => {
  test("the duplicated fingerprint has to match", () => {
    expect(() => assertRunRecordAgreesWithPlan(runRecord())).not.toThrow();
    const forked = runRecord();
    expect(() =>
      assertRunRecordAgreesWithPlan({
        ...forked,
        fingerprintV2: fingerprintV2Record(["other.wav"]),
      }),
    ).toThrow(/its plan says/);
  });

  test("a completed run without a completedAt cannot be ordered", () => {
    expect(() =>
      assertRunRecordAgreesWithPlan(runRecord({ completedAt: null })),
    ).toThrow(/completed with no completedAt/);
  });

  test("the duplicated dataset and batch identities have to match", () => {
    const batched = runRecord({ batchId: "batch-a" });
    batched.plan.batchId = "batch-a";
    expect(() => assertRunRecordAgreesWithPlan(batched)).not.toThrow();
    expect(() =>
      assertRunRecordAgreesWithPlan({ ...batched, datasetId: "fleurs/hu_hu" }),
    ).toThrow(/dataset/);
    expect(() =>
      assertRunRecordAgreesWithPlan({ ...batched, batchId: "batch-b" }),
    ).toThrow(/batch/);
  });

  test("status and timestamps describe one possible lifecycle", () => {
    expect(() =>
      assertRunRecordAgreesWithPlan(
        runRecord({
          status: "incomplete",
          completedAt: "2026-09-04T09:02:11.000Z",
        }),
      ),
    ).toThrow(/incomplete.*completedAt/);
    expect(() =>
      assertRunRecordAgreesWithPlan(runRecord({ startedAt: "not-a-date" })),
    ).toThrow(/startedAt/);
    expect(() =>
      assertRunRecordAgreesWithPlan(
        runRecord({ completedAt: "2026-09-04T07:02:11.000Z" }),
      ),
    ).toThrow(/before it started/);
  });

  test("a completed record contains every planned scored clip exactly once", () => {
    expect(() =>
      assertRunRecordAgreesWithPlan(runRecord({ samples: [] })),
    ).toThrow(/1 unique scored Sample/);
    expect(() =>
      assertRunRecordAgreesWithPlan(
        runRecord({ samples: [sample(), sample()] }),
      ),
    ).toThrow(/1 unique scored Sample/);
  });

  test("plan bounds are whole, non-negative and match clipCount", () => {
    for (const plan of [
      { fromIndex: -1 },
      { fromIndex: 0.5 },
      { toIndex: 0 },
      { clipCount: 2 },
    ]) {
      const record = runRecord();
      expect(() =>
        assertRunRecordAgreesWithPlan({
          ...record,
          plan: { ...record.plan, ...plan },
        }),
      ).toThrow(/invalid plan bounds/);
    }
  });
});
