/**
 * The sample cursor: what `--samples N` consumes, what it must never consume twice, and
 * what makes it refuse to run.
 *
 * Worth pinning because every failure mode here is silent. A cursor that double-counts
 * re-measures clips and reports a depth it does not have; a cursor that skips claims a
 * depth over clips nobody transcribed; a cursor read against a changed ordering is a
 * pointer into a list that no longer exists. None of those make a Benchmark Run crash, and
 * none of them are visible in the numbers it publishes.
 */

import { describe, expect, test } from "bun:test";
import {
  consumableEntries,
  cursorFor,
  foldRecordedRanges,
  formatPlanLine,
  fromIndexError,
  fromResumeRefusal,
  manifestFingerprint,
  manifestFingerprintConflicts,
  planRange,
  rangeOf,
  reservedWarmups,
  WARMUP_RESERVATION,
  type RecordedRange,
  type SampleRange,
} from "./sample-cursor";
import { recordedRangesFromRun } from "./coverage";

/** An ordered manifest of `count` distinguishable clip ids. */
function orderedIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `clip-${i}`);
}

const FINGERPRINT = manifestFingerprint(orderedIds(905));

describe("--samples N is a delta", () => {
  test("a second session starts where the first stopped", () => {
    const first = planRange(0, 902, { mode: "delta", count: 400 });
    expect(first.startIndex).toBe(0);
    expect(first.endIndex).toBe(400);
    expect(first.count).toBe(400);

    const second = planRange(first.endIndex, 902, {
      mode: "delta",
      count: 400,
    });
    expect(second.startIndex).toBe(400);
    expect(second.endIndex).toBe(800);
    expect(second.count).toBe(400);
    // The two sessions cover 800 distinct clips, not 400 clips twice, which is the whole
    // point: before the cursor, both sessions ran `entries.slice(0, 400)`.
    expect(second.startIndex).toBe(first.endIndex);
  });

  test("the delta is counted from the cursor, not from zero", () => {
    const plan = planRange(397, 902, { mode: "delta", count: 400 });
    expect(plan.startIndex).toBe(397);
    expect(plan.endIndex).toBe(797);
    expect(plan.remainingAfter).toBe(105);
  });

  test("the plan preview says which clips it will run", () => {
    expect(
      formatPlanLine(
        "large-v3-q5_0",
        "hu_hu",
        planRange(397, 902, { mode: "delta", count: 400 }),
      ),
    ).toBe(
      "[large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)",
    );
  });
});

describe("--to N is a target depth", () => {
  test("it runs only the shortfall", () => {
    const plan = planRange(397, 902, { mode: "target", depth: 400 });
    expect(plan.startIndex).toBe(397);
    expect(plan.endIndex).toBe(400);
    expect(plan.count).toBe(3);
  });

  test("re-running it once the depth is reached is a no-op", () => {
    // The reason `--to` exists: an overnight command that was interrupted has to be safe to
    // paste again, where a re-pasted `--samples 400` would consume another 400 clips.
    const plan = planRange(400, 902, { mode: "target", depth: 400 });
    expect(plan.count).toBe(0);
    expect(plan.endIndex).toBe(400);
    expect(plan.truncated).toBe(false);
    expect(formatPlanLine("tiny", "hu_hu", plan)).toBe(
      "[tiny] hu_hu: cursor 400 -> 400 (nothing to do: depth 400 already measured, 502 consumable clips remain)",
    );
  });

  test("a target already passed never moves the cursor backwards", () => {
    const plan = planRange(500, 902, { mode: "target", depth: 400 });
    expect(plan.startIndex).toBe(500);
    expect(plan.endIndex).toBe(500);
    expect(plan.count).toBe(0);
  });
});

