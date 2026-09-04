/**
 * Selection, resume and continuation: which clips a Benchmark Run measures, and what
 * happens when it is interrupted.
 *
 * v1 resumed *implicitly* - the next invocation picked up whatever unfinished run
 * directory it found, and `--from` had to be refused because the two intents collide
 * without the operator naming both (`benchmarks/stt/sample-cursor.ts::fromResumeRefusal`).
 * v2 replaces the guesswork with an object: a **Run Plan** is written before the first
 * clip, is immutable, and a resume names its run id explicitly. Nothing here searches
 * for the latest unfinished run, because the failure mode of that search is silent -
 * it resumes the wrong run and files a partial numerator against clips it never saw.
 *
 * Indices are into the dataset's ordered **consumable** list, the same space
 * `SampleRange` uses: index 0 is the first clip after the Warmup Reservation. Warmups
 * are carried on the plan as their own list, replayed by every session, and never
 * scored.
 *
 * Pure. No filesystem: the caller reads the plan and the records and hands them in.
 */

import { assertUniqueClipIds, uniqueInOrder } from "./clip-identity";
import {
  FINGERPRINT_VERSION,
  fingerprintV2Matches,
  fingerprintV2Record,
  isFingerprintV2,
  isScoredSample,
  type FingerprintV2,
  type RunPlanRefV2,
  type SampleMeasurementV2,
} from "./schema";

/**
 * What a Benchmark Run will measure, fixed before it measures anything.
 *
 * Immutable in the type *and* at runtime (`Object.freeze` on the object and both clip
 * lists), because the whole resume story rests on the plan not moving: a resumed
 * process re-derives nothing, it re-reads this. A mutable plan is how `--samples 400`
 * became "another 400 clips" on the second invocation.
 */
export interface RunPlan {
  readonly runId: string;
  readonly batchId?: string;
  /** `fleurs/da_dk`, `librispeech/test-clean`, ... */
  readonly datasetId: string;
  /** Which measuring harness will run it: `codictate`, `wispr-flow`, ... */
  readonly harness: string;
  /** The Speech Model or the product under test. */
  readonly model: string;
  /** First selected consumable index, inclusive. */
  readonly fromIndex: number;
  /** One past the last selected consumable index. */
  readonly toIndex: number;
  /** The scored clips, in the order they will be measured. Duplicate-free. */
  readonly orderedClipIds: readonly string[];
  /**
   * The reserved warmup clips, replayed at the start of every session of this run.
   *
   * On the plan rather than derived, so a resumed process replays the clips the
   * original run warmed on even if the Warmup Reservation constant changes underneath
   * it. Disjoint from `orderedClipIds` by construction - a clip cannot be both warmed
   * and scored, or the model would be measured on a clip it had just seen.
   */
  readonly warmupClipIds: readonly string[];
  readonly fingerprintV2: FingerprintV2;
  /** ISO 8601, supplied by the caller. This module never reads a clock. */
  readonly createdAt: string;
}

export interface BuildRunPlanInput {
  runId: string;
  batchId?: string;
  datasetId: string;
  harness: string;
  model: string;
  /** The dataset's whole ordered consumable list, warmups already removed. */
  consumableClipIds: readonly string[];
  fromIndex: number;
  toIndex: number;
  /** The Warmup Reservation for this dataset, in order. Defaults to none. */
  warmupClipIds?: readonly string[];
  /** ISO 8601. Injected, so a plan is reproducible in a test. */
  createdAt: string;
}

/**
 * Build the immutable plan for one (harness, model, dataset) slice.
 *
 * Every argument is checked rather than clamped, which is the opposite of
 * `planRange` in `benchmarks/stt/sample-cursor.ts` and deliberately so. `planRange`
 * turns an operator's *demand* into a range and has to be forgiving - a dataset with
 * fewer clips left than asked for yields a short plan. By the time this is called the
 * range is decided, so a `toIndex` past the end of the pool is not a short plan, it is
 * a caller that sliced against a different list, and clamping it would produce a plan
 * whose fingerprint covers clips nobody selected.
 *
 * A **zero-clip** plan is legal here and illegal on disk, which is a real asymmetry and a
 * chosen one. In memory it is the honest value for "this stage has nothing left to run" -
 * `planRange` produces exactly that once a cursor has reached the end of a pool - and
 * throwing would force every caller to branch before it could describe the situation. On
 * disk it is indistinguishable from a truncated file and there is nothing in it to resume,
 * so `assertRunPlanOnDisk` refuses it. The rule is: a stage with nothing to measure does
 * not get a plan file written for it.
 */
