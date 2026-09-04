/**
 * What the measurement loop does per clip, and what it must never do twice.
 *
 * Two groups of tests here. The first is the one decision inside failure counting that is
 * worth pinning: which transcriptions a Benchmark Combination's `failures` count is taken
 * over. A failed utterance is scored as an empty hypothesis and so is invisible in every
 * other number the leaf publishes - it is inside `utteranceCount` and inside the WER
 * numerator, exactly like a real 100%-error utterance - so if the count is taken over the
 * wrong set, nothing downstream disagrees with it.
 *
 * The second is `measureClips`, which used to be "loop and I/O" and is now the seam three
 * acceptance gates land on: the adapter is invoked exactly once per selected clip on
 * distinct audio files, a resumed session replays its warmups and re-transcribes no
 * scored clip, and a Sample is recorded after every clip rather than every fiftieth. All
 * three were unobservable while the loop called `runTranscription` directly, which is why
 * the adapter is now a two-function seam (`AdapterSeam`) rather than an import.
 */

import { describe, expect, test } from "bun:test";
import {
  adapterFor,
  countFailedScoredSamples,
  countTranscriptionFailures,
  leafFromSamples,
  measureClips,
  unmeasuredLeaf,
  partialFromSamples,
  CODICTATE_TIMING_REGIME,
  UNMEASURED_RATE,
  type CompletedModelDatasetResult,
  type AdapterSeam,
  type UtteranceResult,
} from "./runner";
import type { SampleRange } from "./sample-cursor";
import type { ManifestEntry } from "../scripts/build-manifests";
import {
  buildRunPlan,
  pooledSpeed,
  uniqueInOrder,
  type RunPlan,
  type SampleMeasurementV2,
} from "../contract";
import type {
  TranscriptionRequest,
  TranscriptionResult,
} from "../../src/bun/utils/whisper/engines/transcription";

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
    clipId: "fleurs/da_dk/audio/test/1000000000000000001.wav",
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

  test("the v2 Sample adapter counts the same set", () => {
    // Same rule, other shape. The two spellings of the warmup flag (`warmup` here,
    // `isWarmup` on the contract type) are why there are two functions rather than one
    // structural parameter that would also accept an object with neither.
    expect(
      countFailedScoredSamples([
        sample("a.wav", { isWarmup: true, status: "failed" }),
        sample("b.wav", { status: "failed" }),
        sample("c.wav"),
      ]),
    ).toBe(1);
  });
});

describe("CompletedModelDatasetResult", () => {
  test("a clean run emits the count as zero rather than omitting it", () => {
    const clean: CompletedModelDatasetResult = leafFromSamples(
      [sample("a.wav"), sample("b.wav")],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );
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
      wordErrors: 128,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      failures: 0,
      speedV2: SPEED_V2,
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
      wordErrors: 128,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      sampleRange: RANGE,
      speedV2: SPEED_V2,
      totalAudioSec: 1_200,
      totalWallSec: 144,
    };
    expect(undisclosed.failures).toBeUndefined();
  });

  test("an emit path that forgets the pooled speed summary does not type-check", () => {
    // The summary is what `report.ts` and `charts.py` both read, so a leaf without one
    // sends each of them back to deriving its own RTF - which is the mean-of-means the
    // charts used to publish.
    // @ts-expect-error - `speedV2` is required on a completed leaf
    const unpoolable: CompletedModelDatasetResult = {
      wer: 0.0412,
      referenceWords: 3_100,
      wordErrors: 128,
      meanRTF: 0.12,
      peakRSS_MB: null,
      utteranceCount: 200,
      failures: 0,
      sampleRange: RANGE,
      totalAudioSec: 1_200,
      totalWallSec: 144,
    };
    expect(unpoolable.speedV2).toBeUndefined();
  });
});

// -- v2 fixtures --

