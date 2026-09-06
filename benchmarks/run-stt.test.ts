/**
 * The run script's durable parts: how a checkpoint reaches the disk, how a resume is
 * named, and what a run directory looks like when a process is killed mid-clip.
 *
 * Everything here was previously unobservable because `main()` ran on import. It is
 * behind `import.meta.main` now, which is what lets these assertions exist at all - and
 * they are the assertions that matter most, because each of the failures they pin is
 * silent:
 *
 * - a half-written checkpoint reads as a shallower run rather than as a broken one;
 * - "the latest unfinished run" resumes the wrong run and files a partial numerator
 *   against clips it never saw;
 * - a resume given `--samples` measures a different selection than the fingerprint
 *   recorded beside it says.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptResultsDir,
  assertSamplesInPlanOrder,
  atomicWriteJsonSync,
  datasetIdFor,
  parseStageId,
  peakRssForPooledLeaf,
  pooledPeakRss,
  PRODUCTION_RESULTS_DIR,
  resolveResumeTarget,
  recoverCompletedCheckpointLeaf,
  stageIdFor,
  stagePlanPath,
  stageRecord,
  stageRecordPath,
  writeStagePlan,
  writeStageRecord,
} from "./run-stt";
import {
  CODICTATE_TIMING_REGIME,
  measureClips,
  leafFromSamples,
  type AdapterSeam,
  type PeakRSSStats,
} from "./stt/runner";
import {
  CODICTATE_V2_HARNESS,
  parseRunRecordV2,
  pooledV2Leaves,
  V2_RECORDS_DIRNAME,
  type DatasetResults,
} from "./stt/results-schema";
import {
  completedV2Records,
  incompleteV2Stages,
  loadV2Stages,
} from "./stt/coverage";
import {
  assertResumeFlags,
  buildRunPlan,
  RESUME_FORBIDDEN_FLAGS,
  uniqueInOrder,
  type RunPlan,
  type SampleMeasurementV2,
} from "./contract";
import type { BenchmarkResults } from "./stt/report";
import type { ManifestEntry } from "./scripts/build-manifests";
import type {
  TranscriptionRequest,
  TranscriptionResult,
} from "../src/bun/utils/whisper/engines/transcription";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "codictate-run-stt-"));
  roots.push(root);
  return root;
}

describe("atomicWriteJsonSync", () => {
  /**
   * Every assertion in here has to **fail** against `writeFileSync(target, json)`.
   *
   * That is harder than it looks and the first version of these tests got it wrong: they
   * checked the directory listing *after* the rename and hand-wrote a `.tmp` file the
   * function never touched, so a plain `writeFileSync` body passed all three. A test that
   * cannot fail against the implementation it replaced defends nothing.
   *
   * The observable consequence of "temp file in the target's own directory, then rename"
   * is that the sibling path `<target>.tmp` is *used*. So the tests interfere with that
   * exact path: block it and the write must fail; leave a stale one and the write must
   * consume it. A naive implementation does neither.
   */
  test("blocking the sibling temp path breaks the write", () => {
    // `rename` is only atomic within a filesystem, so the temp file has to be a sibling
    // of the target - a temp file in the system temp directory makes this a copy, which
    // is the non-atomic write it replaces. Putting a *directory* at the sibling path is
    // how a test can see which path was opened: `writeFileSync` onto a directory fails.
    // A `writeFileSync(target, ...)` implementation would succeed here.
    const dir = tempDir();
    const target = join(dir, "checkpoint.json");
    mkdirSync(`${target}.tmp`);

    expect(() => atomicWriteJsonSync(target, { depth: 1 })).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  test("a stale temp file from a killed write is consumed, not left behind", () => {
    // A kill during a write leaves `<target>.tmp` on disk. The next successful write
    // renames over it, so it must be gone afterwards. A naive implementation never opens
    // that path, so the stale file would still be sitting there - which is how a test
    // distinguishes the two.
    const dir = tempDir();
    const target = join(dir, "record.json");
    atomicWriteJsonSync(target, { depth: 1 });
    writeFileSync(`${target}.tmp`, '{"depth": 2, "sam');
    expect(readdirSync(dir).sort()).toEqual(["record.json", "record.json.tmp"]);

    atomicWriteJsonSync(target, { depth: 2 });

    expect(readdirSync(dir)).toEqual(["record.json"]);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ depth: 2 });
  });

  test("the target is never a partial file, whatever was there before", () => {
    const dir = tempDir();
    const target = join(dir, "record.json");
    atomicWriteJsonSync(target, { samples: [1, 2, 3] });
    atomicWriteJsonSync(target, { samples: [1] });
    // Overwritten, not appended - a rename replaces, it does not merge.
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ samples: [1] });
  });
});

