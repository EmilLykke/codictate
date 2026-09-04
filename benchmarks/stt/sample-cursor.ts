/**
 * Where a Benchmark Combination has got to in a dataset's ordered clip list.
 *
 * A dataset's manifest is a deterministic ordered list - `seededShuffle(..., 42)` in
 * `scripts/build-manifests.ts` - so "which clips has this Speech Model been measured on"
 * is fully described by one integer offset into that list. No per-clip identity has to be
 * stored, which matters because the harness never kept it: `ModelDatasetResult` records a
 * rate, a denominator and a count, and nothing about which utterances produced them.
 *
 * Three rules make that integer trustworthy, and each one is a failure mode that has
 * already happened or was one flag away from happening:
 *
 * 1. **The first `WARMUP_RESERVATION` entries are reserved forever.** They are replayed at
 *    the start of every session so the model is warm, and they are never scored and never
 *    consumed. Before the cursor existed, warmups came off the head of the slice, so every
 *    session would have burned three fresh clips as warmups and then scored the rest.
 * 2. **A range is stored with the fingerprint of the ordering it indexes into.** An offset
 *    is meaningless against a different ordering, and LibriSpeech's ordering has already
 *    changed once (d8b91ee, "use seeded shuffle for both"). A mismatch is fatal rather than
 *    silently restarting from zero - see `manifestFingerprintConflicts`.
 * 3. **The cursor is derived from the run directories, never hand-maintained.** The results
 *    tree is the source of truth; anything cached is a cache. See `loadCoverage` in
 *    `coverage.ts`, which does the scan.
 */

import { createHash } from "node:crypto";

/**
 * Leading entries of every dataset's ordered manifest that are replayed as warmups and
 * never scored.
 *
 * A permanent reservation, not a per-session count: the consumable range starts at this
 * index and the same three clips warm every (Speech Model, dataset) session forever. That
 * is what makes an offset comparable across sessions - a warmup that also advanced the
 * cursor would move the whole ordered list under every previously recorded offset.
 */
export const WARMUP_RESERVATION = 3;

/**
 * A half-open `[startIndex, endIndex)` range of *consumable* entries one Benchmark
 * Combination measured, plus the ordering those indices are meaningful against.
 *
 * Consumable indices, so index 0 is manifest entry `WARMUP_RESERVATION`. `endIndex -
 * startIndex` equals the leaf's `utteranceCount`; a leaf that measured nothing records a
 * zero-width range rather than omitting one.
 */
export interface SampleRange {
  /** First consumable entry measured, counting from the end of the warmup reservation. */
  startIndex: number;
  /** One past the last consumable entry measured. */
  endIndex: number;
  /**
   * Fingerprint of the ordered clip-ID list these indices point into. See
   * `manifestFingerprint`.
   */
  manifestFingerprint: string;
}

/**
 * A stable name for one ordered clip list: `<count>:<first 16 hex of sha256>` over the
 * ids joined by newline, in manifest order.
 *
 * The count is in the string on purpose - it is the part a human can check by eye, and a
 * pool that gained or lost clips is the likeliest cause of a mismatch. The digest is
 * truncated because this is an equality token, not a signature.
 *
 * Computed over the *whole* ordered list including the reserved warmups: the reservation
 * is derived from the head of that list, so a change to the head has to invalidate every
 * stored offset too.
 *
 * `dictation-product-benchmark` computes the same fingerprint over the same ids (its
 * `buildManifest` produces identical ids in identical order), so a range recorded there
 * and a range recorded here index into the same list and can be compared.
 */
export function manifestFingerprint(orderedIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update(orderedIds.join("\n"))
    .digest("hex");
  return `${orderedIds.length}:${digest.slice(0, 16)}`;
}

/** The reserved warmup entries of an ordered manifest: replayed, never scored. */
export function reservedWarmups<T>(ordered: readonly T[]): T[] {
  return ordered.slice(0, WARMUP_RESERVATION);
}

/** The consumable entries of an ordered manifest, i.e. everything a cursor indexes. */
export function consumableEntries<T>(ordered: readonly T[]): T[] {
  return ordered.slice(WARMUP_RESERVATION);
}