export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  const { consumableClipIds, fromIndex, toIndex } = input;

  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    throw new Error(
      `fromIndex must be a non-negative integer, got ${fromIndex}.`,
    );
  }
  if (!Number.isInteger(toIndex) || toIndex < fromIndex) {
    throw new Error(
      `toIndex must be an integer at or after fromIndex ${fromIndex}, got ${toIndex}.`,
    );
  }
  if (toIndex > consumableClipIds.length) {
    throw new Error(
      `toIndex ${toIndex} is past the end of ${input.datasetId}, which has ` +
        `${consumableClipIds.length} consumable clips. Refusing rather than clamping: a ` +
        `clamped plan fingerprints a selection nobody asked for.`,
    );
  }

  const orderedClipIds = consumableClipIds.slice(fromIndex, toIndex);
  assertUniqueClipIds(
    orderedClipIds,
    `Run Plan ${input.runId} (${input.datasetId})`,
  );

  const warmupClipIds = input.warmupClipIds ?? [];
  assertUniqueClipIds(warmupClipIds, `warmups of Run Plan ${input.runId}`);
  const scored = new Set(orderedClipIds);
  for (const warmup of warmupClipIds) {
    if (scored.has(warmup)) {
      throw new Error(
        `Run Plan ${input.runId} both warms and scores "${warmup}". A warmup is replayed ` +
          `every session, so scoring it would measure the model on a clip it just saw.`,
      );
    }
  }

  return Object.freeze({
    runId: input.runId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    datasetId: input.datasetId,
    harness: input.harness,
    model: input.model,
    fromIndex,
    toIndex,
    orderedClipIds: Object.freeze(orderedClipIds) as readonly string[],
    warmupClipIds: Object.freeze([...warmupClipIds]) as readonly string[],
    fingerprintV2: Object.freeze(fingerprintV2Record(orderedClipIds)),
    createdAt: input.createdAt,
  });
}

// -- Reading a plan back off disk --

/**
 * Everything that must be true of a Run Plan read off disk, as a list of complaints.
 *
 * Empty means the value is a valid `RunPlan`. Returned as strings rather than thrown so
 * one implementation can back both a predicate and an assertion, and so a caller that
 * finds several problems can report all of them - a hand-edited plan usually has more
 * than one.
 *
 * **The on-disk plan is immutable.** It is written once, before the first clip, and a
 * resume re-reads it rather than re-deriving anything. So a complaint here never means
 * "repair it": it means the file was edited, or truncated mid-write, or the corpus moved
 * underneath it. Any of the three makes the recorded Samples unattributable, because the
 * clip list they were measured against is not the clip list on disk. Refusing is the only
 * safe answer - the same reasoning `manifestFingerprintConflicts` uses in
 * `benchmarks/stt/sample-cursor.ts` for a changed ordering.
 *
 * Stricter than a structural type check on purpose, and stricter than the field-types-only
 * validator this replaces. Every semantic check below is a way for a plan to be
 * well-typed and still wrong:
 *
 * - **An empty `orderedClipIds`** is far likelier to be a truncated file than a stage
 *   that deliberately measures nothing, and a plan naming no clips cannot be resumed.
 * - **A fingerprint that does not match the clip list** is the load-bearing one. The
 *   fingerprint is what makes "did these two runs measure the same clips in the same
 *   order" a string comparison, so a plan whose fingerprint no longer describes its own
 *   list would let a pooled read agree with a run it never matched.
 * - **A v1-shaped or unversioned fingerprint** must not be silently accepted: a
 *   `<count>:<hex>` `manifestFingerprint` answers a different question and is never
 *   compared to a v2 value.
 * - **`toIndex - fromIndex` disagreeing with the list length** means the indices point
 *   somewhere the clips do not, so every cursor derived from them is wrong.
 * - **Duplicate clipIds** mean the adapter would be invoked twice on one clip and the run
 *   would claim a depth it does not have.
 */
