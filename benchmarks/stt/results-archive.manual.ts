/**
 * Regression guard for the archived Benchmark Runs in `benchmarks/results/`.
 *
 * These tests read the real result files, not fixtures. That is deliberate: the
 * whisper-cli measurements in them can never be produced again now that whisper-cli is
 * retired from the build, so "can we still read them" is a property of those exact
 * files. The failure mode being guarded against is silent - validating a Harness key
 * read off disk against the *runnable* Harness set makes every whisper-cli bucket
 * vanish through a `continue`, with no error and a plausible-looking report.
 *
 * If a test here fails, the archive has stopped parsing. Do not adjust the expected
 * numbers to match; fix the read path.
 *
 * This is deliberately outside the default `bun test` run - the `.manual.ts` suffix keeps
 * it out of test discovery. The assertions are pinned to the seven archived runs that exist
 * today (`coverage.runCount` is asserted to be exactly 7), so an eighth Benchmark Run turns
 * the suite red without anything having broken. Its subject is the archive on disk, not
 * the code under change, which makes it a check to run when the archive moves rather than
 * a gate on every commit.
 *
 * Run it deliberately:
 *
 *   bun run test:manual
 *   bun test ./benchmarks/stt/results-archive.manual.ts
 *
 * The leading `./` matters: without it `bun test` reads the argument as a name filter,
 * finds nothing that matches the default test globs, and exits without running anything.
 *
 * Run it after archiving a Benchmark Run or touching the results read path, and update
 * the pinned run list and counts in the same change.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ASR_HARNESS_IDS } from "../../src/shared/asr-harness";
import { getSpeechModel } from "../../src/shared/speech-models";
import { generateMarkdownReport, type BenchmarkResults } from "./report";
import { loadCoverage } from "./coverage";
import { deepestCursorForDataset } from "./sample-cursor";
import {
  flattenDatasetResults,
  harnessLabelsPresent,
  isBenchmarkHarnessLabel,
  makeVariantKey,
  normalizeDatasetResults,
  parseVariantKey,
  BENCHMARK_HARNESS_LABELS,
  DEFAULT_HARNESS_LABEL,
  PRE_HARNESS_ARCHIVE_LABEL,
} from "./results-schema";

const RESULTS_DIR = join(import.meta.dir, "../results");

/** The Benchmark Run whose whisper-cli numbers justified retiring whisper-cli. */
const COMPARISON_RUN = "2026-08-17_15-15-49_crispasr-vs-whisper";

/** Runs written before ASR Harness was a dimension. All whisper-cli. */
const PRE_HARNESS_RUNS = [
  "2026-05-08_07-56-46_main-model-comparison",
  "2026-05-09_10-12-34_tiny-base-triage",
  "2026-05-09_15-40-49_full-run-except-tiny-base",
];

function readRun(run: string): BenchmarkResults {
  const parsed = JSON.parse(
    readFileSync(join(RESULTS_DIR, run, "stt.json"), "utf-8"),
  );
  return {
    ...parsed,
    librispeech: normalizeDatasetResults(parsed.librispeech),
    fleurs: normalizeDatasetResults(parsed.fleurs),
  } as BenchmarkResults;
}

describe("runnable Harnesses vs archived Harness labels", () => {
  test("whisper-cli is an archived label but is not runnable", () => {
    expect(isBenchmarkHarnessLabel("whisper-cli")).toBe(true);
    expect((ASR_HARNESS_IDS as readonly string[]).includes("whisper-cli")).toBe(
      false,
    );
  });

  test("every runnable Harness is also an archived label", () => {
    for (const id of ASR_HARNESS_IDS) {
      expect(isBenchmarkHarnessLabel(id)).toBe(true);
    }
  });

  test("variant keys round-trip for every archived label", () => {
    for (const label of BENCHMARK_HARNESS_LABELS) {
      const key = makeVariantKey(label, "large-v3-turbo-q5_0");
      expect(parseVariantKey(key)).toEqual({
        modelId: "large-v3-turbo-q5_0",
        harness: label,
      });
    }
  });

  test("the pre-harness archive label is not the shipping default", () => {
    // Re-pointing this at the default silently re-attributes 34 Speech Models' worth of
    // whisper-cli measurements to whichever Harness happens to ship.
    expect(PRE_HARNESS_ARCHIVE_LABEL).toBe("whisper-cli");
    expect(PRE_HARNESS_ARCHIVE_LABEL).not.toBe(DEFAULT_HARNESS_LABEL);
  });
});