describe("assertSamplesInPlanOrder", () => {
  test("a pooled, clipId-sorted list is refused", () => {
    // The invariant a reader in another repository depends on: it reconstructs plan order
    // from the write order of `samples`, because the record carries no clip list.
    // `poolSamples` returns bucket Samples **sorted by clipId**, so routing a pooled list
    // into a record writer produces a record that parses, type-guards and pools
    // identically - and breaks that reader's cursor with no error anywhere.
    // A plan whose order is not lexicographic, because the real ones are not: each
    // dataset's manifest is `seededShuffle(entries, 42)`. Over an accidentally sorted
    // pool, sorting is a no-op and this test would pass against a writer that sorts.
    const plan = buildRunPlan({
      runId: "run/s",
      datasetId: "fleurs/da_dk",
      harness: CODICTATE_V2_HARNESS,
      model: "large-v3-turbo-q5_0",
      consumableClipIds: [...POOL].reverse(),
      warmupClipIds: WARMUPS,
      fromIndex: 0,
      toIndex: 5,
      createdAt: "2026-09-04T08:00:00.000Z",
    });
    const inPlanOrder = plan.orderedClipIds.map((clipId) => sampleOf(clipId));
    expect(() => assertSamplesInPlanOrder(plan, inPlanOrder)).not.toThrow();

    const sorted = [...inPlanOrder].sort((a, b) =>
      a.clipId < b.clipId ? -1 : 1,
    );
    expect(sorted.map((s) => s.clipId)).not.toEqual(
      inPlanOrder.map((s) => s.clipId),
    );
    expect(() => assertSamplesInPlanOrder(plan, sorted)).toThrow(/plan order/);
  });

  test("a resumed prefix is in order, and warmups do not count", () => {
    const plan = planFor("run/s", 0, 5);
    const prefix = plan.orderedClipIds
      .slice(0, 3)
      .map((clipId) => sampleOf(clipId));
    // Warmups are written first and replayed by every session, so they repeat by design.
    const withWarmups = [
      ...plan.warmupClipIds.map((clipId) => ({
        ...sampleOf(clipId),
        isWarmup: true,
      })),
      ...prefix,
    ];
    expect(() => assertSamplesInPlanOrder(plan, withWarmups)).not.toThrow();
  });

  test("a completed record requires the full scored plan", () => {
    const plan = planFor("run/s", 0, 5);
    expect(() =>
      stageRecord({
        runId: plan.runId,
        plan,
        status: "completed",
        startedAt: "2026-09-04T08:00:00.000Z",
        completedAt: "2026-09-04T09:00:00.000Z",
        samples: plan.orderedClipIds.slice(0, 4).map(sampleOf),
      }),
    ).toThrow(/cannot be completed/);
  });

  test("the record writer enforces it, not just the helper", () => {
    const plan = planFor("run/s", 0, 3);
    expect(() =>
      stageRecord({
        runId: plan.runId,
        plan,
        status: "incomplete",
        startedAt: "2026-09-04T08:00:00.000Z",
        completedAt: null,
        samples: [sampleOf(plan.orderedClipIds[2])],
      }),
    ).toThrow(/plan order/);
  });
});

