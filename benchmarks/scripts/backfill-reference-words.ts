/**
 * Fill in the accuracy denominators (`referenceWords`, `referenceChars`) on
 * Benchmark Runs written before those fields existed, without re-running a model.
 *
 * Why this is possible at all: a denominator is a property of the *sample*, not of the
 * Speech Model that transcribed it. Sample selection is deterministic - a seeded
 * shuffle (seed 42, `seededShuffle` in `build-manifests.ts`) followed by
 * `.slice(0, samples)`, with the first `warmupCount` entries transcribed but not
 * scored. So a leaf recording `utteranceCount: N` for dataset D was scored over
 * manifest entries `[warmup, warmup + N)` of D, whichever model produced it, and the
 * reference words in that slice can simply be recounted.
 *
 * Why the denominators matter: pooled accuracy is `sum(errors) / sum(referenceWords)`.
 * An unweighted mean of per-dataset WERs is a different number and is not the accuracy
 * of the combined sample. Without a denominator on the leaf a consumer physically
 * cannot pool, which is what this backfill fixes for the archive.
 *
 * The recount is checked against history rather than trusted. `wer * referenceWords` is
 * an error count, so it must land on a whole number; a recount that does not is not the
 * denominator WER was actually divided by, and the leaf is reported and left alone
 * rather than written with a plausible-looking wrong number. That check is what caught
 * the LibriSpeech ordering change described in `sample-ordering.ts`, which now owns the
 * ordering detection this script needs and `backfill-sample-ranges.ts` needs too.
 *
 * Dry run by default. `--write` is required to touch a file.
 *
 *   bun run benchmarks/scripts/backfill-reference-words.ts
 *   bun run benchmarks/scripts/backfill-reference-words.ts --write
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deviation,
  detectSampleOrdering,
  locateLeaves,
  CURRENT_SAMPLE_ORDERING,
  EXACT_EPSILON,
  FALLBACK_WARMUP_COUNT,
  RECONCILE_TOLERANCE,
  type Denominators,
  type LocatedLeaf,
  type SampleOrdering,
} from "./sample-ordering";

const RESULTS_BASE_DIR = join(import.meta.dir, "../results");

/** Same run-directory rule the rest of the benchmark reads by (see `coverage.ts`). */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}/;

interface Failure {
  runName: string;
  leafName: string;
  field: "referenceWords" | "referenceChars";
  reason: string;
}

interface Fill {
  field: "referenceWords" | "referenceChars";
  value: number;
  deviation: number;
}