describe("the warmup reservation", () => {
  const ordered = orderedIds(10);

  test("the same leading clips warm every session and are never scored", () => {
    expect(reservedWarmups(ordered)).toEqual(["clip-0", "clip-1", "clip-2"]);
    expect(reservedWarmups(ordered).length).toBe(WARMUP_RESERVATION);
    // Same three clips whatever the cursor is: the reservation is a property of the
    // dataset, not of the session.
    expect(reservedWarmups(ordered)).toEqual(reservedWarmups(ordered));
  });

  test("no session ever consumes a reserved warmup", () => {
    const consumable = consumableEntries(ordered);
    expect(consumable[0]).toBe(`clip-${WARMUP_RESERVATION}`);

    const first = planRange(0, consumable.length, { mode: "delta", count: 4 });
    const second = planRange(first.endIndex, consumable.length, {
      mode: "delta",
      count: 3,
    });
    const scored = [
      ...consumable.slice(first.startIndex, first.endIndex),
      ...consumable.slice(second.startIndex, second.endIndex),
    ];

    for (const warmup of reservedWarmups(ordered)) {
      expect(scored).not.toContain(warmup);
    }
    expect(scored).toEqual([
      "clip-3",
      "clip-4",
      "clip-5",
      "clip-6",
      "clip-7",
      "clip-8",
      "clip-9",
    ]);
    // Every clip once. A warmup that consumed would have shifted the second session by
    // three and re-scored nothing, silently shrinking the pool by three per session.
    expect(new Set(scored).size).toBe(scored.length);
  });

  test("the consumable total excludes the reservation", () => {
    expect(consumableEntries(orderedIds(905)).length).toBe(902);
  });
});

describe("exhaustion", () => {
  test("a short pool truncates instead of throwing", () => {
    const plan = planRange(850, 902, { mode: "delta", count: 400 });
    expect(plan.count).toBe(52);
    expect(plan.requested).toBe(400);
    expect(plan.truncated).toBe(true);
    expect(plan.endIndex).toBe(902);
    expect(plan.remainingAfter).toBe(0);
    expect(formatPlanLine("tiny", "hu_hu", plan)).toBe(
      "[tiny] hu_hu: cursor 850 -> 902 (clips 851-902 of 902 consumable, 52 of 400 requested - dataset exhausted, 0 remaining after)",
    );
  });

  test("an exhausted dataset yields an empty plan rather than wrapping around", () => {
    const plan = planRange(902, 902, { mode: "delta", count: 400 });
    expect(plan.count).toBe(0);
    expect(plan.startIndex).toBe(902);
    expect(plan.endIndex).toBe(902);
    expect(formatPlanLine("tiny", "hu_hu", plan)).toBe(
      "[tiny] hu_hu: cursor 902 -> 902 (nothing left: all 902 consumable clips measured)",
    );
  });

  test("the recorded range is the true depth, not the requested one", () => {
    const plan = planRange(850, 902, { mode: "delta", count: 400 });
    expect(rangeOf(plan, FINGERPRINT)).toEqual({
      startIndex: 850,
      endIndex: 902,
      manifestFingerprint: FINGERPRINT,
    });
  });
});

