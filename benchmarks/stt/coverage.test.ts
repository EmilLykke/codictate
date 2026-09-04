/**
 * The v2 scan: which run records feed the production cursor, and which are only a resume
 * source.
 *
 * The rule this pins is the one with no visible symptom. An incomplete run has Samples on
 * disk and they look exactly like a completed run's, so a scan that read "the clips it did
 * finish" would advance the cursor over measurements nobody has checked against a plan,
 * and the next session would start after them. Nothing crashes and no published number
 * looks wrong.
 *
 * On the filesystem rather than through a pure seam, because the scan *is* the
 * filesystem: it walks run directories, tolerates half-written files, and has to tell an
 * absent plan from an unreadable one. A fixture tree in a temp directory is the only way
 * to exercise that.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completedV2Records,
  incompleteV2Stages,
  loadV2Stages,
  unresumableV2Stages,
  v2DatasetCoverage,
  V2_PLAN_SUFFIX,
  V2_RECORD_SUFFIX,
} from "./coverage";
import { CODICTATE_V2_HARNESS, V2_RECORDS_DIRNAME } from "./results-schema";
import { CODICTATE_TIMING_REGIME } from "./runner";
import {
  buildRunPlan,
  runPlanRef,
  SCHEMA_VERSION,
  type RunPlan,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "../contract";

const POOL = Array.from(
  { length: 100 },
  (_, i) => `fleurs/da_dk/audio/test/1${String(i).padStart(18, "0")}.wav`,
);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeResultsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codictate-v2-scan-"));
  roots.push(root);
  return root;
}

function planFor(runId: string, from: number, to: number): RunPlan {
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

/** Write one stage's plan and record into `<root>/<runName>/_v2/`. */
function writeStage(
  root: string,
  runName: string,
  stageId: string,
  plan: RunPlan | null,
  record: RunRecordV2 | null,
): void {
  const dir = join(root, runName, V2_RECORDS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  if (plan) {
    writeFileSync(
      join(dir, `${stageId}${V2_PLAN_SUFFIX}`),
      JSON.stringify(plan, null, 2),
    );
  }
  writeFileSync(
    join(dir, `${stageId}${V2_RECORD_SUFFIX}`),
    JSON.stringify(record, null, 2),
  );
}

function recordFor(
  plan: RunPlan,
  status: "completed" | "incomplete",
  measured: readonly string[],
): RunRecordV2 {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    status,
    startedAt: "2026-09-04T08:00:00.000Z",
    completedAt: status === "completed" ? "2026-09-04T09:00:00.000Z" : null,
    harness: CODICTATE_V2_HARNESS,
    model: plan.model,
    datasetId: plan.datasetId,
    plan: runPlanRef(plan),
    fingerprintV2: plan.fingerprintV2,
    samples: measured.map((clipId) => sampleOf(clipId)),
  };
}

