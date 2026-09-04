/**
 * Which ordering an archived Benchmark Run drew its sample in, decided from the numbers
 * the run itself recorded.
 *
 * Extracted from `backfill-reference-words.ts`, which needed it first and still uses it:
 * two migrations now depend on knowing this, and a second copy of the reasoning is how the
 * two would end up disagreeing about the same three runs.
 *
 * The question exists because the sampling changed. LibriSpeech was taken in
 * filesystem-traversal order until d8b91ee ("use seeded shuffle for both", 2026-05-09),
 * and three runs in the archive predate it. Those runs scored a different set of utterances
 * than today's manifest yields at the same depth - close enough to look right, and
 * reconciling to nothing.
 *
 * Nothing here guesses. An ordering is accepted because the recorded rate, multiplied by
 * the reference words that ordering's slice contains, lands on a whole number of errors.
 * That is a property no wrong ordering has to a part in 1e-6.
 */

import { join } from "node:path";
import {
  buildFleursManifest,
  buildLibriSpeechManifest,
  type ManifestEntry,
} from "./build-manifests";
import { tokenizeForCer, tokenizeForWer } from "../stt/wer";

const DATASETS_DIR = join(import.meta.dir, "../datasets");

/**
 * Warmup count for a run whose `stt.json` does not record one. Every run so far writes
 * `config.warmupCount`, and that recorded value wins: it is what the run actually did,
 * where this constant is only what the current build would do.
 */
export const FALLBACK_WARMUP_COUNT = 3;

/**
 * How far `rate * count` may sit from a whole number before a leaf is refused. The
 * caller-facing bar, deliberately loose.
 */
export const RECONCILE_TOLERANCE = 0.5;

/**
 * How close a recount has to land before it is treated as *the* denominator rather than a
 * near miss. An exact recount reconciles to floating-point noise, so this is the threshold
 * that actually discriminates - `RECONCILE_TOLERANCE` alone would have accepted every
 * wrongly-ordered LibriSpeech recount.
 */
export const EXACT_EPSILON = 1e-6;

/**
 * The orderings a dataset's sample may have been drawn in.
 *
 * Tried in this order and the first that reconciles wins, so current runs cost one attempt
 * and the archival ordering is only reached by a run that needs it.
 */
export const SAMPLE_ORDERINGS = [
  "seeded shuffle",
  "pre-shuffle traversal",
] as const;

export type SampleOrdering = (typeof SAMPLE_ORDERINGS)[number];

/** The ordering a Benchmark Run today draws every dataset in. */
export const CURRENT_SAMPLE_ORDERING: SampleOrdering = SAMPLE_ORDERINGS[0];

/** A `ModelDatasetResult` as it sits in a file, before any migration. */
export interface RawLeaf {
  wer: number;
  cer?: number;
  referenceWords?: number;
  referenceChars?: number;
  utteranceCount: number;
  [key: string]: unknown;
}

export function isRawLeaf(value: unknown): value is RawLeaf {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.wer === "number" &&
    typeof candidate.utteranceCount === "number"
  );
}

/** One leaf located in a file, with enough context to name it in a report. */
export interface LocatedLeaf {
  datasetKey: string;
  /** Model id, suffixed with the harness bucket when the file has that level. */
  modelLabel: string;
  leaf: RawLeaf;
}

/**
 * Walk a `librispeech` or `fleurs` block, tolerating both on-disk shapes.
 *
 * Files written before ASR Harness became a dimension are `[dataset][model]`; newer ones
 * are `[dataset][harness][model]`. This deliberately does not go through
 * `normalizeDatasetResults`: that migrates the old shape into the new one, and writing the
 * migrated object back would restructure archive files that are only supposed to gain a
 * field. The returned `leaf` is the live object out of the parsed file, so a caller can
 * add a field to it and write the file back unchanged otherwise.
 */