describe("--from N is an explicit start index", () => {
  test("it overrides the cursor for this run only", () => {
    const forward = planRange(397, 902, { mode: "delta", count: 400 });
    const rewound = planRange(397, 902, { mode: "delta", count: 400 }, 0);

    expect(forward.startIndex).toBe(397);
    // Same cursor, same depth flag. The only difference is that `--from` was given.
    expect(rewound.cursor).toBe(397);
    expect(rewound.startIndex).toBe(0);
    expect(rewound.endIndex).toBe(400);
    expect(rewound.fromIndex).toBe(0);
    expect(rewound.rewind).toBe(true);
    expect(rewound.count).toBe(400);
  });

  test("a delta is counted from --from, not from the cursor", () => {
    const plan = planRange(397, 902, { mode: "delta", count: 400 }, 0);
    expect(plan.startIndex).toBe(0);
    expect(plan.endIndex).toBe(400);
    expect(plan.count).toBe(400);
    expect(plan.remainingAfter).toBe(502);
  });

  test("a target is still a depth, so --from 0 --to 400 is the same range", () => {
    const delta = planRange(397, 902, { mode: "delta", count: 400 }, 0);
    const target = planRange(397, 902, { mode: "target", depth: 400 }, 0);

    expect(target.startIndex).toBe(0);
    expect(target.endIndex).toBe(400);
    expect(target.startIndex).toBe(delta.startIndex);
    expect(target.endIndex).toBe(delta.endIndex);
  });

  test("a target below --from selects nothing rather than running backwards", () => {
    const plan = planRange(397, 902, { mode: "target", depth: 200 }, 500);
    expect(plan.count).toBe(0);
    expect(formatPlanLine("tiny", "hu_hu", plan)).toBe(
      "[tiny] hu_hu: nothing to run: --from 500 with depth 200 selects no clips (cursor stays 397)",
    );
  });

  test("the plan preview marks a rewind and names the cursor it overrode", () => {
    // The one deliberately destructive path in the harness, so it must not be readable
    // as the ordinary forward line. The arrow runs backwards, the flag sits beside the
    // cursor it overrode, and 397 is spelled out as clips being spent a second time.
    expect(
      formatPlanLine(
        "large-v3-q5_0",
        "hu_hu",
        planRange(397, 902, { mode: "delta", count: 400 }, 0),
      ),
    ).toBe(
      "[large-v3-q5_0] hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)",
    );
  });

  test("the preview marks a start past the cursor as a gap, not a rewind", () => {
    const plan = planRange(397, 902, { mode: "delta", count: 100 }, 500);
    expect(plan.rewind).toBe(false);
    expect(plan.gap).toBe(true);
    expect(formatPlanLine("large-v3-q5_0", "hu_hu", plan)).toBe(
      "[large-v3-q5_0] hu_hu: GAP --from 500 starts past cursor 397 (clips 501-600 of 902 consumable, leaving clips 398-500 unmeasured; cursor ends at 600)",
    );
  });

  test("a forward run prints exactly the line it always printed", () => {
    expect(
      formatPlanLine(
        "large-v3-q5_0",
        "hu_hu",
        planRange(397, 902, { mode: "delta", count: 400 }),
      ),
    ).toBe(
      "[large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)",
    );
  });

  test("a rewound run records its range like any other and does not lower the cursor", () => {
    const forward = planRange(0, 902, { mode: "target", depth: 397 });
    const rewound = planRange(397, 902, { mode: "delta", count: 400 }, 0);

    const ranges: RecordedRange[] = [
      {
        runName: "2026-09-04_08-28-52_first-397",
        harness: "crispasr",
        modelId: "large-v3-q5_0",
        datasetKey: "hu_hu",
        utteranceCount: forward.count,
        range: rangeOf(forward, FINGERPRINT),
      },
      {
        runName: "2026-09-05_08-00-00_rewound-400",
        harness: "crispasr",
        modelId: "large-v3-q5_0",
        datasetKey: "hu_hu",
        utteranceCount: rewound.count,
        range: rangeOf(rewound, FINGERPRINT),
      },
    ];

    // The recorded range is exactly the range that ran: no special field, no flag.
    expect(rangeOf(rewound, FINGERPRINT)).toEqual({
      startIndex: 0,
      endIndex: 400,
      manifestFingerprint: FINGERPRINT,
    });

    const index = foldRecordedRanges(ranges);
    // The cursor is the deepest endIndex across runs, so re-measuring [0, 400) over a
    // cursor of 397 leaves it at 400. Nothing rewrites the 397 run and nothing subtracts.
    expect(
      cursorFor(index, "crispasr", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(400);
    expect(index.inconsistencies).toEqual([]);
  });

  test("a shallow rewind leaves the cursor exactly where it was", () => {
    const forward = planRange(0, 902, { mode: "target", depth: 397 });
    const shallow = planRange(397, 902, { mode: "delta", count: 200 }, 0);

    expect(shallow.cursorAfter).toBe(397);

    const index = foldRecordedRanges([
      {
        runName: "2026-09-04_08-28-52_first-397",
        harness: "crispasr",
        modelId: "large-v3-q5_0",
        datasetKey: "hu_hu",
        utteranceCount: forward.count,
        range: rangeOf(forward, FINGERPRINT),
      },
      {
        runName: "2026-09-05_08-00-00_rewound-200",
        harness: "crispasr",
        modelId: "large-v3-q5_0",
        datasetKey: "hu_hu",
        utteranceCount: shallow.count,
        range: rangeOf(shallow, FINGERPRINT),
      },
    ]);

    expect(
      cursorFor(index, "crispasr", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(397);
  });
});

describe("--from validation", () => {
  const pools = new Map([
    ["test-clean", 2617],
    ["hu_hu", 902],
  ]);

  test("an index inside every selected dataset is accepted", () => {
    expect(fromIndexError(0, pools)).toBeNull();
    expect(fromIndexError(901, pools)).toBeNull();
  });

  test("an index past a dataset's consumable count is rejected by name and count", () => {
    // Clamping is what would make this dangerous: `--from 5000` would otherwise measure
    // nothing and record a depth of 902.
    expect(fromIndexError(902, pools)).toBe(
      "Error: --from 902 is out of range for hu_hu: it has 902 consumable clips, so the valid --from indices are 0-901.",
    );
    expect(fromIndexError(5000, pools)).toBe(
      "Error: --from 5000 is out of range for test-clean: it has 2617 consumable clips, so the valid --from indices are 0-2616.",
    );
  });

  test("a negative index is rejected", () => {
    expect(fromIndexError(-1, pools)).toBe(
      "Error: --from must be a non-negative integer index into the consumable range, got -1.",
    );
  });

  test("a dataset with nothing consumable says so rather than naming an index range", () => {
    expect(fromIndexError(0, new Map([["tiny", 0]]))).toBe(
      "Error: --from 0 is out of range for tiny: it has 0 consumable clips, so there is nothing for --from to point at.",
    );
  });

  test("--from is refused while an unfinished run is on disk", () => {
    const refusal = fromResumeRefusal(
      0,
      "benchmarks/results/2026-09-05_08-00-00_interrupted",
    );
    expect(refusal).not.toBeNull();
    expect(refusal![0]).toContain("--from cannot be combined with a resume");
    expect(refusal![0]).toContain(
      "benchmarks/results/2026-09-05_08-00-00_interrupted",
    );
  });

  test("nothing is refused when there is nothing to resume, or no --from", () => {
    expect(fromResumeRefusal(0, null)).toBeNull();
    expect(
      fromResumeRefusal(
        null,
        "benchmarks/results/2026-09-05_08-00-00_interrupted",
      ),
    ).toBeNull();
  });
});

describe("the manifest fingerprint", () => {
  test("it names the ordered list, count first", () => {
    expect(manifestFingerprint(orderedIds(905))).toMatch(/^905:[0-9a-f]{16}$/);
  });

  test("the same list fingerprints the same way twice", () => {
    expect(manifestFingerprint(orderedIds(50))).toBe(
      manifestFingerprint(orderedIds(50)),
    );
  });

  test("reordering the same clips changes it", () => {
    // The LibriSpeech case exactly: same 2620 clips, different order, so every stored
    // offset points somewhere else.
    const ordered = orderedIds(50);
    const swapped = [...ordered];
    [swapped[3], swapped[9]] = [swapped[9], swapped[3]];
    expect(manifestFingerprint(swapped)).not.toBe(manifestFingerprint(ordered));
  });

  test("gaining or losing a clip changes it", () => {
    expect(manifestFingerprint(orderedIds(51))).not.toBe(
      manifestFingerprint(orderedIds(50)),
    );
  });
});

describe("a changed ordering refuses the run", () => {
  const stale: RecordedRange = {
    runName: "2026-09-04_08-28-52_curated-400-wispr-comparison",
    harness: "crispasr",
    modelId: "large-v3-q5_0",
    datasetKey: "hu_hu",
    utteranceCount: 397,
    range: {
      startIndex: 0,
      endIndex: 397,
      manifestFingerprint: "905:deadbeefdeadbeef",
    },
  };

  test("a recorded ordering that is not the current one is a conflict", () => {
    const conflicts = manifestFingerprintConflicts(
      foldRecordedRanges([stale]),
      { hu_hu: FINGERPRINT },
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      datasetKey: "hu_hu",
      recorded: "905:deadbeefdeadbeef",
      current: FINGERPRINT,
      runs: ["2026-09-04_08-28-52_curated-400-wispr-comparison"],
    });
  });

  test("a matching ordering is not a conflict", () => {
    const matching: RecordedRange = {
      ...stale,
      range: { ...stale.range, manifestFingerprint: FINGERPRINT },
    };
    expect(
      manifestFingerprintConflicts(foldRecordedRanges([matching]), {
        hu_hu: FINGERPRINT,
      }),
    ).toEqual([]);
  });

  test("a stale ordering for a dataset this run did not select is not a conflict", () => {
    // A FLEURS-only run is not blocked by a LibriSpeech split it never touches.
    expect(
      manifestFingerprintConflicts(foldRecordedRanges([stale]), {
        "test-clean": manifestFingerprint(orderedIds(2620)),
      }),
    ).toEqual([]);
  });

  test("the cursor for a non-matching ordering is zero, never the stored depth", () => {
    // Belt and braces behind the refusal above: if a conflict were ever ignored, the
    // cursor still refuses to read an offset from the wrong list.
    const index = foldRecordedRanges([stale]);
    expect(
      cursorFor(index, "crispasr", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(0);
  });
});

describe("the cursor derived from the results tree", () => {
  /** A leaf as it sits in a run's `stt.json`, with or without a range. */
  function leaf(utteranceCount: number, range?: SampleRange) {
    return {
      wer: 0.1,
      referenceWords: 100,
      meanRTF: 0.2,
      peakRSS_MB: null,
      utteranceCount,
      failures: 0,
      totalAudioSec: 10,
      totalWallSec: 2,
      ...(range ? { sampleRange: range } : {}),
    };
  }

  const seededClean = manifestFingerprint(orderedIds(2620));

  /**
   * Two runs shaped like the real archive: one written before ASR Harness was a dimension,
   * whose LibriSpeech leaves the migration refused to place, and one keyed by Harness with
   * ranges throughout.
   */
  const preHarnessRun = {
    librispeech: {
      "test-clean": { "large-v3-q5_0": leaf(47), tiny: leaf(47) },
    },
    fleurs: {
      hu_hu: {
        "large-v3-q5_0": leaf(47, {
          startIndex: 0,
          endIndex: 47,
          manifestFingerprint: FINGERPRINT,
        }),
      },
    },
  };

  const recentRun = {
    librispeech: {
      "test-clean": {
        crispasr: {
          "large-v3-q5_0": leaf(397, {
            startIndex: 0,
            endIndex: 397,
            manifestFingerprint: seededClean,
          }),
        },
      },
    },
    fleurs: {
      hu_hu: {
        crispasr: {
          "large-v3-q5_0": leaf(200, {
            startIndex: 397,
            endIndex: 597,
            manifestFingerprint: FINGERPRINT,
          }),
        },
      },
    },
  };

  const index = foldRecordedRanges([
    ...recordedRangesFromRun(
      "2026-05-09_10-12-34_tiny-base-triage",
      preHarnessRun,
    ),
    ...recordedRangesFromRun(
      "2026-09-04_08-28-52_curated-400-wispr-comparison",
      recentRun,
    ),
  ]);

  test("a pre-harness run's leaves land under the Harness that produced them", () => {
    expect(
      cursorFor(index, "whisper-cli", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(47);
    expect(
      cursorFor(index, "crispasr", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(597);
  });

  test("the deepest endIndex across runs wins", () => {
    expect(
      cursorFor(index, "crispasr", "large-v3-q5_0", "test-clean", seededClean),
    ).toBe(397);
  });

  test("a Combination nobody measured has cursor zero", () => {
    expect(cursorFor(index, "crispasr", "tiny", "hu_hu", FINGERPRINT)).toBe(0);
  });

  test("the pre-d8b91ee runs contribute no LibriSpeech cursor at all", () => {
    // The known trap. Those runs scored LibriSpeech in filesystem-traversal order, so their
    // `utteranceCount` maps to no offset in the seeded list and the migration writes no
    // range. Reading the count as a depth would claim 47 seeded clips were measured that
    // never were - the cursor must stay at 0 and let them be re-measured.
    expect(
      cursorFor(
        index,
        "whisper-cli",
        "large-v3-q5_0",
        "test-clean",
        seededClean,
      ),
    ).toBe(0);
    expect(
      cursorFor(index, "whisper-cli", "tiny", "test-clean", seededClean),
    ).toBe(0);
    expect(
      index.byCombination["whisper-cli"]?.["tiny"]?.["test-clean"],
    ).toBeUndefined();
    // The FLEURS side of the very same runs backfills normally.
    expect(
      cursorFor(index, "whisper-cli", "large-v3-q5_0", "hu_hu", FINGERPRINT),
    ).toBe(47);
  });

  test("a range that contradicts its own utteranceCount is reported", () => {
    const broken = foldRecordedRanges(
      recordedRangesFromRun("2026-01-01_00-00-00_broken", {
        fleurs: {
          hu_hu: {
            crispasr: {
              tiny: leaf(200, {
                startIndex: 0,
                endIndex: 50,
                manifestFingerprint: FINGERPRINT,
              }),
            },
          },
        },
      }),
    );
    expect(broken.inconsistencies).toHaveLength(1);
    expect(broken.inconsistencies[0]).toContain("utteranceCount is 200");
  });

  test("a sentinel leaf advances nothing", () => {
    // A model that was not on disk records a zero-width range: real provenance, no clips.
    const sentinel = foldRecordedRanges(
      recordedRangesFromRun("2026-01-01_00-00-00_sentinel", {
        fleurs: {
          hu_hu: {
            crispasr: {
              tiny: leaf(0, {
                startIndex: 200,
                endIndex: 200,
                manifestFingerprint: FINGERPRINT,
              }),
            },
          },
        },
      }),
    );
    expect(cursorFor(sentinel, "crispasr", "tiny", "hu_hu", FINGERPRINT)).toBe(
      0,
    );
    expect(sentinel.fingerprints["hu_hu"][FINGERPRINT]).toEqual([
      "2026-01-01_00-00-00_sentinel",
    ]);
  });
});