function main(): void {
  const write = process.argv.includes("--write");

  if (!existsSync(RESULTS_BASE_DIR)) {
    console.error(`No results directory at ${RESULTS_BASE_DIR}`);
    process.exit(1);
  }

  const runNames = readdirSync(RESULTS_BASE_DIR)
    .filter((name) => RUN_DIR_PATTERN.test(name))
    .sort();

  const failures: Failure[] = [];
  const inexact: string[] = [];
  let leavesSeen = 0;
  let leavesAlreadyComplete = 0;
  let leavesSkipped = 0;
  let filesChanged = 0;
  let fieldsFilled = 0;

  console.log(
    `${write ? "WRITE" : "DRY RUN"} - ${runNames.length} run director${runNames.length === 1 ? "y" : "ies"} under ${RESULTS_BASE_DIR}\n`,
  );

  for (const runName of runNames) {
    const jsonPath = join(RESULTS_BASE_DIR, runName, "stt.json");
    // A run with no `stt.json` has not finished. Its results are not final and, if it is
    // the run happening right now, the file is not this script's to touch.
    if (!existsSync(jsonPath)) {
      console.log(`${runName}: no stt.json (incomplete run) - skipped`);
      continue;
    }

    let parsed: {
      config?: { warmupCount?: number };
      librispeech?: unknown;
      fleurs?: unknown;
    };
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch (err) {
      console.log(
        `${runName}: stt.json is not readable (${String(err)}) - skipped`,
      );
      continue;
    }

    const warmupCount = parsed.config?.warmupCount ?? FALLBACK_WARMUP_COUNT;
    const planned: Array<{
      item: LocatedLeaf;
      ordering: SampleOrdering;
      fills: Fill[];
    }> = [];

    for (const item of [
      ...locateLeaves(parsed.librispeech),
      ...locateLeaves(parsed.fleurs),
    ]) {
      leavesSeen++;
      const { leaf } = item;
      const leafName = `${item.datasetKey}/${item.modelLabel}`;

      // The model was not on disk when the run happened: `runner.ts` records a sentinel
      // rather than a measurement, and a sentinel has no denominator.
      if (leaf.utteranceCount <= 0 || leaf.wer < 0) {
        leavesSkipped++;
        continue;
      }

      const needsWords = typeof leaf.referenceWords !== "number";
      const needsChars =
        typeof leaf.cer === "number" && typeof leaf.referenceChars !== "number";
      if (!needsWords && !needsChars) {
        leavesAlreadyComplete++;
        continue;
      }

      // Pick the ordering history actually used, by asking which one divides the
      // recorded WER into whole errors.
      const verdict = detectSampleOrdering(item.datasetKey, warmupCount, leaf);
      const best: { ordering: SampleOrdering; counts: Denominators } | null =
        verdict;
      const bestDeviation = verdict?.deviation ?? Number.POSITIVE_INFINITY;

      if (!best) {
        failures.push({
          runName,
          leafName,
          field: "referenceWords",
          reason: `no manifest for "${item.datasetKey}" reaches ${warmupCount} warmup + ${leaf.utteranceCount} scored entries`,
        });
        continue;
      }

      if (bestDeviation > RECONCILE_TOLERANCE) {
        failures.push({
          runName,
          leafName,
          field: "referenceWords",
          reason: `no ordering reconciles: best is ${best.ordering} at referenceWords=${best.counts.referenceWords}, wer x count = ${(leaf.wer * best.counts.referenceWords).toFixed(4)} errors, ${bestDeviation.toFixed(4)} off a whole number`,
        });
        continue;
      }

      const fills: Fill[] = [];
      if (needsWords) {
        fills.push({
          field: "referenceWords",
          value: best.counts.referenceWords,
          deviation: bestDeviation,
        });
      }

      if (needsChars) {
        const referenceChars = best.counts.referenceChars;
        if (referenceChars === null) {
          failures.push({
            runName,
            leafName,
            field: "referenceChars",
            reason: `leaf records a cer but "${item.datasetKey}" has no raw transcripts to recount characters from`,
          });
        } else {
          const dev = deviation(leaf.cer as number, referenceChars);
          if (dev > RECONCILE_TOLERANCE) {
            failures.push({
              runName,
              leafName,
              field: "referenceChars",
              reason: `referenceChars=${referenceChars} does not reconcile: cer x count = ${((leaf.cer as number) * referenceChars).toFixed(4)} errors, ${dev.toFixed(4)} off a whole number`,
            });
          } else {
            fills.push({
              field: "referenceChars",
              value: referenceChars,
              deviation: dev,
            });
          }
        }
      }

      for (const fill of fills) {
        if (fill.deviation > EXACT_EPSILON) {
          inexact.push(
            `${runName} ${leafName} ${fill.field}=${fill.value} is only within ${fill.deviation.toFixed(4)} of a whole number of errors`,
          );
        }
      }

      if (fills.length > 0) {
        planned.push({ item, ordering: best.ordering, fills });
      }
    }

    if (planned.length === 0) {
      console.log(`${runName}: nothing to fill`);
      continue;
    }

    console.log(`${runName}:`);
    for (const { item, ordering, fills } of planned) {
      const detail = fills.map((f) => `${f.field}=${f.value}`).join(", ");
      // The ordering is named only when it is not the current one, so a line without a
      // note means the sample reproduces exactly as a run today would draw it.
      const note =
        ordering === CURRENT_SAMPLE_ORDERING ? "" : `  [${ordering} ordering]`;
      console.log(`  ${item.datasetKey}/${item.modelLabel}: ${detail}${note}`);
      fieldsFilled += fills.length;
      if (write) for (const fill of fills) item.leaf[fill.field] = fill.value;
    }

    if (write) {
      writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
      filesChanged++;
      console.log(`  written to ${jsonPath}`);
    }
  }

  console.log(
    `\n${leavesSeen} leaves seen | ${leavesAlreadyComplete} already complete | ${leavesSkipped} skipped (no measurement) | ${fieldsFilled} field(s) ${write ? "written" : "fillable"}`,
  );
  if (write) console.log(`${filesChanged} file(s) rewritten`);

  if (inexact.length > 0) {
    console.log(
      `\nReconciled, but not exactly (${inexact.length}) - worth a look before publishing:`,
    );
    for (const line of inexact) console.log(`  ${line}`);
  }

  if (failures.length > 0) {
    console.error(
      `\n!! ${failures.length} field(s) did NOT reconcile and were NOT filled:`,
    );
    for (const failure of failures) {
      console.error(
        `  !! ${failure.runName} ${failure.leafName} [${failure.field}]: ${failure.reason}`,
      );
    }
    console.error(
      "\nThose results' history does not reconcile with the datasets on disk. Do not publish a pooled figure that includes them until it does.",
    );
    process.exit(1);
  }

  if (!write) {
    console.log("\nDry run: nothing written. Re-run with --write to apply.");
  }
}

main();
