/**
 * Clip identity: the derivation, and the one column it must never come from.
 *
 * The FLEURS column-0 mistake is the reason this file exists. Column 0 is a sentence
 * id and repeats - 930 Danish clips share 350 of them - so identity taken from it
 * collapses two thirds of a Danish run into apparent duplicates. Nothing about that
 * failure is visible in a published number: the run finishes, the WER looks plausible,
 * and 580 clips were silently skipped as "already measured".
 *
 * The counts themselves are pinned against the real TSVs in
 * `benchmarks/contract/fleurs-identity.manual.ts`, which is opt-in because
 * `benchmarks/datasets/` is git-ignored and absent in CI. This file pins the rule on a
 * synthetic mirror of the same shape, so the rule is covered on every machine.
 */

import { describe, expect, test } from "bun:test";
import {
  assertUniqueClipIds,
  clipIdFromAbsoluteAudioPath,
  clipIdFromRelativeAudioPath,
  fleursClipId,
  librispeechClipId,
  uniqueInOrder,
} from "./clip-identity";

/**
 * What was measured in the three real `test.tsv` files on 2026-09-04, kept here as the
 * documented expectation the manual suite asserts against.
 *
 * `wavs` is the row count of the TSV, every row of which has a matching file on disk.
 */
export const FLEURS_IDENTITY_WITNESS = {
  da_dk: { wavs: 930, distinctColumn0: 350 },
  es_419: { wavs: 908, distinctColumn0: 348 },
  hu_hu: { wavs: 905, distinctColumn0: 348 },
} as const;

/**
 * Six rows with the shape every FLEURS locale has: several recordings of one sentence,
 * so column 0 repeats and column 1 does not.
 */
const TSV_ROWS: readonly { column0: string; column1: string }[] = [
  { column0: "1676", column1: "12149430079508542992.wav" },
  { column0: "1676", column1: "1892314626509120692.wav" },
  { column0: "1908", column1: "11657230937236500261.wav" },
  { column0: "1908", column1: "10016401698104160032.wav" },
  { column0: "1908", column1: "15945042231538223000.wav" },
  { column0: "2011", column1: "7285658688146080595.wav" },
];

describe("FLEURS identity comes from TSV column 1", () => {
  test("column 1 gives one clipId per recording", () => {
    const clipIds = TSV_ROWS.map((row) => fleursClipId("da_dk", row.column1));
    expect(new Set(clipIds).size).toBe(TSV_ROWS.length);
    expect(() => assertUniqueClipIds(clipIds)).not.toThrow();
  });

  test("column 0 collapses distinct recordings into one id", () => {
    // The regression witness in miniature: 6 clips, 3 distinct column-0 values. At the
    // real scale that is 930 Danish clips and 350 ids, so a run keyed on column 0 would
    // skip 580 clips it had never transcribed.
    const collapsed = TSV_ROWS.map((row) =>
      fleursClipId("da_dk", `${row.column0}.wav`),
    );
    expect(new Set(collapsed).size).toBe(3);
    expect(new Set(collapsed).size).toBeLessThan(TSV_ROWS.length);
    expect(() => assertUniqueClipIds(collapsed)).toThrow(/same clip twice/);
  });

  test("the measured counts say the same thing about all three locales", () => {
    for (const [locale, counts] of Object.entries(FLEURS_IDENTITY_WITNESS)) {
      expect(counts.distinctColumn0).toBeLessThan(counts.wavs);
      expect(locale).toMatch(/^[a-z]{2}_[a-z0-9]{2,3}$/);
    }
  });
});

