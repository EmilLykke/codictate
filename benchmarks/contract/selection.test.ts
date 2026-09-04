/**
 * Selection and resume: the cursor that must not jump a gap, the flags a resume must
 * refuse, and the warmups a resume must not skip.
 *
 * Every case here is a silent failure. A cursor that advances across a gap publishes a
 * depth over clips nobody transcribed. A resume that accepts `--from` files a partial
 * numerator against clips it never saw. A resume that treats warmups as completed clips
 * stops warming the model and charges the first real clip for the cold start. None of
 * the three makes a Benchmark Run crash, and none is visible in the numbers it writes -
 * which is the same reason `benchmarks/stt/sample-cursor.test.ts` exists for v1.
 */

import { describe, expect, test } from "bun:test";
import {
  assertNoOverlappingIncompleteRun,
  assertResumeFlags,
  assertRunPlanOnDisk,
  buildRunPlan,
  contiguousCursor,
  isRunPlan,
  maxMeasuredEnd,
  overlappingClipIds,
  overlaps,
  RESUME_FORBIDDEN_FLAGS,
  resumeSelection,
  runPlanComplaints,
  runPlanRef,
  type RunPlan,
} from "./selection";
import {
  fingerprintV2,
  fingerprintV2Record,
  type SampleMeasurementV2,
} from "./schema";