describe(`archived comparison run: ${COMPARISON_RUN}`, () => {
  const results = readRun(COMPARISON_RUN);

  test("both Harness buckets survive parsing", () => {
    expect(harnessLabelsPresent(results.librispeech, results.fleurs)).toEqual([
      "crispasr",
      "whisper-cli",
    ]);
  });

  test("each bucket keeps its three real Speech Models", () => {
    for (const byHarness of Object.values(results.librispeech)) {
      for (const label of ["crispasr", "whisper-cli"] as const) {
        const byModel = byHarness[label];
        expect(Object.keys(byModel ?? {}).sort()).toEqual([
          "large-v3-q5_0",
          "large-v3-turbo-q5_0",
          "medium.en-q5_0",
        ]);
      }
    }
  });

  test("a Harness name is never mistaken for a Speech Model", () => {
    // The harness-keyed file read as the pre-harness shape produced exactly this:
    // `crispasr` and `whisper-cli` as row keys, every measurement lost.
    for (const key of Object.keys(
      flattenDatasetResults(results.librispeech)["test-clean"],
    )) {
      expect(isBenchmarkHarnessLabel(parseVariantKey(key).modelId)).toBe(false);
      expect(getSpeechModel(parseVariantKey(key).modelId)).toBeDefined();
    }
  });

  test("report labels the archived whisper-cli rows and keeps their numbers", () => {
    const report = generateMarkdownReport(results);
    // Both Harnesses stay distinguishable: retired rows are tagged, shipping rows are not.
    expect(report).toContain("| Large V3 q5_0 [whisper-cli] |");
    expect(report).toContain("| Large V3 q5_0 |");
    expect(report).toContain("**ASR Harnesses:**");
    // Peak RSS is the measurement that decided the switch: 2.0 GB under whisper-cli
    // against 1.5 GB under crispasr, on large-v3-q5_0.
    expect(report).toMatch(
      /\| Large V3 q5_0 \[whisper-cli\] \| 1\.1 GB \| 2\.0 GB/,
    );
    expect(report).toMatch(/\| Large V3 q5_0 \| 1\.1 GB \| 1\.5 GB/);
  });
});

describe("pre-harness archived runs", () => {
  for (const run of PRE_HARNESS_RUNS) {
    test(`${run} migrates under whisper-cli`, () => {
      const results = readRun(run);
      const datasets = Object.values(results.librispeech);
      expect(datasets.length).toBeGreaterThan(0);

      for (const byHarness of datasets) {
        const whisperCli = byHarness["whisper-cli"] ?? {};
        expect(Object.keys(whisperCli).length).toBeGreaterThan(0);
        for (const modelId of Object.keys(whisperCli)) {
          // Parakeet never ran under a Harness, so it must not land in this bucket.
          expect(getSpeechModel(modelId)?.engine).not.toBe("whisperkit");
        }
      }
    });
  }

  test("Parakeet stays in the default bucket, untagged in the report", () => {
    const results = readRun("2026-05-08_07-56-46_main-model-comparison");
    const flat = flattenDatasetResults(results.librispeech)["test-clean"];
    expect(flat["parakeet-tdt-0.6b-v3"]).toBeDefined();
    expect(flat["parakeet-tdt-0.6b-v3@whisper-cli"]).toBeUndefined();
  });
});

describe("coverage across every archived run", () => {
  const coverage = loadCoverage(RESULTS_DIR);

  test("all seven run directories are counted", () => {
    const runDirs = readdirSync(RESULTS_DIR).filter(
      (d) =>
        /^\d{4}-\d{2}-\d{2}/.test(d) &&
        existsSync(join(RESULTS_DIR, d, "stt.json")),
    );
    expect(coverage.runCount).toBe(runDirs.length);
    expect(coverage.runCount).toBe(7);
  });

  test("archived whisper-cli Combinations count as measured", () => {
    const whisperCli = coverage.index["whisper-cli"] ?? {};
    // The three pre-harness runs plus the comparison run cover 33 whisper Speech Models.
    expect(Object.keys(whisperCli).length).toBeGreaterThanOrEqual(33);
    expect(whisperCli["large-v3-turbo-q5_0"]?.["test-clean"]).toBeGreaterThan(
      0,
    );
  });

  test("no phantom Harness bucket appears in coverage", () => {
    for (const label of Object.keys(coverage.index)) {
      expect(isBenchmarkHarnessLabel(label)).toBe(true);
    }
  });
});