describe("completed-record checkpoint recovery", () => {
  test("reconstructs a missing v1 leaf without transcribing", () => {
    const plan = planFor("2026-09-04_08-00-00_recovery/s", 0, 5);
    const samples = plan.orderedClipIds.map(sampleOf);
    const store: { librispeech: DatasetResults; fleurs: DatasetResults } = {
      librispeech: {},
      fleurs: {},
    };
    const recovered = recoverCompletedCheckpointLeaf(
      store,
      {
        harness: "crispasr",
        modelId: plan.model,
        datasetKey: "da_dk",
        datasetType: "fleurs",
        partial: {} as never,
        range: {
          startIndex: 0,
          endIndex: 5,
          manifestFingerprint: "100:abc",
        },
      },
      [
        {
          runName: "2026-09-04_08-00-00_recovery",
          stageId: stageIdFor("da_dk", "crispasr", plan.model),
          planPath: "",
          recordPath: "",
          plan,
          record: stageRecord({
            runId: plan.runId,
            plan,
            status: "completed",
            startedAt: "2026-09-04T08:00:00.000Z",
            completedAt: "2026-09-04T09:00:00.000Z",
            samples,
          }),
        },
      ],
    );
    expect(recovered).toBe(true);
    expect(store.fleurs.da_dk.crispasr![plan.model].utteranceCount).toBe(5);
    expect(store.fleurs.da_dk.crispasr![plan.model].peakRSS_MB).toBeNull();
  });
});

describe("parseStageId", () => {
  test("a resumed stage's Harness bucket comes from its own stage id", () => {
    // Not from `harnesses[0]`. That is right only while exactly one ASR Harness is
    // runnable, and the tripwire for that assumption sits on the pooling path - so a
    // second runnable Harness would mislabel a resumed leaf before any pooling ran.
    expect(
      parseStageId(stageIdFor("da_dk", "crispasr", "large-v3-q5_0")),
    ).toEqual({
      datasetKey: "da_dk",
      bucket: "crispasr",
      modelId: "large-v3-q5_0",
    });
    // Single separators inside a dataset key and a Model ID do not confuse the split.
    expect(
      parseStageId(stageIdFor("test-clean", "whisper-cli", "small.en-q5_1")),
    ).toEqual({
      datasetKey: "test-clean",
      bucket: "whisper-cli",
      modelId: "small.en-q5_1",
    });
    expect(parseStageId("not-a-stage-id")).toBeNull();
  });
});

describe("resolveResumeTarget", () => {
  test("a run id that names no directory is refused, and the candidates are listed", () => {
    const root = tempDir();
    mkdirSync(join(root, "2026-09-04_08-00-00_alive"), { recursive: true });
    mkdirSync(join(root, "2026-09-03_08-00-00_done"), { recursive: true });
    writeFileSync(join(root, "2026-09-03_08-00-00_done", "stt.json"), "{}");

    const refused = resolveResumeTarget(root, "hu-session-1");
    expect(refused.status).toBe("error");
    const lines = refused.status === "error" ? refused.lines : [];
    expect(lines[0]).toContain("--resume hu-session-1 names no run directory");
    // Only the unfinished one is a candidate, and the message says the id is the
    // directory name - which is the mistake `--name` invites.
    expect(lines[1]).toContain("2026-09-04_08-00-00_alive");
    expect(lines[1]).not.toContain("2026-09-03_08-00-00_done");
    expect(lines[2]).toContain("directory name, not the --name slug");
  });

  test("a finished run cannot be resumed", () => {
    const root = tempDir();
    mkdirSync(join(root, "2026-09-03_08-00-00_done"), { recursive: true });
    writeFileSync(join(root, "2026-09-03_08-00-00_done", "stt.json"), "{}");

    const refused = resolveResumeTarget(root, "2026-09-03_08-00-00_done");
    expect(refused.status).toBe("error");
    expect(refused.status === "error" && refused.lines[0]).toContain(
      "already finished",
    );
  });

  test("an unfinished run resolves to its own directory and nothing else", () => {
    // The whole point. The old `findIncompleteRun()` scanned for the newest unfinished
    // directory and returned it whatever run the operator had asked for, so an
    // invocation meant for one run resumed another.
    const root = tempDir();
    for (const name of [
      "2026-09-04_08-00-00_first",
      "2026-09-05_08-00-00_second",
    ]) {
      mkdirSync(join(root, name), { recursive: true });
    }

    const resolved = resolveResumeTarget(root, "2026-09-04_08-00-00_first");
    expect(resolved.status).toBe("ok");
    expect(resolved.status === "ok" && resolved.runDir).toBe(
      join(root, "2026-09-04_08-00-00_first"),
    );
  });
});