export function runPlanComplaints(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["it is not an object"];
  }
  const candidate = value as Partial<RunPlan>;
  const complaints: string[] = [];

  for (const field of [
    "runId",
    "datasetId",
    "harness",
    "model",
    "createdAt",
  ] as const) {
    const actual = candidate[field];
    if (typeof actual !== "string" || actual.length === 0) {
      complaints.push(
        `${field} must be a non-empty string, got ${describe(actual)}`,
      );
    }
  }
  if (
    candidate.batchId !== undefined &&
    typeof candidate.batchId !== "string"
  ) {
    complaints.push(
      `batchId must be a string when present, got ${describe(candidate.batchId)}`,
    );
  }

  const clipIds = candidate.orderedClipIds;
  const clipsUsable = isStringArray(clipIds);
  if (!clipsUsable) {
    complaints.push(
      `orderedClipIds must be an array of strings, got ${describe(clipIds)}`,
    );
  } else if (clipIds.length === 0) {
    // A stage that measures nothing has no plan to resume, and a zero-length list is
    // what a half-written file looks like.
    complaints.push("orderedClipIds is empty, so there is nothing to resume");
  } else {
    try {
      assertUniqueClipIds(clipIds, "orderedClipIds");
    } catch (error) {
      complaints.push(error instanceof Error ? error.message : String(error));
    }
  }

  const warmups = candidate.warmupClipIds;
  if (!isStringArray(warmups)) {
    complaints.push(
      `warmupClipIds must be an array of strings, got ${describe(warmups)}`,
    );
  } else if (clipsUsable) {
    const scored = new Set(clipIds);
    const both = warmups.find((warmup) => scored.has(warmup));
    if (both !== undefined) {
      complaints.push(`"${both}" is both warmed and scored`);
    }
  }

  const { fromIndex, toIndex } = candidate;
  if (!Number.isInteger(fromIndex) || (fromIndex as number) < 0) {
    complaints.push(
      `fromIndex must be a non-negative integer, got ${describe(fromIndex)}`,
    );
  }
  if (!Number.isInteger(toIndex) || (toIndex as number) < 0) {
    complaints.push(
      `toIndex must be a non-negative integer, got ${describe(toIndex)}`,
    );
  }
  if (
    Number.isInteger(fromIndex) &&
    Number.isInteger(toIndex) &&
    clipsUsable &&
    (toIndex as number) - (fromIndex as number) !== clipIds.length
  ) {
    complaints.push(
      `[${fromIndex}, ${toIndex}) spans ${(toIndex as number) - (fromIndex as number)} clips ` +
        `but orderedClipIds has ${clipIds.length}`,
    );
  }

  if (!isFingerprintV2(candidate.fingerprintV2)) {
    complaints.push(
      `fingerprintV2 must be { version: "${FINGERPRINT_VERSION}", value: <16 lowercase hex> }, ` +
        `got ${describe(candidate.fingerprintV2)}`,
    );
  } else if (
    clipsUsable &&
    !fingerprintV2Matches(candidate.fingerprintV2, clipIds)
  ) {
    complaints.push(
      `fingerprintV2 ${candidate.fingerprintV2.value} does not match its own orderedClipIds`,
    );
  }

  return complaints;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** A short, safe rendering of a bad value for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * Whether a value read off disk is a valid Run Plan.
 *
 * The canonical check for both repositories. Two hand-rolled validators drift, and a
 * validator that checks field types but not the fingerprint passes exactly the plan a
 * resume must refuse.
 */
export function isRunPlan(value: unknown): value is RunPlan {
  return runPlanComplaints(value).length === 0;
}

/**
 * Refuses a malformed Run Plan, naming everything wrong with it.
 *
 * Use this on the resume path, where a plan is being trusted completely: the process is
 * about to skip every clip the plan says is done and measure the rest. `isRunPlan` is for
 * a scan that has to keep going past a bad file.
 *
 * `runId` is the run the operator explicitly asked to resume. When given, it must match
 * the plan's own `runId` - a resume names its run, so reading a plan that belongs to a
 * different one means the wrong file was opened, which is the failure "find the latest
 * unfinished run" used to produce silently.
 */
export function assertRunPlanOnDisk(
  value: unknown,
  runId?: string,
): asserts value is RunPlan {
  const complaints = runPlanComplaints(value);
  if (complaints.length > 0) {
    const subject = runId === undefined ? "Run Plan" : `Run Plan for ${runId}`;
    throw new Error(
      `${subject} is not usable: ${complaints.join("; ")}. ` +
        `A Run Plan is written once and never edited, so this means the file was changed, ` +
        `truncated, or built against a different corpus - not something to repair in place.`,
    );
  }
  const plan = value as RunPlan;
  if (runId !== undefined && plan.runId !== runId) {
    throw new Error(
      `Asked to resume ${runId} but this Run Plan belongs to ${plan.runId}. ` +
        `A resume names its run id; it never searches for a plan that looks close enough.`,
    );
  }
}

