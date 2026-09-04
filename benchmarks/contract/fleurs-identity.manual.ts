/**
 * The FLEURS column-0 witness, measured against the real `test.tsv` files.
 *
 * Opt-in, and for the reason `benchmarks/stt/results-archive.manual.ts` is: it is
 * pinned to data that is not part of the repository. `benchmarks/datasets/` is
 * git-ignored - the corpora are gigabytes - so this suite cannot run in CI and would
 * turn `bun test` red on a fresh checkout with nothing broken. The rule it witnesses is
 * covered on every machine by `clip-identity.test.ts`, on a synthetic mirror of the
 * same shape.
 *
 * Run it after downloading the datasets, or after touching anything about FLEURS
 * identity:
 *
 * ```
 * bun test ./benchmarks/contract/fleurs-identity.manual.ts
 * ```
 *
 * The leading `./` is required: without it `bun test` reads the argument as a name
 * filter, matches nothing, and runs nothing.
 *
 * The counts below are measured facts about the three downloaded locales, not targets.
 * If a number moves, the corpus moved: say so in the change rather than editing the
 * number quietly, because every stored clipId and every fingerprint is taken over these
 * files.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertUniqueClipIds, fleursClipId } from "./clip-identity";
import { fingerprintV2 } from "./schema";

const DATASETS_DIR = join(import.meta.dir, "..", "datasets");

/** Measured 2026-09-04. `rows` is the TSV data-row count, one row per recording. */
const EXPECTED = {
  da_dk: { rows: 930, distinctColumn0: 350 },
  es_419: { rows: 908, distinctColumn0: 348 },
  hu_hu: { rows: 905, distinctColumn0: 348 },
} as const;

/**
 * The TSV data rows for one locale, in the file's natural on-disk order.
 *
 * Header detection copies `benchmarks/scripts/build-manifests.ts` exactly, rather than
 * assuming there is no header: the three downloaded files have none (930, 908 and 905
 * data rows), and a locale downloaded later might.
 */
function dataRows(locale: string): string[][] {
  const tsvPath = join(DATASETS_DIR, "fleurs", locale, "test.tsv");
  const lines = readFileSync(tsvPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim());
  const first = lines[0];
  const hasHeader =
    first?.includes("file_name") || first?.includes("transcription");
  return (hasHeader ? lines.slice(1) : lines).map((line) => line.split("\t"));
}

const datasetsPresent = existsSync(join(DATASETS_DIR, "fleurs"));

describe("FLEURS identity, against the real TSVs", () => {
  test("the datasets directory is present", () => {
    expect(datasetsPresent).toBe(true);
  });

  for (const [locale, expected] of Object.entries(EXPECTED)) {
    describe(locale, () => {
      test("every row has an audio file on disk", () => {
        const rows = dataRows(locale);
        expect(rows.length).toBe(expected.rows);
        for (const row of rows) {
          const audioPath = join(
            DATASETS_DIR,
            "fleurs",
            locale,
            "audio",
            "test",
            row[1],
          );
          expect(existsSync(audioPath)).toBe(true);
        }
      });

      test("column 1 gives a unique clipId for every recording", () => {
        const clipIds = dataRows(locale).map((row) =>
          fleursClipId(locale, row[1]),
        );
        expect(clipIds.length).toBe(expected.rows);
        expect(new Set(clipIds).size).toBe(expected.rows);
        expect(() => assertUniqueClipIds(clipIds, locale)).not.toThrow();
      });

      test("column 0 does not: it is a sentence id and it repeats", () => {
        const rows = dataRows(locale);
        const distinct = new Set(rows.map((row) => row[0]));
        expect(distinct.size).toBe(expected.distinctColumn0);
        expect(distinct.size).toBeLessThan(expected.rows);
        // What keying identity on column 0 would cost this locale.
        expect(expected.rows - distinct.size).toBeGreaterThan(0);

        const collapsed = rows.map((row) =>
          fleursClipId(locale, `${row[0]}.wav`),
        );
        expect(new Set(collapsed).size).toBe(expected.distinctColumn0);
        expect(() => assertUniqueClipIds(collapsed, locale)).toThrow(
          /same clip twice/,
        );
      });
    });
  }
});

describe("the real-fleurs-da-first-5 fixture is reproducible", () => {
  test("it is column 1 of the first 5 da_dk rows, in natural order", () => {
    // Natural on-disk order, not `seededShuffle(entries, 42)`. The shuffle is a
    // Codictate implementation detail; the fixture has to be reproducible in the
    // external repository with `head -5 test.tsv | cut -f2`.
    const clipIds = dataRows("da_dk")
      .slice(0, 5)
      .map((row) => fleursClipId("da_dk", row[1]));
    expect(clipIds).toEqual([
      "fleurs/da_dk/audio/test/12149430079508542992.wav",
      "fleurs/da_dk/audio/test/1892314626509120692.wav",
      "fleurs/da_dk/audio/test/11657230937236500261.wav",
      "fleurs/da_dk/audio/test/10016401698104160032.wav",
      "fleurs/da_dk/audio/test/15945042231538223000.wav",
    ]);
    expect(fingerprintV2(clipIds)).toBe("d28f996584b02f28");
  });

  test("the first two rows share a sentenceId, which is why column 0 is not identity", () => {
    const rows = dataRows("da_dk");
    expect(rows[0][0]).toBe(rows[1][0]);
    expect(rows[0][1]).not.toBe(rows[1][1]);
  });
});