describe("the flags a resume refuses", () => {
  test("every selection-changing flag is refused by name", () => {
    // Thirteen flags, both repositories' spellings, from one list in the contract - so a
    // command written for either harness is refused by either. Accepting any of them
    // would mean the record's plan reference described a selection the process did not
    // run, and the fingerprint copied from that plan would read as agreement.
    expect(RESUME_FORBIDDEN_FLAGS).toHaveLength(13);
    for (const flag of RESUME_FORBIDDEN_FLAGS) {
      expect(() =>
        assertResumeFlags(["--resume", "run-1", flag, "400"], "run-1"),
      ).toThrow(flag);
      // `--flag=value` is the same flag typed differently.
      expect(() =>
        assertResumeFlags(["--resume", "run-1", `${flag}=400`], "run-1"),
      ).toThrow(flag);
    }
  });

  test("--batch and --out are allowed, on purpose", () => {
    // `--batch` names the batch whose stages are being resumed rather than the clips a
    // stage measures, and the orchestrator passes it on every invocation including the
    // resuming ones. `--out` moves where artifacts are written, not what was measured.
    // These are the two flags §G excludes from the list, and they are exactly the two
    // this CLI added for the orchestrator - so the exclusion is load-bearing, not
    // incidental.
    expect(() =>
      assertResumeFlags(
        ["--resume", "run-1", "--batch", "2026-09-v2", "--out", "/tmp/staging"],
        "run-1",
      ),
    ).not.toThrow();
    // And a forbidden flag beside them is still refused, by its own name.
    expect(() =>
      assertResumeFlags(
        ["--resume", "run-1", "--batch", "2026-09-v2", "--samples", "400"],
        "run-1",
      ),
    ).toThrow("--samples");
  });
});

