/**
 * Fill in the sample range (`sampleRange`) on Benchmark Runs written before the sample
 * cursor existed, so a `--samples N` session continues the archive instead of re-measuring
 * its head.
 *
 * Why this is possible: sampling was `entries.slice(0, samples)` over a deterministic
 * ordered manifest, with the first `config.warmupCount` entries transcribed but not
 * scored. Under the cursor the same three entries are a permanent reservation and the
 * consumable range starts after them, so a leaf recording `utteranceCount: N` scored
 * exactly consumable entries `[0, N)`. That arithmetic is verified per leaf rather than
 * trusted: `wer * referenceWords` is an error count, so the recount for the ordering the
 * run used has to divide the recorded rate into a whole number, and the recorded
 * `referenceWords` has to equal that recount.
 *
 * What it refuses, and this is the point of the script rather than an edge case:
 * LibriSpeech was drawn in filesystem-traversal order until d8b91ee ("use seeded shuffle
 * for both", 2026-05-09). Three archived runs predate it. For those runs' LibriSpeech
 * leaves, `utteranceCount` maps to no offset in the ordering a run draws today - the clips
 * they scored are scattered through the seeded list - so no range is written and their
 * cursors stay at zero. Those Speech Models will re-measure some LibriSpeech clips they
 * have already seen once. The pools are 2620 and 2939 clips, so the waste is bounded and
 * correctness is unaffected; a wrong offset would not be.
 *
 * Dry run by default. `--write` is required to touch a file.
 *
 *   bun run benchmarks/scripts/backfill-sample-ranges.ts
 *   bun run benchmarks/scripts/backfill-sample-ranges.ts --write
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SAMPLE_ORDERING,
  EXACT_EPSILON,
  FALLBACK_WARMUP_COUNT,
  RECONCILE_TOLERANCE,
  detectSampleOrdering,
  locateLeaves,
  manifestFor,
  type LocatedLeaf,
} from "./sample-ordering";
import {
  WARMUP_RESERVATION,
  manifestFingerprint,
  type SampleRange,
} from "../stt/sample-cursor";

const RESULTS_BASE_DIR = join(import.meta.dir, "../results");

/** Same run-directory rule the rest of the benchmark reads by (see `coverage.ts`). */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}/;

const fingerprintCache = new Map<string, string | null>();

/** Fingerprint of the ordering a run today draws this dataset in. */
function currentFingerprint(datasetKey: string): string | null {
  const cached = fingerprintCache.get(datasetKey);
  if (cached !== undefined) return cached;
  const manifest = manifestFor(datasetKey, CURRENT_SAMPLE_ORDERING);
  const value = manifest
    ? manifestFingerprint(manifest.map((entry) => entry.id))
    : null;
  fingerprintCache.set(datasetKey, value);
  return value;
}

interface Refusal {
  runName: string;
  leafName: string;
  reason: string;
}

interface Fill {
  item: LocatedLeaf;
  range: SampleRange;
  /** How far the ordering's recount was from a whole number of errors. */
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

  const refusals: Refusal[] = [];
  const inexact: string[] = [];
  let leavesSeen = 0;
  let leavesAlreadyRanged = 0;
  let leavesSkipped = 0;
  let filesChanged = 0;
  let rangesFilled = 0;

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
    const fills: Fill[] = [];