/** The plan reference a run record carries. See `schema.ts::RunPlanRefV2`. */
export function runPlanRef(plan: RunPlan): RunPlanRefV2 {
  return {
    runId: plan.runId,
    ...(plan.batchId === undefined ? {} : { batchId: plan.batchId }),
    datasetId: plan.datasetId,
    fromIndex: plan.fromIndex,
    toIndex: plan.toIndex,
    clipCount: plan.orderedClipIds.length,
    fingerprintV2: plan.fingerprintV2,
    createdAt: plan.createdAt,
  };
}

// -- Cursors --

/**
 * How far the **contiguous measured prefix** of an ordered clip list reaches.
 *
 * The production cursor, and the number that may be published as a depth. A gap does
 * **not** advance it: if clips 0-99 and 200-299 are measured, this is 100, because
 * "measured 300 clips deep" over a list where clips 100-199 were never transcribed is
 * a claim about clips nobody has heard. That claim is the most dangerous thing this
 * whole module exists to prevent - it is not visible in any published number, and the
 * missing clips are exactly the ones a crash tends to eat.
 *
 * Returned relative to the list passed in. For a plan that starts at `fromIndex`, the
 * cursor in consumable space is `plan.fromIndex + contiguousCursor(...)`.
 */
export function contiguousCursor(
  orderedClipIds: readonly string[],
  measuredClipIds: Iterable<string>,
): number {
  const measured =
    measuredClipIds instanceof Set
      ? (measuredClipIds as Set<string>)
      : new Set(measuredClipIds);
  let cursor = 0;
  while (
    cursor < orderedClipIds.length &&
    measured.has(orderedClipIds[cursor])
  ) {
    cursor++;
  }
  return cursor;
}

/**
 * One past the last measured clip, gaps included. **Not a cursor.**
 *
 * Kept separate and labelled non-contiguous because the two numbers disagreeing is
 * the useful signal: `cursor 100, maxMeasuredEnd 300` says a run died in the middle
 * and 100 clips are missing from the middle of the range. It is a diagnostic for the
 * coverage badge and the resume message, and it never feeds aggregation, staging or a
 * published depth.
 */
export function maxMeasuredEnd(
  orderedClipIds: readonly string[],
  measuredClipIds: Iterable<string>,
): number {
  const measured =
    measuredClipIds instanceof Set
      ? (measuredClipIds as Set<string>)
      : new Set(measuredClipIds);
  for (let index = orderedClipIds.length - 1; index >= 0; index--) {
    if (measured.has(orderedClipIds[index])) return index + 1;
  }
  return 0;
}

// -- Overlap --

/** The clips two plans have in common, in the first plan's order. */
export function overlappingClipIds(
  planA: Pick<RunPlan, "orderedClipIds">,
  planB: Pick<RunPlan, "orderedClipIds">,
): string[] {
  const inB = new Set(planB.orderedClipIds);
  return uniqueInOrder(
    planA.orderedClipIds.filter((clipId) => inB.has(clipId)),
  );
}

/**
 * Whether two plans share any scored clip.
 *
 * On clipId sets, not on index ranges. Ranges are only comparable against one ordering
 * of one dataset, and two plans built from different manifests - or from two datasets
 * whose pools happen to be the same length - can share an index range and no clips, or
 * share clips at different indices after a re-shuffle. The clip set is the fact.
 *
 * Warmups are ignored: every session replays them and every run shares them, so
 * counting them as overlap would make every pair of plans overlap.
 */
export function overlaps(
  planA: Pick<RunPlan, "orderedClipIds">,
  planB: Pick<RunPlan, "orderedClipIds">,
): boolean {
  const inB = new Set(planB.orderedClipIds);
  return planA.orderedClipIds.some((clipId) => inB.has(clipId));
}

/** The minimum an overlap check needs to know about an unfinished run. */
export interface IncompleteRunRef {
  runId: string;
  orderedClipIds: readonly string[];
}

/**
 * Refuses a new run that overlaps an unfinished one, naming the run id to resume or
 * discard.
 *
 * Blocked rather than merged. Two processes measuring the same clip write two
 * measurements of it, and the newest-wins rule in `aggregation.ts` would then decide
 * which one counts by timestamp - a coin flip dressed as a policy. The operator has
 * the information to choose and this message hands them the run id to choose with.
 */
export function assertNoOverlappingIncompleteRun(
  plan: Pick<RunPlan, "orderedClipIds">,
  incompleteRuns: readonly IncompleteRunRef[],
): void {
  for (const incomplete of incompleteRuns) {
    const shared = overlappingClipIds(plan, incomplete);
    if (shared.length === 0) continue;
    throw new Error(
      `Run ${incomplete.runId} is incomplete and shares ${shared.length} clip(s) with this ` +
        `selection, starting with "${shared[0]}". Resume it with its run id, or discard it. ` +
        `Starting a second run over the same clips would record two measurements of each and ` +
        `leave the tie to a timestamp.`,
    );
  }
}