describe("--out and --batch, the orchestrator's two flags", () => {
  test("a relative --out is refused rather than resolved", () => {
    // The cwd of a `bun run` is whatever the caller's shell was in, and the orchestrator
    // invokes this from its own directory - so a relative path writes to two different
    // places depending on who typed it, and one of them is the production tree.
    const refusal = adoptResultsDir("results/smoke");
    expect(refusal).not.toBeNull();
    expect(refusal![0]).toContain("must be an absolute path");
    // Nothing was adopted: the production tree is still the active one.
    expect(PRODUCTION_RESULTS_DIR.endsWith("benchmarks/results")).toBe(true);
  });

  test("an absolute --out is adopted and created", () => {
    const root = join(tempDir(), "smoke", "2026-09-v2");
    expect(adoptResultsDir(root)).toBeNull();
    expect(existsSync(root)).toBe(true);
  });

  test("a run written under --out contributes nothing to production reads", () => {
    // SPEC §8's smoke exclusion, as a property rather than a promise. Before `--out`,
    // five rehearsal clips per dataset landed in `benchmarks/results/` as ordinary
    // **completed** v2 records - they fed `pooledV2Leaves`, they fed `poolSamples`, and
    // they advanced the cursor the production batch would then measure from.
    const production = tempDir();
    const smoke = tempDir();

    const plan = planFor("2026-09-04_08-00-00_smoke/s", 0, 5);
    const runDir = join(smoke, "2026-09-04_08-00-00_smoke");
    mkdirSync(runDir, { recursive: true });
    writeStagePlan(runDir, "s", plan);
    writeStageRecord(
      runDir,
      "s",
      stageRecord({
        runId: plan.runId,
        plan,
        status: "completed",
        startedAt: "2026-09-04T08:00:00.000Z",
        completedAt: "2026-09-04T08:05:00.000Z",
        samples: plan.orderedClipIds.map((clipId) => sampleOf(clipId)),
      }),
    );

    // The production tree cannot see it: not the scan, not the pool, not the cursor.
    expect(loadV2Stages(production)).toEqual([]);
    expect(completedV2Records(loadV2Stages(production))).toEqual([]);
    expect(
      pooledV2Leaves(completedV2Records(loadV2Stages(production))).leaves,
    ).toEqual([]);

    // And it is fully readable when something is pointed at it, which is what makes the
    // smoke output reviewable rather than merely hidden.
    const smokeRecords = completedV2Records(loadV2Stages(smoke));
    expect(smokeRecords).toHaveLength(1);
    expect(pooledV2Leaves(smokeRecords).leaves[0].sampleCount).toBe(5);
  });

  test("--batch reaches the run record, through the immutable plan", () => {
    // Not just the config. It is how the orchestrator finds a crashed stage to resume,
    // and it comes from the plan rather than from a flag so a resumed process cannot be
    // told a different batch than the one recorded beside its Samples.
    const plan = buildRunPlan({
      runId: "2026-09-04_08-00-00_stage/s",
      batchId: "2026-09-v2",
      datasetId: "fleurs/da_dk",
      harness: CODICTATE_V2_HARNESS,
      model: "large-v3-turbo-q5_0",
      consumableClipIds: POOL,
      warmupClipIds: WARMUPS,
      fromIndex: 0,
      toIndex: 3,
      createdAt: "2026-09-04T08:00:00.000Z",
    });

    const record = stageRecord({
      runId: plan.runId,
      plan,
      status: "incomplete",
      startedAt: "2026-09-04T08:00:00.000Z",
      completedAt: null,
      samples: [],
    });

    expect(record.batchId).toBe("2026-09-v2");
    expect(record.plan.batchId).toBe("2026-09-v2");
    expect(parseRunRecordV2(record)).not.toBeNull();
  });

  test("a run with no --batch carries no batchId at all", () => {
    // Absent, not an empty string: a stage that belongs to no batch must not look like a
    // stage of a batch named "".
    const plan = planFor("2026-09-04_08-00-00_solo/s", 0, 3);
    const record = stageRecord({
      runId: plan.runId,
      plan,
      status: "incomplete",
      startedAt: "2026-09-04T08:00:00.000Z",
      completedAt: null,
      samples: [],
    });
    expect("batchId" in record).toBe(false);
  });
});

describe("the v2 stage store", () => {
  test("a Run Plan is written once and refuses to be rewritten", () => {
    // Immutability is the whole resume story: a resumed process re-reads this rather than
    // rebuilding one from the current flags. A second write would be a silent change of
    // selection under measurements already recorded against the first one.
    const runDir = tempDir();
    const plan = planFor("run/s", 0, 10);
    writeStagePlan(runDir, "s", plan);

    expect(existsSync(stagePlanPath(runDir, "s"))).toBe(true);
    expect(() => writeStagePlan(runDir, "s", plan)).toThrow(/immutable/);
  });

  test("the stage id names the dataset, the Harness bucket and the model", () => {
    expect(stageIdFor("da_dk", "crispasr", "large-v3-q5_0")).toBe(
      "da_dk__crispasr__large-v3-q5_0",
    );
    expect(datasetIdFor("fleurs", "da_dk")).toBe("fleurs/da_dk");
    expect(datasetIdFor("librispeech", "test-clean")).toBe(
      "librispeech/test-clean",
    );
  });

  test("a record's status is explicit, never inferred from its sample count", () => {
    const plan = planFor("run/s", 0, 3);
    const full = stageRecord({
      runId: plan.runId,
      plan,
      status: "incomplete",
      startedAt: "2026-09-04T08:00:00.000Z",
      completedAt: null,
      samples: plan.orderedClipIds.map((clipId) => sampleOf(clipId)),
    });

    // Every Sample the plan asked for, and still not a completed run: a process killed
    // after its last clip and before its footer looks exactly like this.
    expect(full.samples).toHaveLength(3);
    expect(full.status).toBe("incomplete");
    expect(full.completedAt).toBeNull();
    expect(full.harness).toBe(CODICTATE_V2_HARNESS);
    expect(parseRunRecordV2(full)).not.toBeNull();
  });
});