describe("loadV2Stages", () => {
  test("an interrupted run does not advance the production cursor", () => {
    // Acceptance gate 3, end to end over the scan. The interrupted run has 30 real
    // Samples on disk and they are indistinguishable from a completed run's; only its
    // explicit `status` says they may not be counted, and that is exactly why the status
    // is on the record rather than inferred from the sample count.
    const root = makeResultsRoot();
    const done = planFor("2026-09-04_08-00-00_first/s", 0, 40);
    const dying = planFor("2026-09-05_08-00-00_second/s", 40, 100);
    writeStage(
      root,
      "2026-09-04_08-00-00_first",
      "s",
      done,
      recordFor(done, "completed", POOL.slice(0, 40)),
    );
    writeStage(
      root,
      "2026-09-05_08-00-00_second",
      "s",
      dying,
      recordFor(dying, "incomplete", POOL.slice(40, 70)),
    );

    const stages = loadV2Stages(root);
    expect(stages).toHaveLength(2);

    const completed = completedV2Records(stages);
    expect(completed).toHaveLength(1);

    const coverage = v2DatasetCoverage(
      POOL,
      completed.flatMap((record) => record.samples),
    );
    // 40, not 70. The 30 clips the dying run finished are on disk and count for nothing.
    expect(coverage.cursor).toBe(40);
    expect(coverage.maxMeasuredEnd).toBe(40);
    expect(coverage.sampleCount).toBe(40);
  });

  test("the unfinished stage is offered back by run id, to resume or discard", () => {
    const root = makeResultsRoot();
    const dying = planFor("2026-09-05_08-00-00_second/s", 40, 100);
    writeStage(
      root,
      "2026-09-05_08-00-00_second",
      "s",
      dying,
      recordFor(dying, "incomplete", POOL.slice(40, 70)),
    );

    const unfinished = incompleteV2Stages(loadV2Stages(root));
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].runName).toBe("2026-09-05_08-00-00_second");
    // The plan is what makes the refusal actionable: it is the clip list a new run's
    // selection is intersected against.
    expect(unfinished[0].plan.orderedClipIds).toHaveLength(60);
  });

  test("a gap does not advance the cursor, and maxMeasuredEnd says so separately", () => {
    // Acceptance gate 6, over clip sets. Two completed runs, one of them started past the
    // other's end: 60 clips are measured and 40 in the middle were never transcribed, so
    // the depth is 40 and the deepest measured end is 100.
    const root = makeResultsRoot();
    const prefix = planFor("2026-09-04_08-00-00_prefix/s", 0, 40);
    const past = planFor("2026-09-05_08-00-00_from-60/s", 60, 100);
    writeStage(
      root,
      "2026-09-04_08-00-00_prefix",
      "s",
      prefix,
      recordFor(prefix, "completed", POOL.slice(0, 40)),
    );
    writeStage(
      root,
      "2026-09-05_08-00-00_from-60",
      "s",
      past,
      recordFor(past, "completed", POOL.slice(60, 100)),
    );

    const coverage = v2DatasetCoverage(
      POOL,
      completedV2Records(loadV2Stages(root)).flatMap((r) => r.samples),
    );
    expect(coverage.cursor).toBe(40);
    expect(coverage.maxMeasuredEnd).toBe(100);
    // 80 clips really were measured. The point is that 80 is not a *depth*.
    expect(coverage.sampleCount).toBe(80);
  });

  test("warmups do not advance the cursor", () => {
    const coverage = v2DatasetCoverage(POOL, [
      sampleOf(POOL[0], { isWarmup: true }),
      sampleOf(POOL[1], { isWarmup: true }),
    ]);
    expect(coverage.cursor).toBe(0);
    expect(coverage.sampleCount).toBe(0);
  });

  test("a stage with an unreadable plan is unresumable rather than invisible", () => {
    // It blocks nothing and pools nothing, and it says so: a stage whose plan cannot be
    // read cannot be described, so blocking a new run on it would leave the operator with
    // an error and no way out.
    const root = makeResultsRoot();
    const plan = planFor("2026-09-05_08-00-00_broken/s", 0, 10);
    const dir = join(root, "2026-09-05_08-00-00_broken", V2_RECORDS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `s${V2_PLAN_SUFFIX}`), "{ not json");
    writeFileSync(
      join(dir, `s${V2_RECORD_SUFFIX}`),
      JSON.stringify(recordFor(plan, "incomplete", POOL.slice(0, 3))),
    );

    const stages = loadV2Stages(root);
    expect(stages[0].plan).toBeNull();
    expect(unresumableV2Stages(stages)).toHaveLength(1);
    expect(incompleteV2Stages(stages)).toHaveLength(0);
  });

  test("a truncated record file is skipped without taking the scan down", () => {
    // A record is rewritten after every scored clip, so a kill mid-write is the normal
    // way a corrupt one appears. The atomic write is what stops it; the scan tolerating
    // it is the second line of defence.
    const root = makeResultsRoot();
    const dir = join(root, "2026-09-05_08-00-00_torn", V2_RECORDS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `s${V2_RECORD_SUFFIX}`),
      '{"schemaVersion": 2, "sam',
    );

    const stages = loadV2Stages(root);
    expect(stages).toHaveLength(1);
    expect(stages[0].record).toBeNull();
    expect(completedV2Records(stages)).toHaveLength(0);
  });

  test("a results tree with no v2 records at all scans clean", () => {
    expect(loadV2Stages(makeResultsRoot())).toEqual([]);
    expect(loadV2Stages(join(tmpdir(), "codictate-does-not-exist"))).toEqual(
      [],
    );
  });
});

describe("the scan validates plans with the contract's guard", () => {
  test("a plan whose fingerprint disagrees with its own clips reads as unresumable", () => {
    // The axis a hand-rolled field-type guard misses, asserted at the scan rather than
    // at the guard: `runPlanComplaints` in the contract owns the rule and has its own
    // tests, and what matters here is that a plan it rejects reaches `loadV2Stages` as a
    // `null` plan - so the stage is reported as unresumable instead of being resumed
    // against a clip list its fingerprint never covered.
    const root = makeResultsRoot();
    const plan = planFor("2026-09-05_08-00-00_bad-fp/s", 0, 10);
    const tampered = {
      ...plan,
      orderedClipIds: [...plan.orderedClipIds.slice(1), POOL[50]],
    };
    writeStage(
      root,
      "2026-09-05_08-00-00_bad-fp",
      "s",
      tampered as unknown as RunPlan,
      recordFor(plan, "incomplete", POOL.slice(0, 3)),
    );

    const stages = loadV2Stages(root);
    expect(stages[0].plan).toBeNull();
    expect(unresumableV2Stages(stages)).toHaveLength(1);
    expect(incompleteV2Stages(stages)).toHaveLength(0);
  });

  test("a plan the contract accepts survives the round trip through disk", () => {
    const root = makeResultsRoot();
    const plan = planFor("2026-09-05_08-00-00_good/s", 0, 10);
    writeStage(
      root,
      "2026-09-05_08-00-00_good",
      "s",
      plan,
      recordFor(plan, "incomplete", POOL.slice(0, 3)),
    );

    const [stage] = loadV2Stages(root);
    expect(stage.plan).not.toBeNull();
    expect(stage.plan!.orderedClipIds).toEqual(plan.orderedClipIds);
    expect(unresumableV2Stages(loadV2Stages(root))).toHaveLength(0);
  });
});