// -- Resume --

/**
 * Flags a resume refuses, because each of them would change *which clips* the run
 * measures.
 *
 * A resume re-reads a plan; these flags build one. Accepting any of them would mean
 * the record's plan reference described a selection the process did not run, so the
 * fingerprint would be a lie about the clips behind the numbers - and it would be a
 * lie that reads as agreement, because the fingerprint is copied from the plan.
 *
 * Both repositories' spellings are here, so one list refuses a command written for
 * either harness: `--datasets` is `dictation-product-benchmark`'s dataset selector,
 * `--languages` and `--splits` are Codictate's, and `--clips-per-dataset` is the
 * orchestrator's.
 *
 * `--batch` is deliberately **not** on this list. It names the batch whose stages are
 * being resumed rather than the clips a stage measures, and the orchestrator passes it
 * on every invocation including the resuming ones. `--out` is absent for the same
 * reason: it moves where a report is written, not what was measured.
 */
export const RESUME_FORBIDDEN_FLAGS = [
  "--from",
  "--to",
  "--samples",
  "--limit",
  "--clips-per-dataset",
  "--dataset",
  "--datasets",
  "--languages",
  "--splits",
  "--model",
  "--models",
  "--seed",
  "--smoke",
] as const;

export type ResumeForbiddenFlag = (typeof RESUME_FORBIDDEN_FLAGS)[number];

/** The flag name in `--flag=value`, `--flag value` or a bare `--flag`. */
function flagName(token: string): string {
  const equals = token.indexOf("=");
  return equals === -1 ? token : token.slice(0, equals);
}

/**
 * Refuses a resume that was given a selection-changing flag, naming the flag.
 *
 * Takes the argv tokens rather than a parsed options object on purpose: a parser fills
 * in defaults, and "the operator passed `--samples 200`" is indistinguishable from
 * "`--samples` defaulted to 200" once it has. The check has to run on what was typed.
 */
export function assertResumeFlags(
  argv: readonly string[],
  runId?: string,
): void {
  const forbidden = new Set<string>(RESUME_FORBIDDEN_FLAGS);
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const flag = flagName(token);
    if (!forbidden.has(flag)) continue;
    throw new Error(
      `${flag} cannot be combined with a resume${runId ? ` of ${runId}` : ""}. ` +
        `A resume re-reads the Run Plan that run was started with, and ${flag} would select ` +
        `different clips than the plan - and than the fingerprint recorded beside them. ` +
        `Finish or discard that run, then start a new one with ${flag}.`,
    );
  }
}

/**
 * What a resumed process should do, given its plan and the Samples already on disk.
 *
 * Three lists rather than one, because the three have different rules and conflating
 * them was the v1 bug this replaces:
 *
 * - `warmupsToReplay` is **always** the plan's whole warmup list, whatever the records
 *   say. A resumed process starts against a cold model, so the warmups are the point.
 *   Completed-ID filtering that treated them like scored clips would remove them and
 *   quietly turn every resumed session's first real clip into the warmup.
 * - `scoredToSkip` is every scored clip with a terminal Sample already recorded -
 *   `ok`, `timeout` **and** `failed`. A recorded failure is a measurement: it is
 *   counted in `failureCount`, and re-running it would either double-count it or
 *   overwrite a real observation with a luckier one. Re-measuring on purpose is a new
 *   run with an explicit start index, never a resume.
 * - `remaining` is the rest, in plan order, which is the order it must run in for
 *   `contiguousCursor` to advance.
 */
export interface ResumeSelection {
  warmupsToReplay: readonly string[];
  scoredToSkip: readonly string[];
  remaining: readonly string[];
}

export function resumeSelection(
  plan: RunPlan,
  samples: readonly SampleMeasurementV2[],
): ResumeSelection {
  const planned = new Set(plan.orderedClipIds);
  const measured = new Set<string>();
  for (const sample of samples) {
    if (!isScoredSample(sample)) continue;
    if (!planned.has(sample.clipId)) continue;
    measured.add(sample.clipId);
  }

  const scoredToSkip = plan.orderedClipIds.filter((clipId) =>
    measured.has(clipId),
  );
  const remaining = plan.orderedClipIds.filter(
    (clipId) => !measured.has(clipId),
  );

  return {
    warmupsToReplay: plan.warmupClipIds,
    scoredToSkip,
    remaining,
  };
}