describe("a crash mid-run, end to end over the run directory", () => {
  test("no scored clip is lost, and the resume re-transcribes none of them", async () => {
    // The acceptance test for defect 11, at the level the operator experiences it: a real
    // run directory, a real per-clip write, a kill, and a resume that reads what is on
    // disk. The old checkpoint interval was 50 clips, so a kill at clip 149 left the
    // record at 100 and the resume paid for 49 clips twice - and, worse, the checkpoint
    // claimed a depth the record could not back up.
    const root = tempDir();
    const runName = "2026-09-04_08-00-00_crash-test";
    const runDir = join(root, runName);
    mkdirSync(runDir, { recursive: true });

    const plan = planFor(`${runName}/s`, 0, 25);
    writeStagePlan(runDir, "s", plan);

    const entries = entriesFor(plan);
    const first = countingAdapter();

    // Session one: killed after the 13th scored clip.
    const crashAfter = 13;

    try {
      await measureClips({
        plan,
        entriesByClipId: entries,
        adapter: first,
        onScoredClip: (samples) => {
          writeStageRecord(
            runDir,
            "s",
            stageRecord({
              runId: plan.runId,
              plan,
              status: "incomplete",
              startedAt: "2026-09-04T08:00:00.000Z",
              completedAt: null,
              samples,
            }),
          );
          if (samples.filter((s) => !s.isWarmup).length >= crashAfter) {
            throw new StopSession();
          }
        },
      });
    } catch (error) {
      if (!(error instanceof StopSession)) throw error;
    }

    // What is on disk after the kill: every clip that was measured, and nothing else.
    const afterCrash = loadV2Stages(root);
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0].record!.status).toBe("incomplete");
    expect(
      afterCrash[0].record!.samples.filter((s) => !s.isWarmup),
    ).toHaveLength(crashAfter);
    // An incomplete run contributes nothing to the cursor, not even those 13 clips.
    expect(completedV2Records(afterCrash)).toHaveLength(0);
    expect(incompleteV2Stages(afterCrash)).toHaveLength(1);

    // Session two: the resume reads the plan from disk, not from any flag.
    const resumed = incompleteV2Stages(loadV2Stages(root))[0];
    expect(resumed.plan.orderedClipIds).toEqual(plan.orderedClipIds);

    const second = countingAdapter();
    const outcome = await measureClips({
      plan: resumed.plan,
      entriesByClipId: entries,
      adapter: second,
      recordedSamples: resumed.record.samples,
      onScoredClip: (samples) => {
        writeStageRecord(
          runDir,
          "s",
          stageRecord({
            runId: plan.runId,
            plan,
            status: "incomplete",
            startedAt: resumed.record.startedAt,
            completedAt: null,
            samples,
          }),
        );
      },
    });

    writeStageRecord(
      runDir,
      "s",
      stageRecord({
        runId: plan.runId,
        plan,
        status: "completed",
        startedAt: resumed.record.startedAt,
        completedAt: "2026-09-04T09:00:00.000Z",
        samples: outcome.samples,
      }),
    );

    const scored = outcome.samples.filter((s) => !s.isWarmup);
    expect(scored).toHaveLength(25);
    expect(uniqueInOrder(scored.map((s) => s.clipId))).toHaveLength(25);
    // Zero clips repeated: the second session transcribed the 12 that were missing,
    // plus the three warmups every session replays.
    expect(second.audioPaths.length - plan.warmupClipIds.length).toBe(
      25 - crashAfter,
    );

    const finished = completedV2Records(loadV2Stages(root));
    expect(finished).toHaveLength(1);
    // And the depth the run publishes is 25, with a Sample behind every clip of it.
    const leaf = leafFromSamples(finished[0].samples, {
      range: { startIndex: 0, endIndex: 25, manifestFingerprint: "100:abc" },
      peakRSS_MB: null,
      computeCer: false,
    });
    expect(leaf.utteranceCount).toBe(25);
    expect(leaf.referenceWords).toBe(250);
  });

  test("the record file lands under the underscore-prefixed v2 directory", () => {
    const root = tempDir();
    const runDir = join(root, "2026-09-04_08-00-00_layout");
    mkdirSync(runDir, { recursive: true });
    const plan = planFor("2026-09-04_08-00-00_layout/s", 0, 1);
    writeStagePlan(runDir, "s", plan);

    expect(stageRecordPath(runDir, "s")).toContain(
      `${V2_RECORDS_DIRNAME}/s.run.json`,
    );
    expect(stagePlanPath(runDir, "s")).toContain(
      `${V2_RECORDS_DIRNAME}/s.plan.json`,
    );
  });
});

