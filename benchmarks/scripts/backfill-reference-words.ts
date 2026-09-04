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
 * the LibriSpeech ordering change described on `SAMPLE_ORDERINGS` below.
 *
 * Dry run by default. `--write` is required to touch a file.
 *
 *   bun run benchmarks/scripts/backfill-reference-words.ts
 *   bun run benchmarks/scripts/backfill-reference-words.ts --write
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFleursManifest,
  buildLibriSpeechManifest,
  type ManifestEntry,
} from "./build-manifests";
import { tokenizeForCer, tokenizeForWer } from "../stt/wer";

const RESULTS_BASE_DIR = join(import.meta.dir, "../results");
const DATASETS_DIR = join(import.meta.dir, "../datasets");

/** Same run-directory rule the rest of the benchmark reads by (see `coverage.ts`). */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/**
 * Warmup count for a run whose `stt.json` does not record one. Every run so far writes
 * `config.warmupCount`, and that recorded value wins: it is what the run actually did,
 * where this constant is only what the current build would do.
 */
const FALLBACK_WARMUP_COUNT = 3;

/**
 * How far `wer * referenceWords` may sit from a whole number before the leaf is refused.
 * The caller-facing bar, deliberately loose.
 */
const RECONCILE_TOLERANCE = 0.5;

/**
 * How close a recount has to land before it is treated as *the* denominator rather than
 * a near miss. An exact recount reconciles to floating-point noise, so this is the
 * threshold that actually discriminates - `RECONCILE_TOLERANCE` alone would have
 * accepted every wrongly-ordered LibriSpeech recount below.
 */
const EXACT_EPSILON = 1e-6;

/**
 * The orderings a dataset's sample may have been drawn in.
 *
 * More than one exists because the sampling changed: LibriSpeech was taken in
 * filesystem-traversal order until d8b91ee ("use seeded shuffle for both",
 * 2026-05-09), and the three May runs in the archive predate it. Those runs scored a
 * different set of utterances than today's manifest yields at the same depth, so
 * recounting under the current ordering produces a denominator that is not theirs - it
 * is close enough to look right and reconciles to nothing.
 *
 * Orderings are tried in this order and the first that reconciles wins, so current runs
 * cost one attempt and the archival ordering is only reached by a run that needs it.
 * Nothing here guesses: an ordering is accepted because the recorded WER divides by its
 * count into whole errors, and reported by name when it is not the current one.
 */
const SAMPLE_ORDERINGS = ["seeded shuffle", "pre-shuffle traversal"] as const;

type SampleOrdering = (typeof SAMPLE_ORDERINGS)[number];

/** A `ModelDatasetResult` as it sits in a file, before any migration. */
interface RawLeaf {
  wer: number;
  cer?: number;
  referenceWords?: number;
  referenceChars?: number;
  utteranceCount: number;
  [key: string]: unknown;
}

function isRawLeaf(value: unknown): value is RawLeaf {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.wer === "number" &&
    typeof candidate.utteranceCount === "number"
  );
}

/** One leaf located in a file, with enough context to name it in a report. */
interface LocatedLeaf {
  datasetKey: string;
  /** Model id, suffixed with the harness bucket when the file has that level. */
  modelLabel: string;
  leaf: RawLeaf;
}

/**
 * Walk a `librispeech` or `fleurs` block, tolerating both on-disk shapes.
 *
 * Files written before ASR Harness became a dimension are `[dataset][model]`; newer
 * ones are `[dataset][harness][model]`. This deliberately does not go through
 * `normalizeDatasetResults`: that migrates the old shape into the new one, and writing
 * the migrated object back would restructure archive files that are only supposed to
 * gain a field.
 */
function locateLeaves(block: unknown): LocatedLeaf[] {
  if (!block || typeof block !== "object") return [];
  const found: LocatedLeaf[] = [];

  for (const [datasetKey, byKey] of Object.entries(
    block as Record<string, unknown>,
  )) {
    if (!byKey || typeof byKey !== "object") continue;
    for (const [key, value] of Object.entries(
      byKey as Record<string, unknown>,
    )) {
      if (isRawLeaf(value)) {
        // Pre-harness shape: `key` is the model id.
        found.push({ datasetKey, modelLabel: key, leaf: value });
        continue;
      }
      if (!value || typeof value !== "object") continue;
      for (const [modelId, leaf] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!isRawLeaf(leaf)) continue;
        found.push({ datasetKey, modelLabel: `${modelId}@${key}`, leaf });
      }
    }
  }
  return found;
}