const SPEED_V2 = {
  ...pooledSpeed([]),
  responseMs: 0,
  audioDurationSec: 0,
  inferenceRtf: null,
  inferenceMs: 0,
  inferenceAudioSec: 0,
  inferenceSampleCount: 0,
  inferenceSkippedCount: 0,
};

/** One v2 Sample of the clip `fleurs/da_dk/audio/test/<name>`. */
function sample(
  name: string,
  overrides: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  return {
    clipId: `fleurs/da_dk/audio/test/${name}`,
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

/** `count` FLEURS-shaped manifest entries, all distinct, in a stable order. */
function danishPool(count: number): ManifestEntry[] {
  return Array.from({ length: count }, (_, index) => {
    // Sentence ids repeat every three entries, exactly as the corpus does: three
    // speakers read each sentence. If identity came from here, this pool would hold
    // `count / 3` clips.
    const sentenceId = String(100 + Math.floor(index / 3));
    // Built by string concatenation, not arithmetic: the real FLEURS file names are
    // 20-digit values well past `Number.MAX_SAFE_INTEGER`, so `1e18 + index` collapses
    // every entry onto one name and the pool silently stops being distinct.
    const fileName = `1${String(index).padStart(18, "0")}.wav`;
    return {
      id: `da_dk_${sentenceId}`,
      clipId: `fleurs/da_dk/audio/test/${fileName}`,
      sentenceId,
      audioPath: `/corpus/fleurs/da_dk/audio/test/${fileName}`,
      transcript: `clip ${index} reference words here`,
      rawTranscript: `Clip ${index} reference words here.`,
      language: "da",
      audioDurationSec: 5,
    };
  });
}

function entriesByClipId(
  entries: readonly ManifestEntry[],
): Map<string, ManifestEntry> {
  return new Map(entries.map((entry) => [entry.clipId, entry]));
}

/**
 * A plan over the Danish pool: three reserved warmups, then the half-open consumable
 * range `[from, to)`.
 */
function planOver(
  entries: readonly ManifestEntry[],
  from: number,
  to: number,
): RunPlan {
  const clipIds = entries.map((entry) => entry.clipId);
  return buildRunPlan({
    runId: `2026-09-04_08-17-28_da-${from}-${to}`,
    datasetId: "fleurs/da_dk",
    harness: "codictate",
    model: "large-v3-turbo-q5_0",
    consumableClipIds: clipIds.slice(3),
    warmupClipIds: clipIds.slice(0, 3),
    fromIndex: from,
    toIndex: to,
    createdAt: "2026-09-04T08:17:20.000Z",
  });
}

/** An adapter that records every invocation and transcribes perfectly. */
function countingAdapter(
  transcribe: (request: TranscriptionRequest) => TranscriptionResult = (
    request,
  ) => ({
    status: "ok",
    rawTranscript: `clip reference words here (${request.audioPath})`,
  }),
): AdapterSeam & { audioPaths: string[] } {
  const audioPaths: string[] = [];
  return {
    audioPaths,
    prepare: (entry) =>
      ({
        engineId: "whisper_cpp",
        speechModelId: "large-v3-turbo-q5_0",
        audioPath: entry.audioPath,
        modelPath: "/weights/large-v3-turbo-q5_0.bin",
        languageCode: entry.language,
        translateToEnglish: false,
        crispasrBackend: null,
      }) as TranscriptionRequest,
    invoke: async (request) => {
      audioPaths.push(request.audioPath);
      return transcribe(request);
    },
  };
}

describe("measureClips: a 400-clip range over the 930-clip Danish pool", () => {
  test("selects 400 distinct clips and invokes the adapter exactly 400 times", async () => {
    // Acceptance gate 1, the runner half. The contract can prove the *plan* names 400
    // distinct clipIds; only the loop can prove the adapter was asked 400 times, once
    // each. Both halves are needed: a plan of 400 distinct clips run by a loop that
    // re-prepends three warmups to every slice, or retries a failure, or resumes from an
    // offset into the wrong array, invokes the adapter a different number of times and
    // still writes a leaf claiming 400.
    const pool = danishPool(933);
    const plan = planOver(pool, 0, 400);
    const adapter = countingAdapter();

    const outcome = await measureClips({
      plan,
      entriesByClipId: entriesByClipId(pool),
      adapter,
    });

    expect(plan.orderedClipIds.length).toBe(400);
    expect(uniqueInOrder(plan.orderedClipIds).length).toBe(400);

    const scored = outcome.samples.filter((s) => !s.isWarmup);
    expect(scored.length).toBe(400);
    expect(uniqueInOrder(scored.map((s) => s.clipId)).length).toBe(400);

    // 400 scored plus the three replayed warmups, and not one more.
    expect(adapter.audioPaths.length).toBe(403);
    expect(uniqueInOrder(adapter.audioPaths).length).toBe(403);
    expect(outcome.adapterInvocations).toBe(403);
    expect(outcome.skippedScoredClips).toBe(0);
  });

  test("the 930-clip pool would have been 310 clips under sentence-id identity", () => {
    // The scale of defect 7, stated as arithmetic. The synthetic pool repeats its
    // sentence id every three entries just as the corpus does, so keying identity on
    // `id` would have collapsed a 400-clip selection to a third of itself.
    const pool = danishPool(930);
    expect(uniqueInOrder(pool.map((entry) => entry.clipId)).length).toBe(930);
    expect(uniqueInOrder(pool.map((entry) => entry.id)).length).toBe(310);
  });

  test("every Sample carries the direct-adapter timing regime", async () => {
    // Without it the Sample is treated as speed-incompatible and silently dropped from
    // every pooled speed figure - so this is the assertion that keeps Codictate's numbers
    // in the published comparison at all.
    const pool = danishPool(10);
    const outcome = await measureClips({
      plan: planOver(pool, 0, 5),
      entriesByClipId: entriesByClipId(pool),
      adapter: countingAdapter(),
    });

    for (const measured of outcome.samples) {
      expect(measured.overhead?.timingRegime).toBe("direct-adapter");
      expect(measured.overhead?.inferenceMs).toBeNull();
    }
  });

  test("nothing but the adapter call sits inside the timing window", async () => {
    // The clock is injected and ticks once per call, so `responseMs` is exactly the
    // number of clock reads that happened between the two ends of the window. Two reads
    // per clip means the window opened, the adapter was called, and the window closed -
    // no manifest read, no WAV read, no logging in between.
    const pool = danishPool(6);
    let tick = 0;
    const outcome = await measureClips({
      plan: planOver(pool, 0, 3),
      entriesByClipId: entriesByClipId(pool),
      adapter: countingAdapter(),
      now: () => ++tick,
    });

    for (const measured of outcome.samples) {
      expect(measured.responseMs).toBe(1);
    }
    // Six clips (three warmups, three scored), two reads each.
    expect(tick).toBe(12);
  });

  test("a plan naming a clip the manifest does not carry is refused", async () => {
    const pool = danishPool(10);
    await expect(
      measureClips({
        plan: planOver(pool, 0, 5),
        entriesByClipId: entriesByClipId(pool.slice(0, 4)),
        adapter: countingAdapter(),
      }),
    ).rejects.toThrow(/built from different lists/);
  });
});

describe("measureClips: resume", () => {
  test("warmups replay and no completed scored clip is re-transcribed", async () => {
    // Acceptance gate 4. The two halves pull in opposite directions and both are
    // required: completed-clip filtering that treated warmups as scored would stop them
    // replaying, and a resume that replayed scored clips would double-count them.
    const pool = danishPool(103);
    const plan = planOver(pool, 0, 100);

    const first = countingAdapter();
    let interrupted: readonly SampleMeasurementV2[] = [];
    try {
      await measureClips({
        plan,
        entriesByClipId: entriesByClipId(pool),
        adapter: first,
        // Stop the session after 40 scored clips, the way a kill does.
        onScoredClip: (samples) => {
          interrupted = samples.map((s) => ({ ...s }));
          if (samples.filter((s) => !s.isWarmup).length >= 40) {
            throw new StopSession();
          }
        },
      });
    } catch (error) {
      if (!(error instanceof StopSession)) throw error;
    }

    expect(interrupted.filter((s) => !s.isWarmup).length).toBe(40);

    const second = countingAdapter();
    const resumed = await measureClips({
      plan,
      entriesByClipId: entriesByClipId(pool),
      adapter: second,
      recordedSamples: interrupted,
    });

    // Three warmups replayed - a resumed process is a fresh cold process - and exactly
    // the 60 clips that were never measured.
    expect(second.audioPaths.length).toBe(63);
    expect(resumed.skippedScoredClips).toBe(40);

    const scored = resumed.samples.filter((s) => !s.isWarmup);
    expect(scored.length).toBe(100);
    expect(uniqueInOrder(scored.map((s) => s.clipId)).length).toBe(100);
    // Zero repeats: the second session's audio paths and the first 40 clips are disjoint.
    const firstFortyPaths = new Set(first.audioPaths.slice(3));
    for (const path of second.audioPaths.slice(3)) {
      expect(firstFortyPaths.has(path)).toBe(false);
    }
  });

  test("a recorded failure is a measurement and is not replayed", async () => {
    // Settled in the contract: re-running a recorded `failed` clip would either
    // double-count it or overwrite a real observation with a luckier one. Re-measuring on
    // purpose is a new run with an explicit start index, never a resume.
    const pool = danishPool(6);
    const plan = planOver(pool, 0, 3);
    const recorded = [
      sample(basename(plan.orderedClipIds[0]), {
        status: "failed",
        responseMs: null,
      }),
    ];

    const adapter = countingAdapter();
    const resumed = await measureClips({
      plan,
      entriesByClipId: entriesByClipId(pool),
      adapter,
      recordedSamples: recorded,
    });

    // Three warmups plus the two clips that were never attempted.
    expect(adapter.audioPaths.length).toBe(5);
    expect(resumed.skippedScoredClips).toBe(1);
    expect(
      resumed.samples.filter((s) => !s.isWarmup && s.status === "failed")
        .length,
    ).toBe(1);
  });

  test("a Sample is recorded after every scored clip, not every fiftieth", async () => {
    // Defect 11. The checkpoint used to be written on `(i + 1) % 50 === 0`, so a run
    // killed at clip 149 resumed from clip 100 and re-transcribed 49 clips it had already
    // paid for - and, worse, the checkpoint on disk claimed a depth the record could not
    // back up.
    const pool = danishPool(63);
    const plan = planOver(pool, 0, 60);
    const depths: number[] = [];

    await measureClips({
      plan,
      entriesByClipId: entriesByClipId(pool),
      adapter: countingAdapter(),
      onScoredClip: (samples) =>
        depths.push(samples.filter((s) => !s.isWarmup).length),
    });

    expect(depths.length).toBe(60);
    expect(depths).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  test("a crash after clip N loses nothing and the resume repeats zero clips", async () => {
    // The whole point of per-clip checkpointing, asserted at every possible crash point
    // rather than at one: whatever clip the process died on, the resume re-transcribes
    // none of the clips already recorded and finishes the plan exactly once.
    const pool = danishPool(23);
    const plan = planOver(pool, 0, 20);

    for (const crashAfter of [1, 7, 19, 20]) {
      let checkpoint: readonly SampleMeasurementV2[] = [];
      const first = countingAdapter();
      await measureClips({
        plan,
        entriesByClipId: entriesByClipId(pool),
        adapter: first,
        onScoredClip: (samples) => {
          checkpoint = samples.map((s) => ({ ...s }));
          if (samples.filter((s) => !s.isWarmup).length >= crashAfter) {
            throw new StopSession();
          }
        },
      }).catch((error) => {
        if (!(error instanceof StopSession)) throw error;
      });

      expect(checkpoint.filter((s) => !s.isWarmup).length).toBe(crashAfter);

      const second = countingAdapter();
      const resumed = await measureClips({
        plan,
        entriesByClipId: entriesByClipId(pool),
        adapter: second,
        recordedSamples: checkpoint,
      });

      const scored = resumed.samples.filter((s) => !s.isWarmup);
      expect(scored.length).toBe(20);
      expect(uniqueInOrder(scored.map((s) => s.clipId)).length).toBe(20);
      // Warmups aside, the resume transcribed exactly the clips that were missing.
      expect(second.audioPaths.length - 3).toBe(20 - crashAfter);
    }
  });
});

describe("leafFromSamples", () => {
  test("the leaf's WER is pooled errors over pooled references", async () => {
    const leaf = leafFromSamples(
      [
        sample("a.wav", { wordErrors: 1, referenceWords: 100 }),
        sample("b.wav", { wordErrors: 9, referenceWords: 10 }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    // 10 errors over 110 words. A mean of the two per-clip rates would be 45.5%, which is
    // the accuracy of no sample anybody measured.
    expect(leaf.wordErrors).toBe(10);
    expect(leaf.referenceWords).toBe(110);
    expect(leaf.wer).toBeCloseTo(10 / 110, 12);
  });

  test("a failure is counted and priced at nothing in the v2 ratio", () => {
    const leaf = leafFromSamples(
      [
        sample("a.wav", {
          responseMs: 2_000,
          audioDurationSec: 4,
          overhead: {
            timingRegime: CODICTATE_TIMING_REGIME,
            wallClockMs: 2_000,
          },
        }),
        sample("b.wav", {
          status: "failed",
          responseMs: null,
          audioDurationSec: 30,
          overhead: {
            timingRegime: CODICTATE_TIMING_REGIME,
            wallClockMs: 1_000,
          },
        }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    expect(leaf.failures).toBe(1);
    expect(leaf.speedV2.attemptedCount).toBe(2);
    expect(leaf.speedV2.respondedCount).toBe(1);
    // The failed clip's 30 seconds of audio are out of the **v2** denominator. Keeping
    // them in would make a Combination that refused its longest clip look four times
    // faster than one that answered it.
    expect(leaf.speedV2.audioDurationSec).toBe(4);
    expect(leaf.speedV2.responseMs).toBe(2_000);
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(500);
    expect(leaf.speedV2.wallRtf).toBe(0.5);
    // The v1 sums keep the v1 definition: all scored Samples, unfiltered. 3 s of adapter
    // wall clock over 34 s of audio. Archived leaves carry them under this definition and
    // can never be re-measured, so redefining them in place would make eight archived
    // Benchmark Runs incomparable to every new one.
    expect(leaf.totalAudioSec).toBe(34);
    expect(leaf.totalWallSec).toBeCloseTo(3, 12);
    expect(leaf.meanRTF).toBeCloseTo(3 / 34, 12);
  });

  test("warmups are in no numerator and no denominator", () => {
    const leaf = leafFromSamples(
      [
        sample("w.wav", { isWarmup: true, wordErrors: 50, referenceWords: 50 }),
        sample("a.wav", { wordErrors: 1, referenceWords: 10 }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    expect(leaf.utteranceCount).toBe(1);
    expect(leaf.referenceWords).toBe(10);
    expect(leaf.wer).toBeCloseTo(0.1, 12);
  });

  test("a Sample with no timing regime is counted and scored, and priced nowhere", () => {
    // The provenance boundary, from this side. Every Sample this harness writes carries
    // `timingRegime: "direct-adapter"`, so this case only arises for a record written
    // before the mandate - and the point of the test is that such a Sample still counts
    // as attempted, still counts as responded, and still contributes its words to the
    // pooled WER. Only the speed ratio drops it.
    const leaf = leafFromSamples(
      [
        sample("a.wav", { responseMs: 1_000, audioDurationSec: 5 }),
        sample("b.wav", {
          responseMs: 100,
          audioDurationSec: 5,
          overhead: undefined,
        }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    expect(leaf.speedV2.attemptedCount).toBe(2);
    expect(leaf.speedV2.respondedCount).toBe(2);
    expect(leaf.speedV2.speedExcludedCount).toBe(1);
    // 1000 ms over 5 s, not 1100 over 10. The unfiltered value would be 110.
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(200);
    expect(leaf.speedV2.audioDurationSec).toBe(5);
    // The legacy sums keep both clips, because that is what the v1 definition says.
    expect(leaf.totalAudioSec).toBe(10);
    // Accuracy is over the unfiltered scored set: an incompatible timing provenance says
    // nothing about whether the transcript was right.
    expect(leaf.referenceWords).toBe(20);
    expect(leaf.wordErrors).toBe(2);
  });

  test("meanRTF and wallRtf are two definitions and both stay on the leaf", () => {
    // Not the same number, and not allowed to be forced into one. `meanRTF` is the v1
    // quotient over all scored Samples; `speedV2.wallRtf` is the v2 quotient over the
    // successful, speed-compatible ones. Only the second may be published, and the first
    // has to keep its archived meaning.
    const leaf = leafFromSamples(
      [
        sample("a.wav", {
          responseMs: 2_500,
          audioDurationSec: 5,
          overhead: {
            timingRegime: CODICTATE_TIMING_REGIME,
            wallClockMs: 2_500,
          },
        }),
        // No timing provenance: in the legacy sums, out of the v2 ratio.
        sample("b.wav", {
          responseMs: 100,
          audioDurationSec: 5,
          overhead: { wallClockMs: 100 },
        }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    expect(leaf.speedV2.wallRtf).toBe(0.5);
    expect(leaf.meanRTF).toBeCloseTo(2.6 / 10, 12);
    expect(leaf.speedV2.wallRtf).not.toBe(leaf.meanRTF);
    // And the v2 ratio is poolable across leaves, because its two sums travel with it.
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(
      leaf.speedV2.responseMs / leaf.speedV2.audioDurationSec,
    );
  });

  test("a Combination where every clip failed publishes no v2 speed at all", () => {
    // A failed clip carries `overhead.wallClockMs` and `responseMs: null`: the adapter
    // took time and returned nothing to time. That is what keeps the legacy sums whole
    // while the v2 ratio stays empty.
    const failed = (name: string) =>
      sample(name, {
        status: "failed",
        responseMs: null,
        overhead: {
          timingRegime: CODICTATE_TIMING_REGIME,
          wallClockMs: 900,
        },
      });
    const leaf = leafFromSamples(
      [failed("a.wav"), failed("b.wav"), failed("c.wav")],
      {
        range: RANGE,
        peakRSS_MB: null,
        computeCer: false,
      },
    );

    expect(leaf.failures).toBe(3);
    expect(leaf.speedV2.respondedCount).toBe(0);
    // `null`, not zero: nothing responded, so there is no publishable speed. Zero is the
    // fastest possible answer and would price three failures as three instant
    // transcriptions.
    expect(leaf.speedV2.responseMsPerAudioSec).toBeNull();
    expect(leaf.speedV2.wallRtf).toBeNull();
    expect(leaf.speedV2.audioDurationSec).toBe(0);
    // The legacy quotient still exists and still means what it always meant: the wall
    // clock this Combination spent, over the audio it was given. Unfiltered.
    expect(leaf.totalAudioSec).toBe(15);
    expect(leaf.totalWallSec).toBeCloseTo(2.7, 12);
    expect(leaf.meanRTF).toBeCloseTo(2.7 / 15, 12);
    // The WER numerator survives too - the words were scored against an empty hypothesis.
    expect(leaf.referenceWords).toBe(30);
  });

  test("a leaf with nothing measurable writes a sentinel, not a zero", () => {
    // The `?? 0` this replaces. A zero WER is a perfect transcription and a zero RTF is
    // an instant one, so a fresh metric must not spell "unmeasured" that way. `-1` is not
    // a new convention: it is what the archive's absent-Speech-Model leaves carry, and
    // what `fmtAccuracy`, `fmtSpeed` and `charts.py` already read as N/A - so the website
    // reader, a separate repository, needs no private knowledge that 0 meant N/A.
    const nothingScorable = leafFromSamples(
      [sample("a.wav", { referenceWords: 0, wordErrors: 0 })],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );
    expect(nothingScorable.wer).toBe(UNMEASURED_RATE);
    expect(nothingScorable.wer).toBeLessThan(0);

    const noAudio = leafFromSamples(
      [sample("a.wav", { audioDurationSec: 0 })],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );
    expect(noAudio.meanRTF).toBe(UNMEASURED_RATE);

    expect(unmeasuredLeaf(RANGE).wer).toBe(UNMEASURED_RATE);
    expect(unmeasuredLeaf(RANGE).meanRTF).toBe(UNMEASURED_RATE);
  });

  test("a clip with no denominator is skipped, not counted as scored", () => {
    // `skippedCount` is the honesty counter: a pooled rate over half the clips is a
    // different claim from one over all of them. A Sample cannot say "not scored" on disk
    // - the contract's guard requires `charErrors` and `referenceChars` to be numbers -
    // so an unscored clip carries a zero denominator and has to be translated back to an
    // absent leaf at the pooling boundary. Passing `0 / 0` straight through counted it as
    // a clip that was scored.
    const leaf = leafFromSamples(
      [
        sample("a.wav", { charErrors: 2, referenceChars: 50 }),
        // A FLEURS row with an empty `raw_transcription`, or any LibriSpeech clip.
        sample("b.wav", { charErrors: 0, referenceChars: 0 }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: true },
    );

    // The rate is unaffected either way - that is what made this invisible.
    expect(leaf.cer).toBeCloseTo(2 / 50, 12);
    expect(leaf.referenceChars).toBe(50);
    expect(leaf.charErrors).toBe(2);
  });

  test("the inference diagnostic carries its own numerator and denominator", () => {
    // Without both, a consumer pooling several leaves has to multiply `inferenceRtf` by
    // some duration, and the only one on the leaf is `totalAudioSec` - the
    // speed-compatible audio, which is a different set of clips whenever any Sample has a
    // `responseMs` and no `inferenceMs`. Multiplying by the wrong denominator produces a
    // number nothing downstream disagrees with.
    const leaf = leafFromSamples(
      [
        sample("a.wav", {
          audioDurationSec: 10,
          overhead: {
            timingRegime: CODICTATE_TIMING_REGIME,
            inferenceMs: 2_000,
          },
        }),
        // Speed-compatible, so its 40 s are in `totalAudioSec` - and it reports no
        // inference, so its 40 s are *not* in `inferenceAudioSec`.
        sample("b.wav", { audioDurationSec: 40 }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    expect(leaf.speedV2.inferenceMs).toBe(2_000);
    expect(leaf.speedV2.inferenceAudioSec).toBe(10);
    expect(leaf.totalAudioSec).toBe(50);
    // 2 s over 10 s of inference audio, not over the 50 s of speed audio.
    expect(leaf.speedV2.inferenceRtf).toBeCloseTo(0.2, 12);
    expect(leaf.speedV2.inferenceMs / 1000 / leaf.totalAudioSec).toBeCloseTo(
      0.04,
      12,
    );
  });

  test("the inference diagnostic skips the Samples that lack it", () => {
    const leaf = leafFromSamples(
      [
        sample("a.wav"),
        sample("b.wav", {
          overhead: {
            timingRegime: CODICTATE_TIMING_REGIME,
            inferenceMs: 900,
          },
        }),
      ],
      { range: RANGE, peakRSS_MB: null, computeCer: false },
    );

    // Skipped, not zero. One Sample reported 900 ms of inference over 5 s of audio.
    expect(leaf.speedV2.inferenceSampleCount).toBe(1);
    expect(leaf.speedV2.inferenceSkippedCount).toBe(1);
    expect(leaf.speedV2.inferenceRtf).toBeCloseTo(0.18, 12);
  });

  test("CER is emitted only where a Sample had a raw transcript to score against", () => {
    const withoutCer = leafFromSamples(
      [sample("a.wav", { charErrors: 0, referenceChars: 0 })],
      { range: RANGE, peakRSS_MB: null, computeCer: true },
    );
    expect(withoutCer.cer).toBeUndefined();
    expect(withoutCer.referenceChars).toBeUndefined();

    const withCer = leafFromSamples([sample("a.wav")], {
      range: RANGE,
      peakRSS_MB: null,
      computeCer: true,
    });
    expect(withCer.cer).toBeCloseTo(2 / 50, 12);
    expect(withCer.charErrors).toBe(2);
  });
});

describe("unmeasuredLeaf", () => {
  test("a Speech Model that was not on disk records a negative sentinel", () => {
    // Not the zero a fold over no Samples produces. `fmtAccuracy` in report.ts and
    // `extract_data` in charts.py both read a negative rate as "N/A", so a zero here
    // would render as 100% accuracy for the one Combination that measured nothing.
    const leaf = unmeasuredLeaf({
      startIndex: 400,
      endIndex: 800,
      manifestFingerprint: "930:abc0123456789def",
    });

    expect(leaf.wer).toBe(-1);
    expect(leaf.meanRTF).toBe(-1);
    expect(leaf.utteranceCount).toBe(0);
    // Zero-width at the index it was planned from: nothing was measured, so nothing was
    // consumed and the cursor must not move. Claiming the planned width would burn 400
    // clips this never transcribed.
    expect(leaf.sampleRange).toEqual({
      startIndex: 400,
      endIndex: 400,
      manifestFingerprint: "930:abc0123456789def",
    });
  });
});

describe("partialFromSamples", () => {
  test("the v1 progress view is a fold over the record, not a second accumulator", () => {
    const partial = partialFromSamples([
      sample("w.wav", { isWarmup: true }),
      sample("a.wav", { wordErrors: 2, referenceWords: 20, responseMs: 1_500 }),
      sample("b.wav", { status: "failed", responseMs: null }),
    ]);

    expect(partial.utterancesDone).toBe(2);
    expect(partial.totalWer).toBe(3);
    expect(partial.totalRefWords).toBe(30);
    expect(partial.failures).toBe(1);
    // Only the successful clip's wall time and audio, matching the pooled ratio.
    expect(partial.totalWallSec).toBeCloseTo(1.5, 12);
    expect(partial.totalAudioSec).toBe(5);
  });
});

describe("adapterFor", () => {
  test("the Request is built from the clip, outside the timing window", () => {
    const [entry] = danishPool(1);
    const request = adapterFor(
      "large-v3-turbo-q5_0",
      "/weights/turbo.bin",
      "crispasr",
    ).prepare(entry);

    expect(request.audioPath).toBe(entry.audioPath);
    expect(request.speechModelId).toBe("large-v3-turbo-q5_0");
    // No Benchmark Combination translates: WER is scored against a reference transcript
    // in the Sample's own language.
    expect("translateToEnglish" in request && request.translateToEnglish).toBe(
      false,
    );
  });
});

/** A kill, as an exception, thrown from the per-clip checkpoint hook. */
class StopSession extends Error {
  constructor() {
    super("simulated crash");
  }
}

function basename(clipId: string): string {
  return clipId.slice(clipId.lastIndexOf("/") + 1);
}