// -- fixtures --

const POOL = Array.from(
  { length: 100 },
  (_, i) => `fleurs/da_dk/audio/test/1${String(i).padStart(18, "0")}.wav`,
);
const WARMUPS = Array.from(
  { length: 3 },
  (_, i) => `fleurs/da_dk/audio/test/9${String(i).padStart(18, "0")}.wav`,
);

function planFor(runId: string, from: number, to: number): RunPlan {
  return buildRunPlan({
    runId,
    datasetId: "fleurs/da_dk",
    harness: CODICTATE_V2_HARNESS,
    model: "large-v3-turbo-q5_0",
    consumableClipIds: POOL,
    warmupClipIds: WARMUPS,
    fromIndex: from,
    toIndex: to,
    createdAt: "2026-09-04T08:00:00.000Z",
  });
}

function sampleOf(clipId: string): SampleMeasurementV2 {
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
  };
}

function entriesFor(plan: RunPlan): Map<string, ManifestEntry> {
  const entries = new Map<string, ManifestEntry>();
  for (const clipId of [...plan.warmupClipIds, ...plan.orderedClipIds]) {
    entries.set(clipId, {
      id: "da_dk_1",
      clipId,
      sentenceId: "1",
      audioPath: `/corpus/${clipId}`,
      transcript: "ti ord her som reference til denne optagelse lige nu",
      rawTranscript: "Ti ord her som reference til denne optagelse lige nu.",
      language: "da",
      audioDurationSec: 5,
    });
  }
  return entries;
}

function countingAdapter(): AdapterSeam & { audioPaths: string[] } {
  const audioPaths: string[] = [];
  return {
    audioPaths,
    prepare: (entry) =>
      ({
        engineId: "whisper_cpp",
        speechModelId: "large-v3-turbo-q5_0",
        audioPath: entry.audioPath,
        modelPath: "/weights/turbo.bin",
        languageCode: entry.language,
        translateToEnglish: false,
        crispasrBackend: null,
      }) as TranscriptionRequest,
    invoke: async (request): Promise<TranscriptionResult> => {
      audioPaths.push(request.audioPath);
      return {
        status: "ok",
        rawTranscript:
          "ti ord her som reference til denne optagelse lige ekstra",
      };
    },
  };
}

/** A kill, as an exception, thrown from the per-clip checkpoint hook. */
class StopSession extends Error {
  constructor() {
    super("simulated crash");
  }
}

/**
 * Peak RSS is the one number a pooled leaf cannot compute from its Samples: it is
 * measured once per session on ten clips, so nothing on a v2 record carries it. The run
 * that produced those Samples did write it, though - onto the v1 leaf in its own
 * `stt.json` - and `--aggregate` overwrites exactly that leaf with the pooled one.
 *
 * Worth pinning because the failure is silent and downstream: the aggregate stays
 * well-formed, every rate in it is correct, and the only symptom is a dash in the RAM
 * column of a website reading a file that no longer knows how much memory anything used.
 */
