/**
 * The one decision inside failure counting that is worth pinning: which transcriptions a
 * Benchmark Combination's `failures` count is taken over.
 *
 * The rest of `benchmarkModel` is loop and I/O - spawn an engine, accumulate two ratios,
 * write a checkpoint - and a test over that only restates it. This function is the seam,
 * because a failed utterance is scored as an empty hypothesis and so is invisible in
 * every other number the leaf publishes: it is inside `utteranceCount` and inside the WER
 * numerator, exactly like a real 100%-error utterance. If the count is taken over the
 * wrong set, nothing downstream disagrees with it.
 */

import { describe, expect, test } from "bun:test";
import {
  countTranscriptionFailures,
  type CompletedModelDatasetResult,
  type UtteranceResult,
} from "./runner";
import type { SampleRange } from "./sample-cursor";

/** The range a leaf in these fixtures claims to have measured. */
const RANGE: SampleRange = {
  startIndex: 0,
  endIndex: 200,
  manifestFingerprint: "203:0123456789abcdef",
};

/** A scored utterance the engine transcribed. Overrides make it a warmup or a failure. */
function utterance(overrides: Partial<UtteranceResult> = {}): UtteranceResult {
  return {
    id: "sample-1",
    warmup: false,
    status: "ok",
    wallClockMs: 250,
    wer: { wer: 0, substitutions: 0, insertions: 0, deletions: 0, refWords: 7 },
    hypothesis: "the engine said something",
    ...overrides,
  };
}

describe("countTranscriptionFailures", () => {
  test("a scored utterance whose transcription failed is counted", () => {
    expect(
      countTranscriptionFailures([
        utterance(),
        utterance({ id: "sample-2", status: "failed", hypothesis: "" }),
        utterance({ id: "sample-3" }),
      ]),
    ).toBe(1);
  });

  test("a failed warmup is not counted", () => {
    // Warmups are excluded from WER for the same reason, so a warmup that fails must not
    // appear in a count published beside it. Otherwise a leaf reports more failures than
    // it has scored utterances that failed.
    expect(
      countTranscriptionFailures([
        utterance({ id: "warmup-1", warmup: true, status: "failed" }),
        utterance({ id: "warmup-2", warmup: true, status: "failed" }),
        utterance(),
      ]),
    ).toBe(0);
  });

  test("failed warmups and failed scored utterances are told apart", () => {
    expect(
      countTranscriptionFailures([
        utterance({ id: "warmup-1", warmup: true, status: "failed" }),
        utterance({ id: "sample-1", status: "failed" }),
        utterance({ id: "sample-2", status: "failed" }),
        utterance({ id: "sample-3" }),
      ]),
    ).toBe(2);
  });

  test("a run where nothing failed counts zero", () => {
    const failures = countTranscriptionFailures([
      utterance({ id: "warmup-1", warmup: true }),
      utterance({ id: "sample-1" }),
      utterance({ id: "sample-2" }),
    ]);
    expect(failures).toBe(0);
    // Zero, not absent: a leaf that omits the field says nobody counted, which is what
    // every archived run says and is a different claim from "nothing failed".
    expect(failures).toBeTypeOf("number");
  });

  test("a Combination that transcribed nothing counts zero", () => {
    expect(countTranscriptionFailures([])).toBe(0);
  });
});

describe("CompletedModelDatasetResult", () => {
  test("a clean run emits the count as zero rather than omitting it", () => {
    const clean: CompletedModelDatasetResult = {
      wer: 0.0412,
      referenceWords: 3_100,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      failures: countTranscriptionFailures([utterance(), utterance()]),
      sampleRange: RANGE,
      totalAudioSec: 1_200,
      totalWallSec: 144,
    };
    expect(clean.failures).toBe(0);
    expect(Object.keys(clean)).toContain("failures");
  });

  test("an emit path that forgets the sample range does not type-check", () => {
    // Without the range the leaf is invisible to the cursor: a Combination that just
    // measured 200 clips would read as one nobody has ever run, and the next session would
    // measure the same 200 again.
    // @ts-expect-error - `sampleRange` is required on a completed leaf
    const unlocatable: CompletedModelDatasetResult = {
      wer: 0.0412,
      referenceWords: 3_100,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      failures: 0,
      totalAudioSec: 1_200,
      totalWallSec: 144,
    };
    expect(unlocatable.sampleRange).toBeUndefined();
  });

  test("an emit path that forgets the count does not type-check", () => {
    // The read type keeps `failures` optional so the archive still loads. This is the
    // guard that stops a new write path from quietly inheriting that permission and
    // publishing another leaf nobody can read a failure count out of.
    // @ts-expect-error - `failures` is required on a completed leaf
    const undisclosed: CompletedModelDatasetResult = {
      wer: 0.0412,
      referenceWords: 3_100,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      sampleRange: RANGE,
      totalAudioSec: 1_200,
      totalWallSec: 144,
    };
    expect(undisclosed.failures).toBeUndefined();
  });
});