/** How many consumable entries a dataset of this size has. Never negative. */
export function consumableCount(orderedLength: number): number {
  return Math.max(0, orderedLength - WARMUP_RESERVATION);
}

/**
 * What the operator asked for.
 *
 * `delta` is `--samples N`: N more clips than have already been measured. `target` is
 * `--to N`: whatever it takes to reach depth N, which is a no-op once the cursor is there.
 * The second exists because the first is destructive by default - re-running an
 * interrupted `--samples 400` would consume another 400 clips, where re-running `--to 400`
 * finishes the job.
 */
export type SampleDemand =
  { mode: "delta"; count: number } | { mode: "target"; depth: number };

export interface RangePlan {
  mode: SampleDemand["mode"];
  /**
   * Consumable entries this Combination had already been measured on when the plan was
   * made. Equal to `startIndex` unless `--from` overrode it.
   */
  cursor: number;
  /**
   * The `--from N` override, or `null` when the cursor picked the start.
   *
   * Carried so the preview can say a start index was *imposed* rather than derived.
   * Every other flag can only push the range forward; this is the only one that can
   * point it at clips already paid for, and a reader of the preview has to be able to
   * see which of the two happened.
   */
  fromIndex: number | null;
  /** First consumable entry this plan measures. */
  startIndex: number;
  /** One past the last consumable entry this plan measures. */
  endIndex: number;
  /** Clips this plan actually runs. `endIndex - startIndex`. */
  count: number;
  /** Clips the demand asked for, before the pool ran out. */
  requested: number;
  /**
   * The half-open end the demand named, before clamping to the pool or to `startIndex`.
   *
   * Reported rather than the clamped `endIndex` wherever the preview explains why a plan
   * selected nothing: `--from 500 --to 200` clamps to 500, and a message naming 500 as
   * the depth asked for would be the one line of the preview that lied.
   */
  requestedEndIndex: number;
  /** Consumable entries in the dataset. */
  consumableTotal: number;
  /** Consumable entries left unmeasured after this plan. */
  remainingAfter: number;
  /** True when the pool ran out before the demand was met. */
  truncated: boolean;
  /**
   * True when `--from` starts inside the measured prefix, so this plan re-measures
   * clips this Combination has already been measured on. The only deliberately
   * destructive path in the harness, and why `formatPlanLine` has a branch for it.
   */
  rewind: boolean;
  /**
   * True when `--from` starts *past* the cursor, leaving `[cursor, startIndex)`
   * unmeasured while the depth this run records jumps over it. Not a rewind, but the
   * mirror-image hazard: a claimed depth over clips nobody transcribed.
   */
  gap: boolean;
  /**
   * The cursor this plan leaves behind, `max(cursor, endIndex)`.
   *
   * The cursor is the deepest recorded `endIndex` per Combination (see
   * `foldRecordedRanges`), so a rewind can only raise it or leave it alone. Computed
   * here so the preview can promise that on the line that announces the rewind.
   */
  cursorAfter: number;
}

/**
 * Turn a cursor, a demand and an optional explicit start into the range to run.
 *
 * Never throws and never wraps around. A dataset with fewer clips left than asked for
 * yields a short plan - the caller runs it, records the true depth and moves on to the
 * next dataset - because throwing there is what the old `entries.slice` did indirectly by
 * silently measuring a shorter sample than the flag claimed.
 *
 * `fromIndex` is `--from N`: the start this plan uses *instead of* the cursor, for this
 * run only. Nothing is written back and no cursor is edited - the override exists so the
 * same clips can be measured twice, which is the only way to tell a real change apart
 * from a change of sample.
 */