describe("peak RSS on a pooled leaf", () => {
  test("one contributing run hands its triple over unchanged", () => {
    expect(
      pooledPeakRss([
        {
          peakRSS_MB: { min: 1532, avg: 1534, max: 1534 },
          utteranceCount: 400,
        },
      ]),
    ).toEqual({ min: 1532, avg: 1534, max: 1534 });
  });

  test("several runs merge as min of mins, max of maxes, utterance-weighted avg", () => {
    // 400 clips at 1000 MB against 100 at 1500: (400*1000 + 100*1500) / 500 = 1100, not
    // the 1250 an unweighted mean would publish. The top-up is a fifth of the sample and
    // gets a fifth of the vote.
    expect(
      pooledPeakRss([
        { peakRSS_MB: { min: 990, avg: 1000, max: 1010 }, utteranceCount: 400 },
        {
          peakRSS_MB: { min: 1400, avg: 1500, max: 1600 },
          utteranceCount: 100,
        },
      ]),
    ).toEqual({ min: 990, avg: 1100, max: 1600 });
  });

  test("a run that measured no RSS is left out rather than counted as zero", () => {
    expect(
      pooledPeakRss([
        { peakRSS_MB: null, utteranceCount: 400 },
        { peakRSS_MB: { min: 78, avg: 80, max: 83 }, utteranceCount: 20 },
      ]),
    ).toEqual({ min: 78, avg: 80, max: 83 });
  });

  test("no contributing run measured it: null, which renders as a dash", () => {
    expect(
      pooledPeakRss([
        { peakRSS_MB: null, utteranceCount: 400 },
        { peakRSS_MB: null, utteranceCount: 100 },
      ]),
    ).toBeNull();
  });

  test("the lookup asks the contributing runs, for the same combination", () => {
    const results = (
      peak: PeakRSSStats | null,
      utteranceCount: number,
      modelId = "large-v3-q5_0",
    ): BenchmarkResults =>
      ({
        description: "",
        hardware: {} as BenchmarkResults["hardware"],
        runDate: "2026-09-05T00:00:00.000Z",
        config: {
          sampleSize: utteranceCount,
          warmupCount: 3,
          normalization: "whisper-basic",
        },
        librispeech: {
          "test-clean": {
            crispasr: {
              [modelId]: {
                wer: 0.03,
                meanRTF: 0.2,
                peakRSS_MB: peak,
                utteranceCount,
                failures: 0,
                totalAudioSec: 100,
                totalWallSec: 20,
              },
            },
          },
        },
        fleurs: {},
      }) as BenchmarkResults;

    const leaf = {
      field: "librispeech" as const,
      datasetKey: "test-clean",
      harness: "crispasr" as const,
      modelId: "large-v3-q5_0",
      runIds: ["deep/stage", "topup/stage"],
    };
    const runNames = new Map([
      ["deep/stage", "2026-09-05_04-27-04_deep"],
      ["topup/stage", "2026-09-05_09-00-00_topup"],
      // A run that pooled nothing into this leaf, and must not be consulted.
      ["other/stage", "2026-09-05_10-00-00_other"],
    ]);
    const v1 = new Map([
      [
        "2026-09-05_04-27-04_deep",
        results({ min: 990, avg: 1000, max: 1010 }, 400),
      ],
      [
        "2026-09-05_09-00-00_topup",
        results({ min: 1400, avg: 1500, max: 1600 }, 100),
      ],
      [
        "2026-09-05_10-00-00_other",
        results({ min: 9000, avg: 9000, max: 9000 }, 400),
      ],
    ]);

    expect(peakRssForPooledLeaf(leaf, runNames, v1)).toEqual({
      min: 990,
      avg: 1100,
      max: 1600,
    });

    // Same runs, a Model they never measured: nothing to carry over.
    expect(
      peakRssForPooledLeaf({ ...leaf, modelId: "medium-q5_0" }, runNames, v1),
    ).toBeNull();
    // A run id no stage claims cannot be resolved to a directory, so it contributes
    // nothing rather than picking up a neighbour's figure.
    expect(
      peakRssForPooledLeaf({ ...leaf, runIds: ["ghost/stage"] }, runNames, v1),
    ).toBeNull();
  });
});