export function locateLeaves(block: unknown): LocatedLeaf[] {
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

/** Whether a dataset key names a LibriSpeech split rather than a FLEURS locale. */
export function isLibriSpeechDatasetKey(datasetKey: string): boolean {
  return datasetKey.startsWith("test-");
}

const manifestCache = new Map<string, ManifestEntry[] | null>();

/**
 * A dataset's full manifest in one ordering, unsliced. `null` when the dataset is not on
 * disk, or when the ordering does not apply to it.
 *
 * Durations are skipped: this only needs transcripts and ids, and measuring a duration
 * means reading the whole wav, which would compete for disk with any Benchmark Run in
 * flight. Ordering and selection do not depend on them.
 */
export function manifestFor(
  datasetKey: string,
  ordering: SampleOrdering,
): ManifestEntry[] | null {
  const cacheKey = `${datasetKey}:${ordering}`;
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let entries: ManifestEntry[] = [];
  if (isLibriSpeechDatasetKey(datasetKey)) {
    entries = buildLibriSpeechManifest(DATASETS_DIR, datasetKey, {
      withDurations: false,
      withShuffle: ordering === "seeded shuffle",
    });
  } else if (ordering === "seeded shuffle") {
    // FLEURS has only ever been seeded, so there is no second ordering to try.
    // Unsliced: the depth a leaf was scored at comes from the leaf, not from a sample size
    // chosen here.
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

export interface Denominators {
  referenceWords: number;
  /** Null when no entry in the slice carries a raw transcript to score CER against. */
  referenceChars: number | null;
}

const denominatorCache = new Map<string, Denominators | null>();

/**
 * Reference counts for one already-selected slice of a manifest.
 *
 * The pure half of {@link denominatorsFor}: no disk, no cache, no ordering question.
 * Extracted so the recount that decides whether an archived leaf reconciles can be
 * tested without the git-ignored `benchmarks/datasets/` tree.
 *
 * The slice is taken **positionally**, and identity plays no part in it: a migration
 * recounts the clips a *depth* covers, and two recordings of one FLEURS sentence are two
 * clips with two transcripts whatever their sentence id says. `assertUniqueClipIds` in
 * `build-manifests.ts` is what guarantees the list this slices is one clip per position;
 * nothing here may de-duplicate, because dropping the second reading of a sentence would
 * silently shorten the denominator and make every leaf reconcile against a count nobody
 * scored.
 */
export function denominatorsForEntries(
  entries: readonly ManifestEntry[],
): Denominators {
  let referenceWords = 0;
  let referenceChars = 0;
  let cerScorable = 0;
  for (const entry of entries) {
    referenceWords += tokenizeForWer(entry.transcript).length;
    // CER is scored against the raw transcript, and only where the manifest has one - the
    // same condition `runner.ts` applies when accumulating `totalRefChars`.
    if (entry.rawTranscript) {
      referenceChars += tokenizeForCer(entry.rawTranscript).length;
      cerScorable++;
    }
  }
  return {
    referenceWords,
    referenceChars: cerScorable > 0 ? referenceChars : null,
  };
}

/**
 * Reference counts for the scored slice of a dataset at a given depth and ordering.
 *
 * Depends only on (dataset, ordering, warmup, depth) - never on the model - so every model
 * that ran the same dataset at the same depth shares one computation.
 */
export function denominatorsFor(
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

  const result = denominatorsForEntries(
    manifest.slice(warmupCount, warmupCount + depth),
  );
  denominatorCache.set(cacheKey, result);
  return result;
}

/** How far `rate * count` sits from a whole number of errors. */
export function deviation(rate: number, count: number): number {
  const errors = rate * count;
  return Math.abs(errors - Math.round(errors));
}

export interface OrderingVerdict {
  ordering: SampleOrdering;
  counts: Denominators;
  /** How far this ordering's recount is from dividing the recorded WER into whole errors. */
  deviation: number;
  /** True when the recount reconciles to floating-point noise. */
  exact: boolean;
}

/**
 * Which ordering the leaf's own `wer` reconciles against, best first.
 *
 * `null` when no ordering has a manifest on disk deep enough to reach the leaf's depth.
 * A verdict is returned even when it does not reconcile - the caller decides what to do
 * with a leaf whose history does not add up, and both callers refuse rather than write.
 */
export function detectSampleOrdering(
  datasetKey: string,
  warmupCount: number,
  leaf: Pick<RawLeaf, "wer" | "utteranceCount">,
): OrderingVerdict | null {
  let best: OrderingVerdict | null = null;
  for (const ordering of SAMPLE_ORDERINGS) {
    const counts = denominatorsFor(
      datasetKey,
      ordering,
      warmupCount,
      leaf.utteranceCount,
    );
    if (!counts) continue;
    const dev = deviation(leaf.wer, counts.referenceWords);
    if (!best || dev < best.deviation) {
      best = {
        ordering,
        counts,
        deviation: dev,
        exact: dev <= EXACT_EPSILON,
      };
    }
    if (dev <= EXACT_EPSILON) break;
  }
  return best;
}