export function planRange(
  cursor: number,
  consumableTotal: number,
  demand: SampleDemand,
  fromIndex?: number,
): RangePlan {
  // Clamped defensively. A cursor past the end of the pool means the pool shrank, which
  // changes the fingerprint and is refused before this is reached. A `--from` past the end
  // is refused by `fromIndexError` before this is reached, for the opposite reason: it is
  // typed by a human rather than derived from a recorded range.
  const startIndex = Math.max(
    0,
    Math.min(fromIndex ?? cursor, consumableTotal),
  );
  const wanted =
    demand.mode === "delta" ? startIndex + demand.count : demand.depth;
  const endIndex = Math.max(startIndex, Math.min(wanted, consumableTotal));
  const requested = Math.max(0, wanted - startIndex);
  const count = endIndex - startIndex;

  return {
    mode: demand.mode,
    cursor,
    fromIndex: fromIndex ?? null,
    startIndex,
    endIndex,
    count,
    requested,
    requestedEndIndex: wanted,
    consumableTotal,
    remainingAfter: consumableTotal - endIndex,
    truncated: count < requested,
    rewind: fromIndex !== undefined && startIndex < cursor,
    gap: fromIndex !== undefined && startIndex > cursor,
    cursorAfter: Math.max(cursor, endIndex),
  };
}

/**
 * Rejects a `--from N` no selected dataset can honour, naming the dataset and its
 * consumable count.
 *
 * Checked rather than clamped. Every other offset here is derived from a recorded range
 * and is inside the pool by construction; `--from` is typed by a human, so `--from 5000`
 * on a 902-clip pool would otherwise measure nothing and record a depth of 902. Returns
 * the message rather than printing it, so the bound is unit-testable without a run tree.
 */
export function fromIndexError(
  fromIndex: number,
  consumableTotals: ReadonlyMap<string, number>,
): string | null {
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    return `Error: --from must be a non-negative integer index into the consumable range, got ${fromIndex}.`;
  }
  for (const [datasetKey, consumableTotal] of consumableTotals) {
    if (consumableTotal === 0) {
      return (
        `Error: --from ${fromIndex} is out of range for ${datasetKey}: it has 0 consumable clips, ` +
        `so there is nothing for --from to point at.`
      );
    }
    if (fromIndex >= consumableTotal) {
      return (
        `Error: --from ${fromIndex} is out of range for ${datasetKey}: it has ${consumableTotal} ` +
        `consumable clips, so the valid --from indices are 0-${consumableTotal - 1}.`
      );
    }
  }
  return null;
}

/** The `SampleRange` a plan records on the leaf it produces. */
export function rangeOf(plan: RangePlan, fingerprint: string): SampleRange {
  return {
    startIndex: plan.startIndex,
    endIndex: plan.endIndex,
    manifestFingerprint: fingerprint,
  };
}

/**
 * The refusal for a `--from` given while an unfinished run is on disk, or `null` when
 * there is nothing to refuse.
 *
 * A resume is implicit in this harness - the next invocation picks up an unfinished run
 * directory - so the two intents can collide without the operator naming both. They are
 * incoherent together: a resume replays the range its checkpoint recorded and carries the
 * clips it already transcribed from that range, while `--from` names a different start, so
 * honouring both would file a partial numerator against clips it never saw.
 *
 * Refused for `--plan-only` too. With a checkpoint on disk the preview would describe a
 * range the real run would then override, and a preview that does not predict the run is
 * worse than no preview.
 */
export function fromResumeRefusal(
  fromIndex: number | null,
  incompleteRunDir: string | null,
): string[] | null {
  if (fromIndex === null || incompleteRunDir === null) return null;
  return [
    `Error: --from cannot be combined with a resume. ${incompleteRunDir} holds an unfinished run, and this invocation would resume it.`,
    "  That run recorded the range it was measuring, and the partial results it carries belong to that range. Finish it, or delete that directory - nothing in it was ever written to stt.json - then start a fresh run with --from.",
  ];
}

/**
 * One line of the plan preview, printed for every (Speech Model, dataset) before any clip
 * runs.
 *
 * Printed unconditionally, including for the datasets with nothing to do. `--samples` is a
 * delta, so a run that silently consumed a different range than the operator pictured
 * would only be discoverable after the fact, from the cursor it left behind.
 *
 * Clip numbers are 1-based and inclusive, because they are being read by a person; the
 * cursor values on the same line are the offsets that get stored.
 *
 * A `--from` rewind gets its own shape rather than the same shape with different numbers.
 * It is the one path that spends clips already paid for, so it says so in words: the arrow
 * runs backwards, the flag is named beside the cursor it overrode, and the number of clips
 * about to be measured a second time is spelled out. A reader skimming for the usual
 * `cursor A -> B` cannot mistake it for a forward run.
 */