/**
 * The sample cursor over the real archive, after `scripts/backfill-sample-ranges.ts`.
 *
 * Pinned here rather than in the default suite for the same reason as everything else in
 * this file: the subject is these exact files. What it guards is the migration's one
 * deliberate hole - the three pre-d8b91ee runs' LibriSpeech leaves carry no range, so those
 * Combinations must read as cursor 0 and be re-measured, and nothing may later "helpfully"
 * infer a depth from their `utteranceCount`.
 */
describe("sample cursors across the archive", () => {
  const coverage = loadCoverage(RESULTS_DIR, { cache: false });

  test("the pre-d8b91ee runs contribute no LibriSpeech cursor", () => {
    // Speech Models that appear only in the three May runs, so their whisper-cli
    // LibriSpeech numbers can only have come from the traversal ordering.
    for (const split of ["test-clean", "test-other"]) {
      for (const modelId of ["tiny", "medium", "large-v2", "small-q5_1"]) {
        expect(
          deepestCursorForDataset(
            coverage.cursors,
            PRE_HARNESS_ARCHIVE_LABEL,
            modelId,
            split,
          ),
        ).toBe(0);
        // They were measured, though - dozens of utterances of a list nobody can index.
        expect(
          coverage.index[PRE_HARNESS_ARCHIVE_LABEL]?.[modelId]?.[split],
        ).toBeGreaterThan(0);
      }
    }
  });

  test("a post-d8b91ee whisper-cli run does set a LibriSpeech cursor", () => {
    // The refusal is per run, not per Harness. `2026-08-17_15-15-49_crispasr-vs-whisper`
    // ran whisper-cli after the seeded shuffle landed, so its 17 clips are locatable, while
    // the same Speech Model's 197 May clips on the same split are not - and the cursor is
    // the August number rather than the deeper May one.
    for (const split of ["test-clean", "test-other"]) {
      expect(
        deepestCursorForDataset(
          coverage.cursors,
          PRE_HARNESS_ARCHIVE_LABEL,
          "large-v3-turbo-q5_0",
          split,
        ),
      ).toBe(17);
      expect(
        coverage.index[PRE_HARNESS_ARCHIVE_LABEL]?.["large-v3-turbo-q5_0"]?.[
          split
        ],
      ).toBe(197);
    }
  });

  test("FLEURS in those same runs does carry a cursor", () => {
    // Same runs, same models, seeded from the start: the reason the refusal above is about
    // the LibriSpeech ordering and not about the age of the run.
    expect(
      deepestCursorForDataset(
        coverage.cursors,
        PRE_HARNESS_ARCHIVE_LABEL,
        "large-v3-turbo-q5_0",
        "hu_hu",
      ),
    ).toBe(197);
    expect(
      deepestCursorForDataset(
        coverage.cursors,
        PRE_HARNESS_ARCHIVE_LABEL,
        "tiny",
        "hu_hu",
      ),
    ).toBe(47);
  });

  test("the crispasr 400-clip run sets a cursor on both dataset families", () => {
    for (const datasetKey of ["test-clean", "test-other", "es_419", "hu_hu"]) {
      expect(
        deepestCursorForDataset(
          coverage.cursors,
          DEFAULT_HARNESS_LABEL,
          "large-v3-q5_0",
          datasetKey,
        ),
      ).toBe(397);
    }
  });

  test("every recorded range agrees with its own utteranceCount", () => {
    expect(coverage.cursors.inconsistencies).toEqual([]);
  });

  test("each dataset has exactly one recorded ordering", () => {
    // More than one would mean a stored offset points into a list that is not on disk, and
    // `run-stt.ts` refuses to run at all until it is resolved.
    for (const [datasetKey, byFingerprint] of Object.entries(
      coverage.cursors.fingerprints,
    )) {
      expect(Object.keys(byFingerprint).length).toBe(1);
      expect(Object.keys(byFingerprint)[0]).toMatch(
        new RegExp(`^\\d+:[0-9a-f]{16}$`),
      );
      expect(datasetKey).toBeTypeOf("string");
    }
  });
});