    for (const item of [
      ...locateLeaves(parsed.librispeech),
      ...locateLeaves(parsed.fleurs),
    ]) {
      leavesSeen++;
      const { leaf } = item;
      const leafName = `${item.datasetKey}/${item.modelLabel}`;

      if (leaf.sampleRange !== undefined) {
        leavesAlreadyRanged++;
        continue;
      }

      // The model was not on disk when the run happened: `runner.ts` records a sentinel
      // rather than a measurement, and a sentinel consumed nothing.
      if (leaf.utteranceCount <= 0 || leaf.wer < 0) {
        leavesSkipped++;
        continue;
      }

      // The whole migration rests on "the run's warmups were the entries the cursor now
      // reserves". A run with a different warmup count scored a slice this arithmetic does
      // not describe, and no archived run has one.
      if (warmupCount !== WARMUP_RESERVATION) {
        refusals.push({
          runName,
          leafName,
          reason: `run recorded warmupCount=${warmupCount}, but the cursor reserves ${WARMUP_RESERVATION}; its scored slice does not line up with the consumable range`,
        });
        continue;
      }

      const fingerprint = currentFingerprint(item.datasetKey);
      if (!fingerprint) {
        refusals.push({
          runName,
          leafName,
          reason: `dataset "${item.datasetKey}" is not on disk, so the ordering it would index into cannot be fingerprinted`,
        });
        continue;
      }

      const verdict = detectSampleOrdering(item.datasetKey, warmupCount, leaf);
      if (!verdict) {
        refusals.push({
          runName,
          leafName,
          reason: `no manifest for "${item.datasetKey}" reaches ${warmupCount} warmup + ${leaf.utteranceCount} scored entries`,
        });
        continue;
      }

      if (verdict.deviation > RECONCILE_TOLERANCE) {
        refusals.push({
          runName,
          leafName,
          reason: `no ordering reconciles: best is ${verdict.ordering} at referenceWords=${verdict.counts.referenceWords}, wer x count = ${(leaf.wer * verdict.counts.referenceWords).toFixed(4)} errors, ${verdict.deviation.toFixed(4)} off a whole number`,
        });
        continue;
      }

      if (verdict.ordering !== CURRENT_SAMPLE_ORDERING) {
        // The known trap, refused on purpose and named out loud. An offset into the seeded
        // list would claim this Combination has measured clips it has never seen.
        refusals.push({
          runName,
          leafName,
          reason: `scored in ${verdict.ordering} order (pre-d8b91ee), so utteranceCount=${leaf.utteranceCount} maps to no offset in the ${CURRENT_SAMPLE_ORDERING} ordering; cursor deliberately left at 0`,
        });
        continue;
      }

      // Independent of the ordering check: the denominator the run divided by must be the
      // one this slice contains. If it is not, the leaf was scored over some other slice.
      if (
        typeof leaf.referenceWords === "number" &&
        leaf.referenceWords !== verdict.counts.referenceWords
      ) {
        refusals.push({
          runName,
          leafName,
          reason: `recorded referenceWords=${leaf.referenceWords} but consumable entries [0, ${leaf.utteranceCount}) contain ${verdict.counts.referenceWords}; the leaf was not scored over that range`,
        });
        continue;
      }

      if (!verdict.exact) {
        inexact.push(
          `${runName} ${leafName}: reconciles only within ${verdict.deviation.toFixed(4)} of a whole number of errors`,
        );
      }

      fills.push({
        item,
        range: {
          startIndex: 0,
          endIndex: leaf.utteranceCount,
          manifestFingerprint: fingerprint,
        },
        deviation: verdict.deviation,
      });
    }

    if (fills.length === 0) {
      console.log(`${runName}: nothing to fill`);
      continue;
    }

    console.log(`${runName}:`);
    for (const fill of fills) {
      console.log(
        `  ${fill.item.datasetKey}/${fill.item.modelLabel}: sampleRange [${fill.range.startIndex}, ${fill.range.endIndex}) @ ${fill.range.manifestFingerprint}`,
      );
      rangesFilled++;
      if (write) fill.item.leaf.sampleRange = fill.range;
    }

    if (write) {
      writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
      filesChanged++;
      console.log(`  written to ${jsonPath}`);
    }
  }

  console.log(
    `\n${leavesSeen} leaves seen | ${leavesAlreadyRanged} already ranged | ${leavesSkipped} skipped (no measurement) | ${rangesFilled} range(s) ${write ? "written" : "fillable"}`,
  );
  if (write) console.log(`${filesChanged} file(s) rewritten`);

  if (inexact.length > 0) {
    console.log(
      `\nReconciled, but not to within ${EXACT_EPSILON} (${inexact.length}) - worth a look:`,
    );
    for (const line of inexact) console.log(`  ${line}`);
  }

  if (refusals.length > 0) {
    console.log(
      `\n!! ${refusals.length} leaf/leaves got NO sampleRange and will therefore contribute NO cursor:`,
    );
    for (const refusal of refusals) {
      console.log(
        `  !! ${refusal.runName} ${refusal.leafName}: ${refusal.reason}`,
      );
    }
    console.log(
      "\nThose Benchmark Combinations start their next session at cursor 0 and will re-measure",
    );
    console.log(
      "clips they have already been scored on once. That is the intended outcome for the",
    );
    console.log(
      "pre-d8b91ee LibriSpeech runs: a wrong offset would claim clips were measured that",
    );
    console.log(
      "never were, which no amount of re-measuring can undo. Anything else in this list is",
    );
    console.log("a result whose history does not reconcile - investigate it.");
  }

  if (!write) {
    console.log("\nDry run: nothing written. Re-run with --write to apply.");
  }
}

main();