const manifestCache = new Map<string, ManifestEntry[] | null>();

/**
 * A dataset's full manifest in one ordering, unsliced. `null` when the dataset is not
 * on disk, or when the ordering does not apply to it.
 *
 * Durations are skipped: this only needs transcripts, and measuring a duration means
 * reading the whole wav, which would compete for disk with any Benchmark Run in flight.
 * Ordering and selection do not depend on them.
 */
function manifestFor(
  datasetKey: string,
  ordering: SampleOrdering,
): ManifestEntry[] | null {
  const cacheKey = `${datasetKey}:${ordering}`;
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Dataset keys are LibriSpeech split names (`test-clean`, `test-other`) or FLEURS
  // locale codes; the report tells them apart by the same prefix.
  const isLibriSpeech = datasetKey.startsWith("test-");

  let entries: ManifestEntry[] = [];
  if (isLibriSpeech) {
    entries = buildLibriSpeechManifest(DATASETS_DIR, datasetKey, {
      withDurations: false,
      withShuffle: ordering === "seeded shuffle",
    });
  } else if (ordering === "seeded shuffle") {
    // FLEURS has only ever been seeded, so there is no second ordering to try.
    // Unsliced: the depth a leaf was scored at comes from the leaf, not from a sample
    // size chosen here.
    entries = buildFleursManifest(
      DATASETS_DIR,
      datasetKey,
      Number.MAX_SAFE_INTEGER,
      { withDurations: false },
    );
  }

  const result = entries.length > 0 ? entries : null;
  manifestCache.set(cacheKey, result);
  return result;
}

interface Denominators {
  referenceWords: number;
  /** Null when no entry in the slice carries a raw transcript to score CER against. */
  referenceChars: number | null;
}

const denominatorCache = new Map<string, Denominators | null>();

/**
 * Reference counts for the scored slice of a dataset at a given depth and ordering.
 *
 * Depends only on (dataset, ordering, warmup, depth) - never on the model - so every
 * model that ran the same dataset at the same depth shares one computation.
 */
function denominatorsFor(
  datasetKey: string,
  ordering: SampleOrdering,
  warmupCount: number,
  depth: number,
): Denominators | null {
  const cacheKey = `${datasetKey}:${ordering}:${warmupCount}:${depth}`;
  const cached = denominatorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const manifest = manifestFor(datasetKey, ordering);
  if (!manifest || manifest.length < warmupCount + depth) {
    denominatorCache.set(cacheKey, null);
    return null;
  }

  let referenceWords = 0;
  let referenceChars = 0;
  let cerScorable = 0;
  for (const entry of manifest.slice(warmupCount, warmupCount + depth)) {
    referenceWords += tokenizeForWer(entry.transcript).length;
    // CER is scored against the raw transcript, and only where the manifest has one -
    // the same condition `runner.ts` applies when accumulating `totalRefChars`.
    if (entry.rawTranscript) {
      referenceChars += tokenizeForCer(entry.rawTranscript).length;
      cerScorable++;
    }
  }

  const result: Denominators = {
    referenceWords,
    referenceChars: cerScorable > 0 ? referenceChars : null,
  };
  denominatorCache.set(cacheKey, result);
  return result;
}

/** How far `rate * count` sits from a whole number of errors. */
function deviation(rate: number, count: number): number {
  const errors = rate * count;
  return Math.abs(errors - Math.round(errors));
}

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
      let best: { ordering: SampleOrdering; counts: Denominators } | null =
        null;
      let bestDeviation = Number.POSITIVE_INFINITY;
      for (const ordering of SAMPLE_ORDERINGS) {
        const counts = denominatorsFor(
          item.datasetKey,
          ordering,
          warmupCount,
          leaf.utteranceCount,
        );
        if (!counts) continue;
        const dev = deviation(leaf.wer, counts.referenceWords);
        if (dev < bestDeviation) {
          bestDeviation = dev;
          best = { ordering, counts };
        }
        if (dev <= EXACT_EPSILON) break;
      }

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
        ordering === SAMPLE_ORDERINGS[0] ? "" : `  [${ordering} ordering]`;
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