export function formatPlanLine(
  modelId: string,
  datasetKey: string,
  plan: RangePlan,
): string {
  const prefix = `[${modelId}] ${datasetKey}`;
  const head = `${prefix}: cursor ${plan.cursor} -> ${plan.endIndex}`;

  if (plan.count === 0) {
    if (plan.fromIndex !== null) {
      return `${prefix}: nothing to run: --from ${plan.fromIndex} with depth ${plan.requestedEndIndex} selects no clips (cursor stays ${plan.cursor})`;
    }
    if (plan.remainingAfter === 0) {
      return `${head} (nothing left: all ${plan.consumableTotal} consumable clips measured)`;
    }
    return `${head} (nothing to do: depth ${plan.endIndex} already measured, ${plan.remainingAfter} consumable clips remain)`;
  }

  const clips = `clips ${plan.startIndex + 1}-${plan.endIndex} of ${plan.consumableTotal} consumable`;
  const short = plan.truncated
    ? `, ${plan.count} of ${plan.requested} requested - dataset exhausted`
    : "";

  if (plan.rewind) {
    const again = Math.min(plan.endIndex, plan.cursor) - plan.startIndex;
    return (
      `${prefix}: REWIND cursor ${plan.cursor} -> --from ${plan.fromIndex}` +
      ` (re-measuring ${clips}${short}, ${again} of them already measured;` +
      ` cursor ends at ${plan.cursorAfter}, never lower than ${plan.cursor})`
    );
  }

  if (plan.gap) {
    return (
      `${prefix}: GAP --from ${plan.fromIndex} starts past cursor ${plan.cursor}` +
      ` (${clips}${short}, leaving clips ${plan.cursor + 1}-${plan.startIndex} unmeasured;` +
      ` cursor ends at ${plan.cursorAfter})`
    );
  }

  return `${head} (${clips}${short}, ${plan.remainingAfter} remaining after)`;
}

// -- The cursor index, derived from the results tree --

/**
 * Deepest `endIndex` recorded per Benchmark Combination per ordering, plus enough
 * provenance to explain a fingerprint conflict by run name.
 *
 * Keyed by fingerprint rather than collapsed to one number, because a range recorded
 * against a different ordering is not a shallower measurement of the same thing - it is a
 * measurement of a different set of clips, and the only safe thing to do with it is refuse
 * to run. Collapsing it here would hide exactly that.
 */
export interface CursorIndex {
  /** harness -> modelId -> datasetKey -> manifestFingerprint -> deepest endIndex. */
  byCombination: Record<
    string,
    Record<string, Record<string, Record<string, number>>>
  >;
  /** datasetKey -> manifestFingerprint -> run names that recorded a range under it. */
  fingerprints: Record<string, Record<string, string[]>>;
  /** Leaves whose recorded range contradicts their own `utteranceCount`, by name. */
  inconsistencies: string[];
}

export function emptyCursorIndex(): CursorIndex {
  return { byCombination: {}, fingerprints: {}, inconsistencies: [] };
}

/** One leaf's worth of range provenance, as extracted from a run directory. */
export interface RecordedRange {
  runName: string;
  harness: string;
  modelId: string;
  datasetKey: string;
  /** The leaf's own scored count, cross-checked against the range width. */
  utteranceCount: number;
  range: SampleRange;
}

/**
 * Fold recorded ranges into a cursor index.
 *
 * Pure, and the only place the cursor is computed: the disk scan in `coverage.ts` hands
 * this the leaves it found, and the tests hand it fixtures.
 *
 * A leaf with no `sampleRange` contributes nothing, deliberately. Its `utteranceCount` is
 * *not* read as a depth - that inference is exactly what the LibriSpeech ordering change
 * invalidates for the three pre-d8b91ee runs, and a leaf the migration refused to backfill
 * has to read as "position unknown" rather than as position zero-to-N.
 */
