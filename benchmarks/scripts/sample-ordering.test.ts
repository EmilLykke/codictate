/**
 * The archive-migration recount, and the one thing it must never do: de-duplicate.
 *
 * `denominatorsForEntries` decides whether an archived leaf's recorded `wer` reconciles
 * into a whole number of errors, which is what lets a migration write a denominator onto
 * a run nobody can re-measure. It slices a manifest **positionally**, and two recordings
 * of one FLEURS sentence are two clips with two transcripts. Collapsing them by sentence
 * id - the mistake `ManifestEntry.id` invites - would shorten the denominator, and a
 * shortened denominator still divides some rate into something near a whole number, so
 * the migration would write a plausible wrong count and nothing would disagree with it.
 *
 * Tested through the pure seam because `benchmarks/datasets/` is git-ignored: the real
 * corpora cannot be in CI, and `manifestFor` reads them.
 */

import { describe, expect, test } from "bun:test";
import {
  denominatorsForEntries,
  deviation,
  isLibriSpeechDatasetKey,
  locateLeaves,
  EXACT_EPSILON,
} from "./sample-ordering";
import type { ManifestEntry } from "./build-manifests";

/** One FLEURS-shaped entry. `sentenceId` repeats across entries on purpose. */
function entry(
  clipFile: string,
  sentenceId: string,
  transcript: string,
  rawTranscript?: string,
): ManifestEntry {
  return {
    id: `da_dk_${sentenceId}`,
    clipId: `fleurs/da_dk/audio/test/${clipFile}`,
    sentenceId,
    audioPath: `/corpus/fleurs/da_dk/audio/test/${clipFile}`,
    transcript,
    ...(rawTranscript === undefined ? {} : { rawTranscript }),
    language: "da",
    audioDurationSec: 0,
  };
}

describe("denominatorsForEntries", () => {
  test("three readings of one sentence count three times", () => {
    const counts = denominatorsForEntries([
      entry("a.wav", "101", "han sagde det"),
      entry("b.wav", "101", "han sagde det"),
      entry("c.wav", "101", "han sagde det"),
    ]);

    // Nine words, not three. Every reading is a clip the model was scored on, so every
    // reading is in the denominator - a per-sentence count would be a third of the truth
    // and would still look like a plausible number of words.
    expect(counts.referenceWords).toBe(9);
  });

  test("CER counts only the entries carrying a raw transcript", () => {
    const counts = denominatorsForEntries([
      entry("a.wav", "101", "han sagde det", "Han sagde det."),
      entry("b.wav", "102", "hun kom hjem"),
    ]);

    expect(counts.referenceWords).toBe(6);
    // The same condition `runner.ts` applies when it accumulates `totalRefChars`: CER is
    // scored against the raw transcript, so an entry without one contributes nothing.
    expect(counts.referenceChars).toBe("Han sagde det.".length);
  });

  test("a slice with no raw transcript reports null rather than zero", () => {
    const counts = denominatorsForEntries([
      entry("a.wav", "101", "han sagde det"),
    ]);

    // Null, because a zero denominator would divide a recorded CER into zero errors and
    // reconcile perfectly against a slice nobody could score.
    expect(counts.referenceChars).toBeNull();
  });

  test("an empty slice counts nothing", () => {
    expect(denominatorsForEntries([])).toEqual({
      referenceWords: 0,
      referenceChars: null,
    });
  });
});

describe("deviation", () => {
  test("a rate that divides into whole errors reconciles exactly", () => {
    // 12 errors over 100 words. The property no wrong denominator has to a part in 1e-6.
    expect(deviation(0.12, 100)).toBeLessThanOrEqual(EXACT_EPSILON);
  });

  test("a rate against the wrong denominator does not", () => {
    expect(deviation(0.12, 33)).toBeGreaterThan(EXACT_EPSILON);
  });
});

describe("locateLeaves", () => {
  test("both on-disk shapes are walked, and the harness is named in the label", () => {
    const leaves = locateLeaves({
      hu_hu: {
        crispasr: { tiny: { wer: 0.2, utteranceCount: 10 } },
      },
      da_dk: { tiny: { wer: 0.3, utteranceCount: 20 } },
    });

    expect(
      leaves.map((leaf) => `${leaf.datasetKey}/${leaf.modelLabel}`),
    ).toEqual(["hu_hu/tiny@crispasr", "da_dk/tiny"]);
  });
});

describe("isLibriSpeechDatasetKey", () => {
  test("the split prefix is what tells the two corpora apart", () => {
    expect(isLibriSpeechDatasetKey("test-clean")).toBe(true);
    expect(isLibriSpeechDatasetKey("da_dk")).toBe(false);
  });
});