/** A dataset's ordered consumable list of distinguishable clipIds. */
function pool(count: number, prefix = "fleurs/da_dk/audio/test/c"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}.wav`);
}

function plan(over: Partial<Parameters<typeof buildRunPlan>[0]> = {}): RunPlan {
  return buildRunPlan({
    runId: "r1",
    datasetId: "fleurs/da_dk",
    harness: "codictate",
    model: "large-v3-turbo-q5_0",
    consumableClipIds: pool(10),
    fromIndex: 0,
    toIndex: 5,
    createdAt: "2026-09-04T08:17:20.000Z",
    ...over,
  });
}

function measured(
  clipId: string,
  over: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
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
    ...over,
  };
}

describe("a Run Plan is fixed before the first clip", () => {
  test("it carries the selected clips, in order, with their fingerprint", () => {
    const p = plan({ fromIndex: 2, toIndex: 5 });
    expect(p.orderedClipIds).toEqual(pool(10).slice(2, 5));
    expect(p.fingerprintV2).toEqual({
      version: "benchmark-v2",
      value: fingerprintV2(pool(10).slice(2, 5)),
    });
    expect(runPlanRef(p).clipCount).toBe(3);
    expect(runPlanRef(p).fingerprintV2).toBe(p.fingerprintV2);
  });

  test("it is frozen, so a resumed process re-reads it rather than re-deriving it", () => {
    const p = plan();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.orderedClipIds)).toBe(true);
    expect(() => {
      (p as { runId: string }).runId = "r2";
    }).toThrow();
  });

  test("a range past the end of the pool is refused, not clamped", () => {
    // The opposite of `planRange` in stt/sample-cursor.ts, which is forgiving because it
    // turns a demand into a range. By this point the range is decided, so a clamp would
    // fingerprint a selection nobody asked for.
    expect(() => plan({ toIndex: 11 })).toThrow(
      /past the end of fleurs\/da_dk/,
    );
    expect(() => plan({ fromIndex: -1 })).toThrow(/non-negative integer/);
    expect(() => plan({ fromIndex: 4, toIndex: 2 })).toThrow(
      /at or after fromIndex/,
    );
  });

  test("a 400-clip range names 400 distinct clips", () => {
    // Acceptance gate 1, the contract half: over a pool the size of the real da_dk
    // FLEURS list, a 400-clip range yields 400 distinct clipIds, so the adapter is
    // invoked 400 times on 400 different audio files. Keyed on TSV column 0 the same
    // range would name 400 clipIds and far fewer files.
    const big = plan({
      consumableClipIds: pool(930),
      fromIndex: 0,
      toIndex: 400,
    });
    expect(big.orderedClipIds.length).toBe(400);
    expect(new Set(big.orderedClipIds).size).toBe(400);
    expect(runPlanRef(big).clipCount).toBe(400);
  });

  test("a duplicate in the selection is refused", () => {
    expect(() =>
      plan({ consumableClipIds: ["a.wav", "b.wav", "a.wav"], toIndex: 3 }),
    ).toThrow(/Run Plan r1 \(fleurs\/da_dk\) names the same clip twice/);
  });

  test("a clip cannot be both warmed and scored", () => {
    expect(() => plan({ warmupClipIds: [pool(10)[0]] })).toThrow(
      /both warms and scores/,
    );
    // Warmups from outside the selection are fine, and are what a resume replays.
    expect(
      plan({ warmupClipIds: ["w0.wav", "w1.wav", "w2.wav"] }).warmupClipIds,
    ).toEqual(["w0.wav", "w1.wav", "w2.wav"]);
  });
});

describe("reading a Run Plan back off disk", () => {
  /** The plan as it lands in JSON: frozen object, plain data, no methods. */
  function onDisk(over: Record<string, unknown> = {}): unknown {
    return JSON.parse(JSON.stringify({ ...plan({ runId: "r1" }), ...over }));
  }

  test("a plan written by buildRunPlan round-trips through JSON", () => {
    expect(runPlanComplaints(onDisk())).toEqual([]);
    expect(isRunPlan(onDisk())).toBe(true);
    expect(() => assertRunPlanOnDisk(onDisk(), "r1")).not.toThrow();
  });

  test("a non-object is refused before anything is read off it", () => {
    for (const value of [null, undefined, 7, "a plan", [1, 2, 3]]) {
      expect(isRunPlan(value)).toBe(false);
    }
    expect(runPlanComplaints(null)).toEqual(["it is not an object"]);
  });

  test("an empty clip list has nothing to resume", () => {
    // Legal in memory, illegal on disk: a zero-length list is what a half-written file
    // looks like, and a plan naming no clips cannot be resumed either way.
    const empty = onDisk({
      orderedClipIds: [],
      toIndex: 0,
      fingerprintV2: fingerprintV2Record([]),
    });
    expect(isRunPlan(empty)).toBe(false);
    expect(runPlanComplaints(empty)).toContain(
      "orderedClipIds is empty, so there is nothing to resume",
    );
  });

  test("a clip list that is not strings is refused", () => {
    expect(isRunPlan(onDisk({ orderedClipIds: undefined }))).toBe(false);
    expect(isRunPlan(onDisk({ orderedClipIds: [1, 2, 3] }))).toBe(false);
  });

  test("a duplicate clipId is refused, naming the clip and both indices", () => {
    const dupes = [pool(10)[0], pool(10)[1], pool(10)[0]];
    const complaints = runPlanComplaints(
      onDisk({
        orderedClipIds: dupes,
        fromIndex: 0,
        toIndex: 3,
        fingerprintV2: fingerprintV2Record(dupes),
      }),
    );
    expect(complaints.join(" ")).toMatch(/at index 0 and index 2/);
  });

  test("a fingerprint that does not describe its own clip list is refused", () => {
    // The load-bearing check, and the one a field-types-only validator passes. A plan
    // whose fingerprint no longer matches its list would let a pooled read agree with a
    // run it never matched.
    const forked = onDisk({
      fingerprintV2: fingerprintV2Record(["other.wav"]),
    });
    expect(isRunPlan(forked)).toBe(false);
    expect(runPlanComplaints(forked).join(" ")).toMatch(
      /does not match its own orderedClipIds/,
    );

    // Equivalently: the clip list edited under a still-correct-looking fingerprint.
    const edited = onDisk({
      orderedClipIds: [...pool(10).slice(0, 4), "smuggled.wav"],
    });
    expect(isRunPlan(edited)).toBe(false);
  });

  test("a v1 or unversioned fingerprint is not accepted as a v2 one", () => {
    for (const fingerprintV2Field of [
      "905:0f1e2d3c4b5a6978",
      { version: "benchmark-v1", value: fingerprintV2(pool(10).slice(0, 5)) },
      { value: fingerprintV2(pool(10).slice(0, 5)) },
      undefined,
    ]) {
      const complaints = runPlanComplaints(
        onDisk({ fingerprintV2: fingerprintV2Field }),
      );
      expect(complaints.join(" ")).toMatch(/fingerprintV2 must be/);
    }
  });

  test("indices that disagree with the clip list are refused", () => {
    expect(runPlanComplaints(onDisk({ toIndex: 4 })).join(" ")).toMatch(
      /\[0, 4\) spans 4 clips but orderedClipIds has 5/,
    );
    expect(runPlanComplaints(onDisk({ fromIndex: 1 })).join(" ")).toMatch(
      /spans 4 clips but orderedClipIds has 5/,
    );
    expect(isRunPlan(onDisk({ fromIndex: -1 }))).toBe(false);
    expect(isRunPlan(onDisk({ toIndex: "5" }))).toBe(false);
  });

  test("the identity strings must be present and non-empty", () => {
    for (const field of [
      "runId",
      "datasetId",
      "harness",
      "model",
      "createdAt",
    ]) {
      expect(isRunPlan(onDisk({ [field]: "" }))).toBe(false);
      expect(isRunPlan(onDisk({ [field]: undefined }))).toBe(false);
    }
    expect(isRunPlan(onDisk({ batchId: "2026-09-v2" }))).toBe(true);
    expect(isRunPlan(onDisk({ batchId: 7 }))).toBe(false);
  });

  test("a warmup that is also scored is refused", () => {
    expect(isRunPlan(onDisk({ warmupClipIds: [pool(10)[0]] }))).toBe(false);
    expect(isRunPlan(onDisk({ warmupClipIds: undefined }))).toBe(false);
    expect(isRunPlan(onDisk({ warmupClipIds: ["w0.wav"] }))).toBe(true);
  });

  test("every complaint is reported at once, and the message says not to repair it", () => {
    // A hand-edited plan usually has more than one thing wrong with it.
    const mangled = onDisk({ runId: "", toIndex: 99 });
    expect(runPlanComplaints(mangled).length).toBeGreaterThan(1);
    expect(() => assertRunPlanOnDisk(mangled)).toThrow(
      /not something to repair in place/,
    );
    expect(() => assertRunPlanOnDisk(mangled)).toThrow(
      /Run Plan is not usable/,
    );
    expect(() => assertRunPlanOnDisk(mangled, "r1")).toThrow(
      /Run Plan for r1 is not usable/,
    );
  });

  test("resuming by run id refuses a plan belonging to another run", () => {
    // The failure "find the latest unfinished run" used to produce silently.
    expect(() => assertRunPlanOnDisk(onDisk(), "r-other")).toThrow(
      /Asked to resume r-other but this Run Plan belongs to r1/,
    );
  });
});

describe("the cursor is the contiguous measured prefix", () => {
  const ordered = pool(10);

  test("it advances while the prefix is unbroken", () => {
    expect(contiguousCursor(ordered, ordered.slice(0, 4))).toBe(4);
    expect(contiguousCursor(ordered, ordered)).toBe(10);
    expect(contiguousCursor(ordered, [])).toBe(0);
  });

  test("a gap does not advance it, and maxMeasuredEnd does", () => {
    // Clips 0-3 and 6-9 measured, 4 and 5 never transcribed. "Measured 10 deep" would be
    // a published claim about two clips nobody has heard.
    const withGap = [...ordered.slice(0, 4), ...ordered.slice(6, 10)];
    expect(contiguousCursor(ordered, withGap)).toBe(4);
    expect(maxMeasuredEnd(ordered, withGap)).toBe(10);
    // The two disagreeing is the signal: 4 measured contiguously, 8 measured in total.
    expect(maxMeasuredEnd(ordered, withGap)).toBeGreaterThan(
      contiguousCursor(ordered, withGap),
    );
  });

  test("a measured clip from another plan does not advance either number", () => {
    expect(
      contiguousCursor(ordered, ["librispeech/wav/test-clean/x.wav"]),
    ).toBe(0);
    expect(maxMeasuredEnd(ordered, ["librispeech/wav/test-clean/x.wav"])).toBe(
      0,
    );
  });

  test("both accept a Set as well as a list", () => {
    expect(contiguousCursor(ordered, new Set(ordered.slice(0, 3)))).toBe(3);
    expect(maxMeasuredEnd(ordered, new Set(ordered.slice(0, 3)))).toBe(3);
  });
});

describe("overlap is decided on clipId sets", () => {
  test("disjoint continuations do not overlap", () => {
    const first = plan({ runId: "r1", fromIndex: 0, toIndex: 5 });
    const second = plan({ runId: "r2", fromIndex: 5, toIndex: 10 });
    expect(overlaps(first, second)).toBe(false);
    expect(overlappingClipIds(first, second)).toEqual([]);
  });

  test("a rerun over the same clips overlaps, and names them", () => {
    const first = plan({ runId: "r1", fromIndex: 0, toIndex: 5 });
    const rerun = plan({ runId: "r2", fromIndex: 3, toIndex: 8 });
    expect(overlaps(first, rerun)).toBe(true);
    expect(overlappingClipIds(first, rerun)).toEqual(pool(10).slice(3, 5));
  });

  test("two datasets that share an index range share no clips", () => {
    // Why overlap is not an index comparison: both plans are [0, 5) and they measure
    // ten different files.
    const danish = plan({ runId: "r1", consumableClipIds: pool(10) });
    const spanish = plan({
      runId: "r2",
      datasetId: "fleurs/es_419",
      consumableClipIds: pool(10, "fleurs/es_419/audio/test/c"),
    });
    expect(danish.fromIndex).toBe(spanish.fromIndex);
    expect(overlaps(danish, spanish)).toBe(false);
  });

  test("a new run over an incomplete run's clips is blocked by run id", () => {
    const incomplete = plan({ runId: "r-dead", fromIndex: 0, toIndex: 5 });
    const fresh = plan({ runId: "r-new", fromIndex: 4, toIndex: 9 });
    expect(() =>
      assertNoOverlappingIncompleteRun(fresh, [
        { runId: incomplete.runId, orderedClipIds: incomplete.orderedClipIds },
      ]),
    ).toThrow(/r-dead is incomplete and shares 1 clip/);
    // A disjoint continuation is exactly what the cursor is for, and is not blocked.
    expect(() =>
      assertNoOverlappingIncompleteRun(plan({ fromIndex: 5, toIndex: 10 }), [
        { runId: incomplete.runId, orderedClipIds: incomplete.orderedClipIds },
      ]),
    ).not.toThrow();
  });
});

describe("a resume refuses every selection-changing flag", () => {
  test("each forbidden flag is rejected by name", () => {
    for (const flag of RESUME_FORBIDDEN_FLAGS) {
      expect(() =>
        assertResumeFlags(["--resume", "r1", flag, "7"], "r1"),
      ).toThrow(
        new RegExp(`^\\${flag} cannot be combined with a resume of r1`),
      );
      // `--flag=value` is the same flag.
      expect(() => assertResumeFlags([`${flag}=7`])).toThrow(
        new RegExp(`^\\${flag} cannot be combined with a resume`),
      );
    }
  });

  test("the flags SPEC names are all on the list", () => {
    for (const flag of [
      "--from",
      "--to",
      "--dataset",
      "--models",
      "--seed",
      "--limit",
    ]) {
      expect(RESUME_FORBIDDEN_FLAGS as readonly string[]).toContain(flag);
    }
  });

  test("--batch and --out are allowed, because they select nothing", () => {
    // The orchestrator passes --batch on every invocation including the resuming ones,
    // and --out moves where a report is written rather than what was measured.
    expect(() =>
      assertResumeFlags([
        "--resume",
        "r1",
        "--batch",
        "2026-09-v2",
        "--out",
        "results/staging",
      ]),
    ).not.toThrow();
  });

  test("a value that looks like a flag is not a flag", () => {
    expect(() => assertResumeFlags(["--resume", "r1"])).not.toThrow();
    expect(() => assertResumeFlags(["from", "to", "models"])).not.toThrow();
  });
});

describe("what a resumed process runs", () => {
  const p = plan({
    fromIndex: 0,
    toIndex: 5,
    warmupClipIds: ["w0.wav", "w1.wav", "w2.wav"],
  });
  const clips = p.orderedClipIds;

  test("warmups always replay, whatever the records say", () => {
    const withWarmupRecords = [
      measured("w0.wav", { isWarmup: true }),
      measured("w1.wav", { isWarmup: true }),
      measured("w2.wav", { isWarmup: true }),
      measured(clips[0]),
    ];
    const selection = resumeSelection(p, withWarmupRecords);
    expect(selection.warmupsToReplay).toEqual(["w0.wav", "w1.wav", "w2.wav"]);
    // And they are not treated as completed clips, so completed-ID filtering cannot
    // remove them.
    expect(selection.scoredToSkip).toEqual([clips[0]]);
    expect(selection.remaining).toEqual(clips.slice(1));
  });

  test("a completed scored clip is never re-transcribed", () => {
    const selection = resumeSelection(
      p,
      clips.slice(0, 3).map((c) => measured(c)),
    );
    expect(selection.scoredToSkip).toEqual(clips.slice(0, 3));
    expect(selection.remaining).toEqual(clips.slice(3));
    expect([...selection.scoredToSkip, ...selection.remaining]).toEqual([
      ...clips,
    ]);
  });

  test("a recorded failure or timeout is a measurement, not a retry", () => {
    // Counted in failureCount by `pooledSpeed`, so re-running it would either double
    // count it or overwrite a real observation with a luckier one. A deliberate
    // re-measure is a new run with an explicit start index.
    const selection = resumeSelection(p, [
      measured(clips[0], { status: "failed", responseMs: null }),
      measured(clips[1], { status: "timeout", responseMs: null }),
    ]);
    expect(selection.scoredToSkip).toEqual(clips.slice(0, 2));
    expect(selection.remaining).toEqual(clips.slice(2));
  });

  test("records from outside the plan are ignored", () => {
    const selection = resumeSelection(p, [
      measured("fleurs/es_419/audio/test/c0.wav"),
      measured(clips[0]),
    ]);
    expect(selection.scoredToSkip).toEqual([clips[0]]);
    expect(selection.remaining.length).toBe(4);
  });

  test("remaining keeps plan order, which is what lets the cursor advance", () => {
    const selection = resumeSelection(p, [
      measured(clips[0]),
      measured(clips[1]),
    ]);
    expect(selection.remaining).toEqual([clips[2], clips[3], clips[4]]);
    // Running `remaining` in this order takes the contiguous cursor to the full plan.
    const measuredAfter = [...selection.scoredToSkip, ...selection.remaining];
    expect(contiguousCursor(clips, measuredAfter)).toBe(5);
  });
});