export function foldRecordedRanges(
  ranges: readonly RecordedRange[],
  into: CursorIndex = emptyCursorIndex(),
): CursorIndex {
  for (const recorded of ranges) {
    const { range, runName, datasetKey } = recorded;

    const byFingerprint = ((into.fingerprints[datasetKey] ??= {})[
      range.manifestFingerprint
    ] ??= []);
    if (!byFingerprint.includes(runName)) byFingerprint.push(runName);

    if (recorded.utteranceCount !== range.endIndex - range.startIndex) {
      into.inconsistencies.push(
        `${runName} ${datasetKey}/${recorded.harness}/${recorded.modelId}: sampleRange spans ${range.endIndex - range.startIndex} clips but utteranceCount is ${recorded.utteranceCount}`,
      );
    }

    // A sentinel leaf (model absent from disk when the run happened) measured nothing and
    // must not advance anything, but its fingerprint is still real provenance above.
    if (recorded.utteranceCount <= 0) continue;

    const perOrdering = (((into.byCombination[recorded.harness] ??= {})[
      recorded.modelId
    ] ??= {})[datasetKey] ??= {});
    perOrdering[range.manifestFingerprint] = Math.max(
      perOrdering[range.manifestFingerprint] ?? 0,
      range.endIndex,
    );
  }
  return into;
}

/**
 * Consumable entries this Combination has already been measured on, under the ordering the
 * manifest currently yields.
 *
 * Zero when nothing matches, which is the honest answer for a Combination whose only
 * recorded ranges belong to a different ordering - and that case never reaches here,
 * because `manifestFingerprintConflicts` refuses the run first.
 */
export function cursorFor(
  index: CursorIndex,
  harness: string,
  modelId: string,
  datasetKey: string,
  fingerprint: string,
): number {
  return (
    index.byCombination[harness]?.[modelId]?.[datasetKey]?.[fingerprint] ?? 0
  );
}

/** The deepest cursor this Combination has under any ordering, for coverage badges. */
export function deepestCursorForDataset(
  index: CursorIndex,
  harness: string,
  modelId: string,
  datasetKey: string,
): number {
  const perOrdering = index.byCombination[harness]?.[modelId]?.[datasetKey];
  if (!perOrdering) return 0;
  return Math.max(0, ...Object.values(perOrdering));
}

export interface FingerprintConflict {
  datasetKey: string;
  /** The fingerprint stored in the archive. */
  recorded: string;
  /** What the manifest on disk fingerprints to now. */
  current: string;
  /** Runs that recorded a range under the stored fingerprint. */
  runs: string[];
}

/**
 * Recorded orderings for these datasets that are not the ordering on disk right now.
 *
 * Non-empty means every stored offset for that dataset points into a list that no longer
 * exists, so the caller must refuse to run. This is the most dangerous failure mode in the
 * design: continuing would either re-measure clips already paid for or, worse, skip clips
 * nobody ever measured while claiming a depth.
 *
 * Only the datasets a run actually selected are checked. A stale ordering for `test-other`
 * is not a reason to block a FLEURS-only run.
 */
export function manifestFingerprintConflicts(
  index: CursorIndex,
  currentFingerprints: Readonly<Record<string, string>>,
): FingerprintConflict[] {
  const conflicts: FingerprintConflict[] = [];
  for (const [datasetKey, current] of Object.entries(currentFingerprints)) {
    for (const [recorded, runs] of Object.entries(
      index.fingerprints[datasetKey] ?? {},
    )) {
      if (recorded === current) continue;
      conflicts.push({ datasetKey, recorded, current, runs: [...runs] });
    }
  }
  return conflicts;
}

/** The refusal message for a fingerprint conflict, as printed by `run-stt.ts`. */
export function formatFingerprintConflict(
  conflict: FingerprintConflict,
): string[] {
  return [
    `Error: the ordered clip list for "${conflict.datasetKey}" has changed since it was last measured.`,
    `  recorded ordering: ${conflict.recorded}  (${conflict.runs.join(", ")})`,
    `  ordering on disk:  ${conflict.current}`,
    "  Every stored sample offset for this dataset indexes into the recorded ordering, so",
    "  none of them mean anything against the list on disk. Refusing to run rather than",
    "  restarting the cursor from zero, which would silently re-measure or skip clips.",
    "  Fix the dataset so the ordering matches, or archive those runs and re-derive the",
    "  cursors deliberately.",
  ];
}