describe("the canonical derivation", () => {
  test("FLEURS clipIds are corpus-relative POSIX paths", () => {
    // Pinned character-for-character against what `portableAudioPath()` in
    // dictation-product-benchmark writes for the absolute path
    // `benchmarks/scripts/build-manifests.ts` builds. A change here forks the external
    // archive, where these strings are already committed.
    expect(fleursClipId("da_dk", "12149430079508542992.wav")).toBe(
      "fleurs/da_dk/audio/test/12149430079508542992.wav",
    );
    expect(fleursClipId("es_419", "7285658688146080595.wav")).toBe(
      "fleurs/es_419/audio/test/7285658688146080595.wav",
    );
  });

  test("LibriSpeech clipIds are the relative wav path, id or file name", () => {
    expect(librispeechClipId("test-clean", "1272-128104-0000")).toBe(
      "librispeech/wav/test-clean/1272-128104-0000.wav",
    );
    expect(librispeechClipId("test-clean", "1272-128104-0000.wav")).toBe(
      "librispeech/wav/test-clean/1272-128104-0000.wav",
    );
  });

  test("the absolute path a manifest entry carries yields the same id", () => {
    const root = "/Users/someone/codictate/benchmarks/datasets";
    expect(
      clipIdFromAbsoluteAudioPath(
        `${root}/fleurs/da_dk/audio/test/12149430079508542992.wav`,
        root,
      ),
    ).toBe(fleursClipId("da_dk", "12149430079508542992.wav"));
    // A trailing slash on the root is the same root.
    expect(
      clipIdFromAbsoluteAudioPath(
        `${root}/librispeech/wav/test-other/8455-210777-0000.wav`,
        `${root}/`,
      ),
    ).toBe(librispeechClipId("test-other", "8455-210777-0000"));
  });

  test("a path outside the datasets root has no clipId", () => {
    // Unlike `portableAudioPath`, which falls back to the bare file name. That fallback
    // keeps a foreign-platform record readable; used as identity it would pool one clip
    // as two and count it twice.
    expect(() =>
      clipIdFromAbsoluteAudioPath("/tmp/scratch/clip.wav", "/data/datasets"),
    ).toThrow(/not under the datasets root/);
  });

  test("separators and leading segments normalise to one spelling", () => {
    const canonical = "fleurs/da_dk/audio/test/a.wav";
    for (const variant of [
      "fleurs\\da_dk\\audio\\test\\a.wav",
      "./fleurs/da_dk/audio/test/a.wav",
      "././fleurs/da_dk/audio/test/a.wav",
      "/fleurs/da_dk/audio/test/a.wav",
    ]) {
      expect(clipIdFromRelativeAudioPath(variant)).toBe(canonical);
    }
  });

  test("interior ./ and doubled slashes collapse too", () => {
    // These used to survive, identically in all three repositories - so nothing
    // disagreed loudly enough to notice, and the same file could pool as two clips:
    // one measurement each, half the depth, no error anywhere.
    const canonical = "fleurs/da_dk/audio/test/a.wav";
    for (const variant of [
      "fleurs/./da_dk/audio/test/a.wav",
      "fleurs/da_dk/./audio/./test/a.wav",
      "fleurs//da_dk/audio/test/a.wav",
      "fleurs/da_dk//audio///test/a.wav",
      ".//fleurs/da_dk/audio/test/a.wav",
      "fleurs\\.\\da_dk/audio/test/a.wav",
    ]) {
      expect(clipIdFromRelativeAudioPath(variant)).toBe(canonical);
    }
    // A trailing slash is syntax too.
    expect(clipIdFromRelativeAudioPath("fleurs/da_dk/")).toBe("fleurs/da_dk");
  });

  test("whitespace is refused rather than trimmed", () => {
    // Deliberately the opposite of the usual advice. A POSIX file name may legitimately
    // begin or end with a space, so trimming would either make a real file unaddressable
    // or merge two genuinely different clips. Only the caller knows which it has.
    for (const variant of [
      " fleurs/da_dk/audio/test/a.wav",
      "fleurs/da_dk/audio/test/a.wav ",
      "fleurs/ da_dk/audio/test/a.wav",
      "fleurs/da_dk/audio/test/a.wav\t",
    ]) {
      expect(() => clipIdFromRelativeAudioPath(variant)).toThrow(
        /leading or trailing whitespace/,
      );
    }
    // A space *inside* a segment is a legal file name and is left alone.
    expect(clipIdFromRelativeAudioPath("fleurs/da_dk/my clip.wav")).toBe(
      "fleurs/da_dk/my clip.wav",
    );
  });

  test("a path that normalises to nothing is refused", () => {
    for (const variant of ["/", "./", ".", "//", "./."]) {
      expect(() => clipIdFromRelativeAudioPath(variant)).toThrow(
        /must not be empty/,
      );
    }
  });

  test("an escaping or empty path is refused, not resolved", () => {
    expect(() => clipIdFromRelativeAudioPath("../datasets/a.wav")).toThrow(
      /must not escape/,
    );
    expect(() => clipIdFromRelativeAudioPath("")).toThrow(/must not be empty/);
    expect(() => clipIdFromRelativeAudioPath("C:\\clips\\17.wav")).toThrow(
      /absolute path/,
    );
  });
});

describe("uniqueInOrder and assertUniqueClipIds want opposite things", () => {
  test("uniqueInOrder keeps the first occurrence and the order", () => {
    expect(uniqueInOrder(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
    expect(uniqueInOrder([])).toEqual([]);
  });

  test("assertUniqueClipIds names the clip and both indices", () => {
    // The indices are the useful part: FLEURS file names are 20-digit hashes, and the
    // fact worth printing is that positions 1 and 3 of the plan are the same clip.
    expect(() =>
      assertUniqueClipIds(["a.wav", "b.wav", "c.wav", "b.wav"]),
    ).toThrow(/"b.wav" at index 1 and index 3/);
  });

  test("the label names the plan that carried the duplicate", () => {
    expect(() =>
      assertUniqueClipIds(["a.wav", "a.wav"], "Run Plan r1 (fleurs/da_dk)"),
    ).toThrow(/^Run Plan r1 \(fleurs\/da_dk\) names the same clip twice/);
  });
});
