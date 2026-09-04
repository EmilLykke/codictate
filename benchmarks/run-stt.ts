import { isAbsolute, join } from "node:path";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { downloadLibriSpeech } from "./scripts/download-librispeech";
import {
  downloadFleurs,
  DEFAULT_FLEURS_LANGUAGES,
} from "./scripts/download-fleurs";
import { convertLibriSpeech } from "./scripts/convert-audio";
import {
  buildAllManifests,
  hydrateDurations,
  type ManifestEntry,
} from "./scripts/build-manifests";
import {
  benchmarkModel,
  leafFromSamples,
  partialFromSamples,
  type PartialProgress,
} from "./stt/runner";
import {
  generateMarkdownReport,
  writeReport,
  type BenchmarkResults,
} from "./stt/report";
import {
  getCombinationResult,
  harnessBucketForModel,
  isBenchmarkHarnessLabel,
  normalizeDatasetResults,
  pooledV2Leaves,
  setCombinationResult,
  CODICTATE_V2_HARNESS,
  V2_RECORDS_DIRNAME,
  type BenchmarkHarnessLabel,
  type DatasetResults,
} from "./stt/results-schema";
import { LIBRISPEECH_SPLITS, isLibriSpeechSplit } from "./stt/datasets";
import {
  completedV2Records,
  incompleteV2Stages,
  loadCoverage,
  loadV2Stages,
  reconciledContinuationCursor,
  unresumableV2Stages,
  v2DatasetCoverage,
  V2_PLAN_SUFFIX,
  V2_RECORD_SUFFIX,
} from "./stt/coverage";
import {
  consumableEntries,
  cursorFor,
  fromIndexError,
  formatFingerprintConflict,
  formatPlanLine,
  manifestFingerprint,
  manifestFingerprintConflicts,
  planRange,
  rangeOf,
  reservedWarmups,
  WARMUP_RESERVATION,
  type RangePlan,
  type SampleDemand,
  type SampleRange,
} from "./stt/sample-cursor";
import { promptBenchmarkPlan } from "./stt/tui";
import {
  DEFAULT_ASR_HARNESS,
  isAsrHarnessId,
  ASR_HARNESS_IDS,
  type AsrHarnessId,
} from "../src/shared/asr-harness";
import {
  PARAKEET_ENGINE_ID,
  SPEECH_MODEL_IDS,
  getSpeechModel,
} from "../src/shared/speech-models";
import { modelManager } from "../src/bun/utils/whisper/model-manager";
import {
  assertNoOverlappingIncompleteRun,
  assertResumeFlags,
  assertRunPlanOnDisk,
  buildRunPlan,
  runPlanRef,
  SCHEMA_VERSION,
  type RunPlan,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "./contract";

// -- Checkpoint types --

interface CheckpointData {
  /**
   * Archived labels, not runnable ids: a checkpoint is disk data, and one written by a
   * since-retired Harness has to keep parsing so the resume can refuse it by name
   * instead of reading as an empty set.
   */
  harnesses: BenchmarkHarnessLabel[];
  librispeech: DatasetResults;
  fleurs: DatasetResults;
  /**
   * The depth flag this Benchmark Run was given, so a resume can record it.
   *
   * On the checkpoint because a resume is forbidden from taking a depth flag - it would
   * change the selection - and `config.sampleSelection` in the final `stt.json` is a
   * statement about what was *asked for*, which only the original invocation knows.
   * Optional: a checkpoint written before this field existed simply reports no selection.
   */
  demand?: SampleDemand;
  /** The run's `--description`, recovered on resume, which cannot be given one. */
  description?: string;
  inProgress?: {
    /** Which Harness was mid-Combination, so a resume does not credit the wrong one. */
    harness: BenchmarkHarnessLabel;
    modelId: string;
    datasetKey: string;
    datasetType: "librispeech" | "fleurs";
    partial: PartialProgress;
    /**
     * The consumable range this Combination was measuring when it was interrupted.
     *
     * Optional on purpose. `dictation-product-benchmark` mirrors this object in
     * `src/codictate-compat.ts` and writes a Codictate-shaped `checkpoint.json` from it,
     * and `loadCheckpoint` casts `inProgress` straight through without validating it - so a
     * required field here would be a claim about disk data nobody checks, unsound at
     * runtime rather than caught by the compiler. A checkpoint without it resumes against
     * the range the plan computes, which is the same range unless the flags changed.
     */
    range?: SampleRange;
  };
}

const CHECKPOINT_FILE = "checkpoint.json";

/**
 * Write JSON so that a kill during the write cannot leave a half-file behind.
 *
 * Temp file in the **same directory**, fsync, then `rename` over the target. Each of
 * those three is load-bearing:
 *
 * - **Same directory**, because `rename` is only atomic within a filesystem. A temp file
 *   in `/tmp` would make this a copy, which is exactly the non-atomic write it replaces.
 * - **fsync before the rename**, so the bytes are on the device before anything points at
 *   them. Without it a crash can leave a renamed file full of zeroes - the metadata
 *   operation is durable and the data is not.
 * - **Synchronous**, because the caller is about to transcribe the next clip and, more to
 *   the point, because the previous implementation was `void saveCheckpoint(...)`: an
 *   un-awaited promise whose write could still be in flight when the process was killed.
 *
 * This is written after **every scored clip** (see `benchmarks/stt/runner.ts`), which is
 * the point of making it cheap and safe rather than rare. The 50-clip batch it replaces
 * gave a killed run up to 49 clips it had paid for and could not prove.
 */
export function atomicWriteJsonSync(path: string, value: unknown): void {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2));
  // Best effort: a filesystem that cannot fsync is not a reason to lose the write, and
  // the rename below is still ordered after the data write on every filesystem we run on.
  try {
    const handle = openSync(tempPath, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // Nothing to do: the rename still publishes whatever reached the device.
  }
  renameSync(tempPath, path);
}

function saveCheckpoint(runDir: string, data: CheckpointData): void {
  atomicWriteJsonSync(join(runDir, CHECKPOINT_FILE), data);
}

async function loadCheckpoint(runDir: string): Promise<CheckpointData | null> {
  const path = join(runDir, CHECKPOINT_FILE);
  if (!existsSync(path)) return null;
  const raw = (await Bun.file(path).json()) as Partial<CheckpointData>;
  return {
    harnesses: Array.isArray(raw.harnesses)
      ? raw.harnesses.filter(isBenchmarkHarnessLabel)
      : [DEFAULT_ASR_HARNESS],
    librispeech: normalizeDatasetResults(raw.librispeech),
    fleurs: normalizeDatasetResults(raw.fleurs),
    demand: raw.demand,
    description: raw.description,
    inProgress: raw.inProgress,
  };
}

function deleteCheckpoint(runDir: string): void {
  const path = join(runDir, CHECKPOINT_FILE);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * The run directory a `--resume <runId>` names, or a refusal saying why not.
 *
 * There is deliberately **no** "find the latest unfinished run" any more. That search was
 * the defect: it ran on every invocation, ignored the run identity the operator had asked
 * for, and its failure mode is silent - it resumes a different run than intended and files
 * a partial numerator against clips it never saw. A resume now names a run id, and an id
 * that does not resolve to exactly one unfinished directory is an error rather than a
 * fallback.
 *
 * The run id is the directory name (`2026-09-04_08-17-28_hu-session-1`), because that is
 * the string the operator can see, tab-complete, and paste. The `--name` slug alone is
 * not an identity: two runs can share a name, and the interrupted one is not necessarily
 * the newest.
 */
export function resolveResumeTarget(
  resultsBaseDir: string,
  runId: string,
): { status: "ok"; runDir: string } | { status: "error"; lines: string[] } {
  const runDir = join(resultsBaseDir, runId);
  if (!existsSync(runDir)) {
    const candidates = existsSync(resultsBaseDir)
      ? readdirSync(resultsBaseDir)
          .filter(
            (dir) =>
              /^\d{4}-\d{2}-\d{2}/.test(dir) &&
              !existsSync(join(resultsBaseDir, dir, "stt.json")),
          )
          .sort()
      : [];
    return {
      status: "error",
      lines: [
        `Error: --resume ${runId} names no run directory under ${resultsBaseDir}.`,
        candidates.length > 0
          ? `  Unfinished runs on disk: ${candidates.join(", ")}`
          : "  There are no unfinished runs on disk.",
        "  The run id is the directory name, not the --name slug. Pass the same --out this run was written with, if it had one.",
      ],
    };
  }
  if (existsSync(join(runDir, "stt.json"))) {
    return {
      status: "error",
      lines: [
        `Error: --resume ${runId} is already finished - it has an stt.json.`,
        "  A completed run is immutable. Start a new run to measure more clips, or --from to re-measure.",
      ],
    };
  }
  return { status: "ok", runDir };
}

/** Read a result file, migrating the pre-harness shape on the way in. */
function readResultsFile(jsonPath: string): BenchmarkResults {
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return {
    ...parsed,
    librispeech: normalizeDatasetResults(parsed.librispeech),
    fleurs: normalizeDatasetResults(parsed.fleurs),
  } as BenchmarkResults;
}

const DATASETS_DIR = join(import.meta.dir, "datasets");

/**
 * The production results tree: the one the cursor, coverage, `--aggregate` and the
 * website all read.
 */
export const PRODUCTION_RESULTS_DIR = join(import.meta.dir, "results");

/**
 * The results tree this invocation reads and writes, which `--out` can relocate.
 *
 * Mutable, and set once from the flags before anything touches the disk. It exists
 * because `RESULTS_BASE_DIR` was a module constant with no override, and that is what
 * made SPEC §8's smoke exclusion unenforceable on this side: five rehearsal clips per
 * dataset landed in `benchmarks/results/` as ordinary **completed** v2 records, fed
 * `pooledV2Leaves` and `poolSamples`, and advanced the very cursor the production batch
 * would then measure from. A rehearsal is not a measurement, and there was no way to say
 * so.
 *
 * `--out` relocates the **whole tree**, reads included: the run directory, the Run Plans,
 * the v2 records, the checkpoint, the report and the charts, *and* the cursor scan and
 * coverage this run consults. That is the rule that makes the isolation real rather than
 * partial - a run that wrote elsewhere but read the production cursor would still consume
 * production clips, which is exactly the harm. A smoke run therefore starts from cursor 0
 * inside its own tree and re-measures the same rehearsal clips every time, which is what
 * a rehearsal should do.
 */
let activeResultsDir = PRODUCTION_RESULTS_DIR;

function resultsDir(): string {
  return activeResultsDir;
}

/**
 * Validate and adopt an `--out` directory, or return the refusal.
 *
 * Absolute only. A relative path is refused rather than resolved, because the cwd of a
 * `bun run` is whatever the caller's shell happened to be in and the orchestrator invokes
 * this from its own working directory - so `--out results/smoke` would write to two
 * different places depending on who typed it, and the second one would be a production
 * tree nobody meant to touch.
 */
export function adoptResultsDir(out: string): string[] | null {
  if (!isAbsolute(out)) {
    return [
      `Error: --out ${out} must be an absolute path.`,
      "  A relative path resolves against whatever directory the caller happened to be in, and getting it wrong means writing into the production results tree by accident.",
    ];
  }
  mkdirSync(out, { recursive: true });
  activeResultsDir = out;
  return null;
}

function makeRunDir(name?: string): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/T/, "_")
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  const slug = name
    ? `${stamp}_${name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-")}`
    : stamp;
  const dir = join(resultsDir(), slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function existingRunNames(): string[] {
  if (!existsSync(resultsDir())) return [];
  const names: string[] = [];
  for (const dir of readdirSync(resultsDir())) {
    const match = dir.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)$/);
    if (match) names.push(match[1]);
  }
  return names;
}

// -- CLI arg parsing --

/**
 * A comma-separated dataset selection, where `none` selects nothing at all.
 *
 * Selecting no datasets on one side is how a language-pinned Speech Model gets
 * benchmarked honestly: hviske decodes as Danish whatever it is handed, so running it
 * over English LibriSpeech audio measures Danish decoding of English speech rather than
 * the model. `--splits none --languages da_dk` is that run. An empty value reads as
 * `none` too, because `--splits ""` is the same intent typed differently and splitting
 * it would otherwise yield one empty split name and fail validation.
 */
function parseDatasetSelection(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "none") return [];
  return trimmed.split(",");
}

/** Clips per dataset a run measures when neither `--samples` nor `--to` is given. */
const DEFAULT_SAMPLE_DELTA = 200;

/**
 * A flag value that has to be a non-negative whole index, or the run stops.
 *
 * Separate from {@link parsePositiveInt} because `--from 0` is the whole point of `--from`
 * - re-measure from the first consumable clip - while `--samples 0` and `--to 0` are
 * nonsense. An index and a count have different legal sets.
 */
function parseNonNegativeInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(
      `Error: ${flag} needs a non-negative whole index into the consumable range (0 is the first clip after the ${WARMUP_RESERVATION} reserved warmups), got "${raw ?? ""}".`,
    );
    process.exit(1);
  }
  return value;
}

/** A flag value that has to be a positive whole number of clips, or the run stops. */
function parsePositiveInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(
      `Error: ${flag} needs a positive whole number of clips, got "${raw ?? ""}".`,
    );
    process.exit(1);
  }
  return value;
}

/**
 * Flags stay the complete interface for CI. The TUI is offered only when
 * `--models` is absent, which is also how a scripted run opts out of it.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    harnesses: [DEFAULT_ASR_HARNESS] as AsrHarnessId[],
    models: SPEECH_MODEL_IDS as string[],
    modelsExplicit: false,
    splits: [...LIBRISPEECH_SPLITS] as string[],
    languages: DEFAULT_FLEURS_LANGUAGES as string[],
    /**
     * How much to measure, relative to what each Combination has already been measured
     * on. Never an absolute slice of the manifest: see `stt/sample-cursor.ts`.
     */
    demand: {
      mode: "delta",
      count: DEFAULT_SAMPLE_DELTA,
    } as SampleDemand,
    /**
     * `--from N`: an explicit start index into the consumable range, overriding every
     * cursor for this run only. Null when the cursors decide, which is every run that is
     * adding coverage rather than re-measuring.
     */
    from: null as number | null,
    skipDownload: false,
    skipConvert: false,
    planOnly: false,
    offloadModels: false,
    reportOnly: false,
    aggregate: false,
    noTui: false,
    name: undefined as string | undefined,
    description: undefined as string | undefined,
    /**
     * `--resume <runId>`: finish the Benchmark Run in `benchmarks/results/<runId>`.
     *
     * The whole resume interface. There is no implicit resume any more: nothing searches
     * for the latest unfinished run, because that search ignores which run the operator
     * meant and resumes the wrong one in silence. Every selection-changing flag is
     * refused beside it by name - see `assertResumeFlags` in the contract.
     */
    resume: null as string | null,
    /**
     * `--batch <batchId>`: the publication batch this run is a stage of.
     *
     * Recorded on the v2 Run Plan and on the run record, not only in a log line, because
     * it is how the orchestrator **finds the run it has to resume**: a crashed stage is
     * identified by its batch and its Combination, and without the id on disk the only
     * way back was to re-issue the same `--name` - which is now refused, so the stage was
     * unrecoverable and every retry reproduced the same exit 1 forever.
     *
     * Deliberately absent from `RESUME_FORBIDDEN_FLAGS`: it names the batch whose stages
     * are being resumed, not the clips a stage measures.
     */
    batch: undefined as string | undefined,
    /**
     * `--out <absolute dir>`: an isolated results tree for this whole invocation.
     *
     * See `adoptResultsDir`. `--out` is the other flag `RESUME_FORBIDDEN_FLAGS` excludes
     * on purpose - it moves where artifacts are written, not what was measured.
     */
    out: undefined as string | undefined,
  };

  // `--samples` and `--to` answer the same question two ways, so taking both would mean
  // silently honouring one of them.
  let demandFlag: string | null = null;
  const setDemand = (flag: string, demand: SampleDemand) => {
    if (demandFlag !== null && demandFlag !== flag) {
      console.error(
        `Error: ${demandFlag} and ${flag} both set the depth. --samples N runs N more clips than already measured; --to N runs whatever is needed to reach depth N. Pick one.`,
      );
      process.exit(1);
    }
    demandFlag = flag;
    flags.demand = demand;
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--harness": {
        // Comma-separated so CI can compare Harnesses in one run, same as the TUI.
        // Validated against the runnable set only: a Harness that is no longer built
        // cannot be measured, however readable its archived results still are.
        const values = args[++i].split(",");
        const unknown = values.filter((v) => !isAsrHarnessId(v));
        if (unknown.length > 0) {
          const retired = unknown.filter(isBenchmarkHarnessLabel);
          console.error(
            `Error: cannot run --harness ${unknown.join(", ")}. Runnable: ${ASR_HARNESS_IDS.join(", ")}`,
          );
          if (retired.length > 0) {
            console.error(
              `  ${retired.join(", ")} is retired and no longer built. Its archived results stay readable in benchmarks/results/, but no new measurement can be produced.`,
            );
          }
          process.exit(1);
        }
        flags.harnesses = values.filter(isAsrHarnessId);
        break;
      }
      case "--models":
        flags.models = args[++i].split(",");
        flags.modelsExplicit = true;
        break;
      case "--splits": {
        const values = parseDatasetSelection(args[++i]);
        const unknown = values.filter((v) => !isLibriSpeechSplit(v));
        if (unknown.length > 0) {
          console.error(
            `Error: unknown --splits ${unknown.join(", ")}. Known: ${LIBRISPEECH_SPLITS.join(", ")}, none`,
          );
          process.exit(1);
        }
        flags.splits = values;
        break;
      }
      case "--languages":
        flags.languages = parseDatasetSelection(args[++i]);
        break;
      case "--samples":
        setDemand("--samples", {
          mode: "delta",
          count: parsePositiveInt(args[++i], "--samples"),
        });
        break;
      case "--to":
        setDemand("--to", {
          mode: "target",
          depth: parsePositiveInt(args[++i], "--to"),
        });
        break;
      case "--from":
        flags.from = parseNonNegativeInt(args[++i], "--from");
        break;
      case "--skip-download":
        flags.skipDownload = true;
        break;
      case "--skip-convert":
        flags.skipConvert = true;
        break;
      case "--skip-existing":
        // Removed rather than ignored. It skipped a whole (Harness, Speech Model, dataset)
        // Combination that already had results at this depth, which was the closest thing
        // to a cursor this benchmark had. The cursor replaces it exactly: nothing is ever
        // re-run, because `--samples` now means "clips not yet measured".
        console.error(
          "Error: --skip-existing has been removed. --samples N now means N clips this Speech Model has not been measured on before, so a Combination is never re-run and there is nothing to skip. Use --to N to top a Combination up to a fixed depth.",
        );
        process.exit(1);
        break;
      case "--plan-only":
        flags.planOnly = true;
        break;
      case "--offload-models":
        flags.offloadModels = true;
        break;
      case "--report-only":
        flags.reportOnly = true;
        break;
      case "--aggregate":
        flags.aggregate = true;
        break;
      case "--no-tui":
        flags.noTui = true;
        break;
      case "--resume":
        flags.resume = args[++i];
        break;
      case "--batch":
        flags.batch = args[++i];
        break;
      case "--out":
        flags.out = args[++i];
        break;
      case "--name":
        flags.name = args[++i];
        break;
      // Two spellings of one field, so the same command shape works here and in
      // dictation-product-benchmark, which calls the free-text note
      // `--configuration-note`. Both write `description` in stt.json; the recorded field
      // name is unchanged.
      case "--description":
      case "--configuration-note":
        flags.description = args[++i];
        break;
      default:
        // An unrecognised flag stops the run instead of being ignored. `--form 5` used to
        // run with every default in place, and the operator's typo was invisible until
        // the plan preview - or, without one, until the numbers came out at a depth
        // nobody asked for. Only `--`-prefixed tokens are judged: a flag's *value* is
        // consumed by `args[++i]` above and never reaches this branch.
        if (args[i].startsWith("--")) {
          console.error(`Error: unknown flag ${args[i]}.`);
          console.error(
            "  Flags take their value as the next argument (--samples 400), not with an equals sign. See benchmarks/README.md for the full list.",
          );
          process.exit(1);
        }
        break;
    }
  }

  if (flags.from !== null && demandFlag === null) {
    console.error(
      `Error: --from needs a depth flag. --from N --samples M measures M clips starting at N; --from N --to M measures from N up to depth M. --from on its own names a start and no end, and falling back to the default --samples ${DEFAULT_SAMPLE_DELTA} would pick a depth nobody asked for on the one path that re-spends clips already measured.`,
    );
    process.exit(1);
  }

  if (flags.out !== undefined) {
    if (flags.out.startsWith("--")) {
      console.error(
        "Error: --out needs an absolute directory for this run's artifacts (e.g. --out /Users/me/bench/smoke/2026-09-v2).",
      );
      process.exit(1);
    }
    const refusal = adoptResultsDir(flags.out);
    if (refusal) {
      for (const line of refusal) console.error(line);
      process.exit(1);
    }
  }

  if (flags.batch !== undefined && flags.batch.startsWith("--")) {
    console.error(
      "Error: --batch needs the batch id this run is a stage of (e.g. --batch 2026-09-v2).",
    );
    process.exit(1);
  }

  if (flags.resume !== null) {
    if (flags.resume === undefined || flags.resume.startsWith("--")) {
      console.error(
        "Error: --resume needs the run id to finish, which is the directory name under benchmarks/results/ (e.g. --resume 2026-09-04_08-17-28_hu-session-1).",
      );
      process.exit(1);
    }
    // On the argv tokens, not on this parsed object, and that is the point: a parser
    // fills in defaults, so once it has, "the operator passed --samples 200" is
    // indistinguishable from "--samples defaulted to 200". The contract owns the list of
    // thirteen flags and the sentence that refuses each one.
    try {
      assertResumeFlags(args, flags.resume);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  return flags;
}

/** One dataset's ordered manifest, split into what warms and what counts. */
interface DatasetPool {
  datasetType: "librispeech" | "fleurs";
  datasetKey: string;
  /** Human label used in logs and in the result report. */
  label: string;
  /** The permanent warmup reservation: replayed every session, never scored. */
  warmups: ManifestEntry[];
  /** Everything a cursor indexes, in order. Index 0 is manifest entry 3. */
  consumable: ManifestEntry[];
  fingerprint: string;
}

/** One (Harness, Speech Model, dataset) tuple and the range it will measure. */
interface PlannedCombination {
  harness: AsrHarnessId;
  /** The Harness label the result is filed under, which is what the cursor is keyed by. */
  bucket: BenchmarkHarnessLabel;
  modelId: string;
  pool: DatasetPool;
  plan: RangePlan;
}

/**
 * The demand in one phrase, for the header and the plan heading.
 *
 * `--from` changes what "new" means, so it changes the phrase: with an explicit start the
 * clips are not new at all, and a heading that still said "new clips" would be the one
 * line of the preview that lied.
 */
function describeDemand(
  demand: SampleDemand,
  from: number | null = null,
): string {
  if (from !== null) {
    return demand.mode === "delta"
      ? `${demand.count} clip${demand.count === 1 ? "" : "s"} per dataset from consumable index ${from} (--from ${from} --samples ${demand.count}; the cursors are ignored for this run)`
      : `consumable index ${from} up to depth ${demand.depth} per dataset (--from ${from} --to ${demand.depth}; the cursors are ignored for this run)`;
  }
  return demand.mode === "delta"
    ? `${demand.count} new clip${demand.count === 1 ? "" : "s"} per dataset (--samples, a delta from each cursor)`
    : `depth ${demand.depth} per dataset (--to, a target; already-measured clips are not re-run)`;
}

function getHardwareInfo(): BenchmarkResults["hardware"] {
  const cpuInfo = cpus();
  const chipName = cpuInfo[0]?.model ?? `${process.platform}-${arch()}`;
  const ramGB = `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`;

  let osVersion: string;
  try {
    const proc = Bun.spawnSync(["sw_vers", "-productVersion"]);
    const ver = new TextDecoder().decode(proc.stdout).trim();
    osVersion = ver || process.version;
  } catch {
    osVersion = process.version;
  }

  return {
    chip: chipName,
    ram: ramGB,
    os:
      process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "Windows"
          : "Linux",
    osVersion,
  };
}

// -- The v2 stage store --

/**
 * The Benchmark Combination id a v2 plan and record are filed under inside a run
 * directory.
 *
 * One run directory holds several Combinations, and each of them is a *run* in the
 * contract's sense: it has its own immutable plan, its own fingerprint over its own clip
 * selection, and its own completed/incomplete status. So the contract's `runId` is
 * `<run directory>/<stage id>`, while `--resume` takes the directory name alone -
 * because that is the string an operator can see and paste, and because a resume finishes
 * every unfinished Combination of one Benchmark Run rather than one of them.
 *
 * The Harness bucket is in the id rather than the selected Harness, for the same reason
 * the cursor is keyed by it: Parakeet and hviske ignore the selected Harness, so filing
 * their stages under it would create two stage ids for one measurement.
 */
export function stageIdFor(
  datasetKey: string,
  bucket: string,
  modelId: string,
): string {
  return `${datasetKey}__${bucket}__${modelId}`;
}

/**
 * The three parts of a stage id, or `null` when it is not one.
 *
 * `__` is the separator because no dataset key, Harness label or Model ID contains it:
 * `test-clean` and `da_dk` use single separators, and Model IDs use `-` and `.`. So a
 * three-way split is exact rather than a guess.
 *
 * It exists because the Harness bucket is the one thing a resumed stage cannot get from
 * anywhere else. A resume used to assign `harnesses[0]` to every stage, which is right
 * only while exactly one ASR Harness is runnable - and the tripwire for that assumption
 * (`assertSingleRunnableAsrHarness`) is on the *pooling* path, so a second runnable
 * Harness would mislabel a resumed leaf here, before any pooling ran. The stage id
 * already records which bucket the run filed this Combination under; reading it back is
 * strictly better than guarding a guess.
 */
export function parseStageId(
  stageId: string,
): { datasetKey: string; bucket: string; modelId: string } | null {
  const parts = stageId.split("__");
  if (parts.length !== 3) return null;
  const [datasetKey, bucket, modelId] = parts;
  if (!datasetKey || !bucket || !modelId) return null;
  return { datasetKey, bucket, modelId };
}

/** The contract `datasetId` for one of this repository's dataset keys. */
export function datasetIdFor(
  datasetType: "librispeech" | "fleurs",
  datasetKey: string,
): string {
  return `${datasetType}/${datasetKey}`;
}

function v2Dir(runDir: string): string {
  return join(runDir, V2_RECORDS_DIRNAME);
}

export function stagePlanPath(runDir: string, stageId: string): string {
  return join(v2Dir(runDir), `${stageId}${V2_PLAN_SUFFIX}`);
}

export function stageRecordPath(runDir: string, stageId: string): string {
  return join(v2Dir(runDir), `${stageId}${V2_RECORD_SUFFIX}`);
}

/**
 * Write a Run Plan, once, before the Combination's first clip.
 *
 * Refuses to overwrite. The plan is the thing a resume trusts completely - it is what
 * makes "resume" mean "finish the clips this run selected" rather than "re-slice from
 * whatever the flags say now" - so a second write would be either a no-op or a silent
 * change of selection under measurements already recorded against the first one.
 */
export function writeStagePlan(
  runDir: string,
  stageId: string,
  plan: RunPlan,
): void {
  const path = stagePlanPath(runDir, stageId);
  if (existsSync(path)) {
    throw new Error(
      `Run Plan ${path} already exists. A plan is immutable once written: rewriting it would ` +
        `change which clips the Samples beside it were measured from.`,
    );
  }
  mkdirSync(v2Dir(runDir), { recursive: true });
  atomicWriteJsonSync(path, plan);
}

/** Write a Combination's v2 record. Called after every scored clip. */
export function writeStageRecord(
  runDir: string,
  stageId: string,
  record: RunRecordV2,
): void {
  mkdirSync(v2Dir(runDir), { recursive: true });
  atomicWriteJsonSync(stageRecordPath(runDir, stageId), record);
}

/**
 * The v2 record for one Combination, at whatever depth it has reached.
 *
 * `status` is explicit and is never inferred from "does it have as many Samples as the
 * plan asked for". A run killed after its last clip but before its footer has every
 * Sample and is still not a completed run, and only completed runs feed the production
 * cursor, aggregation, coverage or publication.
 */
/**
 * Refuses a record whose scored Samples are not in Run Plan order.
 *
 * **Load-bearing for a consumer in another repository.** The website reader reconstructs
 * plan order from the write order of `samples`, because that is the only order the record
 * carries - `RunPlanRefV2` has no clip list. Nothing today sorts them, so the property
 * holds by accident, and the way it would stop holding is specific and silent:
 * `poolSamples` returns each bucket's Samples **sorted by clipId**, so routing a pooled
 * list into a record writer would produce a record that parses, type-guards, pools
 * identically, and breaks the reader's cursor with no error and no failing test.
 *
 * The invariant is that the scored Samples are a **prefix of the plan, in plan order** -
 * stronger than "in order", and true because the loop measures in plan order from the
 * front and a resume appends to a prefix. Warmups are ignored: they are written first and
 * every session replays them, so they repeat by design.
 */
export function assertSamplesInPlanOrder(
  plan: Pick<RunPlan, "runId" | "orderedClipIds">,
  samples: readonly SampleMeasurementV2[],
): void {
  const scored = samples.filter((sample) => !sample.isWarmup);
  if (scored.length > plan.orderedClipIds.length) {
    throw new Error(
      `Run ${plan.runId} has ${scored.length} scored Samples for a plan of ` +
        `${plan.orderedClipIds.length} clips.`,
    );
  }
  for (let index = 0; index < scored.length; index++) {
    if (scored[index].clipId === plan.orderedClipIds[index]) continue;
    throw new Error(
      `Run ${plan.runId} writes "${scored[index].clipId}" at scored position ${index}, ` +
        `where its Run Plan says "${plan.orderedClipIds[index]}". Samples are written in ` +
        `plan order and a reader in another repository reconstructs the plan from that ` +
        `order, so a sorted or reordered list breaks its cursor silently. A pooled list ` +
        `(sorted by clipId) must never be handed to a record writer.`,
    );
  }
}

export function stageRecord(input: {
  runId: string;
  plan: RunPlan;
  status: "completed" | "incomplete";
  startedAt: string;
  completedAt: string | null;
  samples: readonly SampleMeasurementV2[];
  description?: string;
}): RunRecordV2 {
  assertSamplesInPlanOrder(input.plan, input.samples);
  if (input.status === "completed") {
    const scoredCount = input.samples.filter(
      (sample) => !sample.isWarmup,
    ).length;
    if (scoredCount !== input.plan.orderedClipIds.length) {
      throw new Error(
        `Run ${input.runId} cannot be completed with ${scoredCount}/${input.plan.orderedClipIds.length} scored Samples.`,
      );
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    harness: CODICTATE_V2_HARNESS,
    model: input.plan.model,
    datasetId: input.plan.datasetId,
    plan: runPlanRef(input.plan),
    fingerprintV2: input.plan.fingerprintV2,
    // From the plan, not from a flag. A resumed process is forbidden from being told the
    // batch again in any way that could disagree with what the plan recorded, and the
    // plan is immutable - so this cannot drift from the stage the orchestrator is
    // tracking.
    ...(input.plan.batchId === undefined
      ? {}
      : { batchId: input.plan.batchId }),
    samples: [...input.samples],
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
  };
}

// -- Pools --

/** Every selected dataset's ordered pool, warmups reserved at the head. */
function buildPools(languages: string[], splits: string[]): DatasetPool[] {
  const manifests = buildAllManifests(DATASETS_DIR, languages, splits);
  const pools: DatasetPool[] = [];
  for (const [datasetType, byKey] of [
    ["librispeech" as const, manifests.librispeech],
    ["fleurs" as const, manifests.fleurs],
  ] as const) {
    for (const [datasetKey, entries] of Object.entries(byKey)) {
      pools.push({
        datasetType,
        datasetKey,
        label:
          datasetType === "librispeech"
            ? `LibriSpeech ${datasetKey}`
            : `FLEURS ${datasetKey}`,
        warmups: reservedWarmups(entries),
        consumable: consumableEntries(entries),
        // The v1 ordering token, over the legacy non-unique ids and including the
        // warmups. Frozen: every archived `sampleRange` indexes into it. The v2
        // fingerprint over the plan's selected clipIds lives on the plan.
        fingerprint: manifestFingerprint(entries.map((entry) => entry.id)),
      });
    }
  }
  return pools;
}

/** One Combination this process will measure, plus everything it needs to measure it. */
interface Stage {
  harness: AsrHarnessId;
  bucket: BenchmarkHarnessLabel;
  modelId: string;
  pool: DatasetPool;
  stageId: string;
  /** The immutable plan: read from disk on a resume, built here on a new run. */
  plan: RunPlan;
  /** The v1 offset pair, recorded onto the v1 leaf. */
  range: SampleRange;
  /** Samples already on disk for this stage, from an interrupted earlier session. */
  recordedSamples: readonly SampleMeasurementV2[];
  /** When the stage first started measuring. Preserved across a resume. */
  startedAt: string;
}

/**
 * Repair the narrow legacy crash window where a completed v2 record reached disk before
 * its v1 checkpoint leaf. New writes publish the checkpoint first; this keeps runs made
 * by the earlier ordering resumable without re-transcribing anything.
 */
export function recoverCompletedCheckpointLeaf(
  store: { librispeech: DatasetResults; fleurs: DatasetResults },
  inProgress: CheckpointData["inProgress"],
  stages: readonly ReturnType<typeof loadV2Stages>[number][],
): boolean {
  if (!inProgress?.range) return false;
  if (
    getCombinationResult(
      store[inProgress.datasetType],
      inProgress.datasetKey,
      inProgress.harness,
      inProgress.modelId,
    )
  ) {
    return false;
  }
  const expectedStageId = stageIdFor(
    inProgress.datasetKey,
    inProgress.harness,
    inProgress.modelId,
  );
  const stage = stages.find(
    (candidate) =>
      candidate.stageId === expectedStageId &&
      candidate.record?.status === "completed",
  );
  if (!stage?.record) return false;
  setCombinationResult(
    store[inProgress.datasetType],
    inProgress.datasetKey,
    inProgress.harness,
    inProgress.modelId,
    leafFromSamples(stage.record.samples, {
      range: inProgress.range,
      peakRSS_MB: null,
      computeCer: inProgress.datasetType === "fleurs",
    }),
  );
  return true;
}

/**
 * Measure every stage, writing the plan once and the record after every scored clip.
 *
 * The two accumulators are both kept for a reason. `checkpoint.json` carries the v1
 * leaves of finished Combinations, which is what the final `stt.json` is assembled from
 * and what `dictation-product-benchmark` mirrors. The v2 records carry the Samples, which
 * is what pooling, resume and the cursor read. Neither is derivable from the other: a v1
 * leaf has no clips and a v2 record has no peak RSS.
 */
async function runStages(
  runDir: string,
  stages: readonly Stage[],
  flags: ReturnType<typeof parseArgs>,
  store: { librispeech: DatasetResults; fleurs: DatasetResults },
  harnesses: AsrHarnessId[],
  context: { demand?: SampleDemand; description?: string },
): Promise<void> {
  let runningHarness: string | null = null;
  let runningModel: string | null = null;

  const checkpointData = (
    inProgress?: CheckpointData["inProgress"],
  ): CheckpointData => ({
    harnesses,
    librispeech: store.librispeech,
    fleurs: store.fleurs,
    // Carried through every rewrite: the checkpoint is the only record of what this run
    // was *asked* for, and a resume is forbidden from being told again.
    demand: context.demand,
    description: context.description,
    inProgress,
  });

  for (const stage of stages) {
    const { harness, bucket, modelId, pool, plan, range } = stage;

    if (harness !== runningHarness) {
      if (harnesses.length > 1) console.log(`\n=== Harness: ${harness} ===`);
      runningHarness = harness;
      runningModel = null;
    }

    if (modelId !== runningModel) {
      runningModel = modelId;
      // The header names what actually transcribes, not the Harness that was selected.
      // Parakeet ignores the selected Harness entirely, so printing one next to it read as
      // a claim that crispasr produced the numbers.
      const runsOwnHelper =
        getSpeechModel(modelId)?.engine === PARAKEET_ENGINE_ID;
      console.log(
        `\n[${modelId} / ${runsOwnHelper ? "parakeet helper" : harness}]`,
      );
      if (runsOwnHelper || bucket !== harness) {
        console.log(
          `  [${modelId}] recorded under "${bucket}": Parakeet runs through its own helper, so harness does not apply`,
        );
      }
    }

    const target =
      pool.datasetType === "librispeech" ? store.librispeech : store.fleurs;
    // CER is scored for FLEURS only: LibriSpeech's reference transcripts are already
    // normalised upper-case ASCII, so a character rate over them measures nothing.
    const computeCer = pool.datasetType === "fleurs";

    if (getCombinationResult(target, pool.datasetKey, bucket, modelId)) {
      const scoredCount = stage.recordedSamples.filter(
        (sample) => !sample.isWarmup,
      ).length;
      if (scoredCount !== plan.orderedClipIds.length) {
        throw new Error(
          `Checkpoint says ${modelId}/${pool.datasetKey} is done, but its run record has ` +
            `${scoredCount}/${plan.orderedClipIds.length} scored Samples.`,
        );
      }
      // Recovery for a crash after the durable checkpoint leaf but before the final
      // status flip. No audio runs: the complete incomplete-record is promoted in place.
      writeStageRecord(
        runDir,
        stage.stageId,
        stageRecord({
          runId: plan.runId,
          plan,
          status: "completed",
          startedAt: stage.startedAt,
          completedAt: new Date().toISOString(),
          samples: stage.recordedSamples,
          description: context.description ?? flags.description,
        }),
      );
      console.log(
        `  [${modelId}] ${pool.label}: recovered (checkpoint done; record promoted without transcription)`,
      );
      continue;
    }

    const clips: ManifestEntry[] = hydrateDurations([
      ...pool.warmups,
      ...pool.consumable.slice(range.startIndex, range.endIndex),
    ]);

    const outcome = await benchmarkModel(modelId, clips, pool.label, {
      harness,
      range,
      plan,
      recordedSamples: stage.recordedSamples,
      computeCer,
      onScoredClip: (samples) => {
        // Atomic, synchronous, after every scored clip. Both files: the v2 record is the
        // measurement, the checkpoint is the v1 progress view of it.
        writeStageRecord(
          runDir,
          stage.stageId,
          stageRecord({
            runId: plan.runId,
            plan,
            status: "incomplete",
            startedAt: stage.startedAt,
            completedAt: null,
            samples,
            description: context.description ?? flags.description,
          }),
        );
        saveCheckpoint(
          runDir,
          checkpointData({
            harness: bucket,
            modelId,
            datasetKey: pool.datasetKey,
            datasetType: pool.datasetType,
            partial: partialFromSamples(samples),
            range,
          }),
        );
      },
    });

    setCombinationResult(
      target,
      pool.datasetKey,
      bucket,
      modelId,
      outcome.result,
    );
    saveCheckpoint(runDir, checkpointData());
    // Completion is published last. A crash before this write resumes from the complete
    // incomplete-record and the durable v1 leaf above; a crash after it loses neither.
    writeStageRecord(
      runDir,
      stage.stageId,
      stageRecord({
        runId: plan.runId,
        plan,
        status: "completed",
        startedAt: stage.startedAt,
        completedAt: new Date().toISOString(),
        samples: outcome.samples,
        description: context.description ?? flags.description,
      }),
    );
  }
}

/**
 * The pooled depth this Benchmark Run reached, and the leaves behind it.
 *
 * `sampleSize` is **pooled unique scored clips**, not the deepest cursor a plan named.
 * That was defect 2: the field was `max(plan.endIndex)`, so continuing a Combination from
 * 400 to 800 wrote `sampleSize: 800` beside a single leaf holding 400 measurements, and
 * `--aggregate` then kept one of the two leaves rather than pooling them. A depth is only
 * a depth if a Sample stands behind every clip of it.
 */
function pooledDepth(runName: string): {
  sampleSize: number;
  buckets: number;
} {
  const records = completedV2Records(
    loadV2Stages(resultsDir()).filter((stage) => stage.runName === runName),
  );
  if (records.length === 0) return { sampleSize: 0, buckets: 0 };
  const pooled = pooledV2Leaves(records);
  return {
    sampleSize: Math.max(0, ...pooled.leaves.map((leaf) => leaf.sampleCount)),
    buckets: pooled.leaves.length,
  };
}

async function finishRun(
  runDir: string,
  runName: string,
  description: string,
  store: { librispeech: DatasetResults; fleurs: DatasetResults },
  demand: SampleDemand | null,
): Promise<void> {
  const depth = pooledDepth(runName);
  const results: BenchmarkResults = {
    description,
    hardware: getHardwareInfo(),
    runDate: new Date().toISOString(),
    config: {
      sampleSize: depth.sampleSize,
      // Only claim "pooled" when a pool produced the number. With no v2 bucket there is
      // nothing pooled, and labelling a claimed range width as a count of measured clips
      // is defect 2's own error class.
      ...(depth.buckets > 0
        ? { sampleSizeBasis: "pooled-v2" as const }
        : { sampleSizeBasis: "v1-claimed-range" as const }),
      warmupCount: WARMUP_RESERVATION,
      normalization: "whisper-basic",
      // Absent on a resumed run whose checkpoint predates the field: the flag is a
      // statement about what was asked for, and only the original invocation knows it.
      // Absent has always meant "no selection recorded", never "a delta of zero".
      ...(demand === null
        ? {}
        : {
            sampleSelection:
              demand.mode === "delta"
                ? { mode: "delta" as const, requested: demand.count }
                : { mode: "target" as const, requested: demand.depth },
          }),
    },
    librispeech: store.librispeech,
    fleurs: store.fleurs,
  };

  const jsonPath = join(runDir, "stt.json");
  await Bun.write(jsonPath, JSON.stringify(results, null, 2));
  console.log(
    `\nJSON written to ${jsonPath} (${depth.sampleSize} pooled unique scored clips across ${depth.buckets} combination${depth.buckets === 1 ? "" : "s"})`,
  );

  // The run is complete: the checkpoint has nothing left to resume.
  deleteCheckpoint(runDir);

  await writeReport(results, runDir);
  console.log("\n" + generateMarkdownReport(results));
}

// -- Resume --

/**
 * Finish the Benchmark Run in `benchmarks/results/<runId>`.
 *
 * Every plan is read from disk. Nothing here consults `--samples`, `--to`, `--from`,
 * `--models`, `--languages` or `--splits`, and `assertResumeFlags` has already refused
 * them by name in `parseArgs` - because a resume that re-derived its selection from the
 * current flags would file the Samples it already has against a range it did not measure,
 * and the fingerprint copied from the plan would read as agreement.
 */
async function resumeRun(flags: ReturnType<typeof parseArgs>): Promise<void> {
  const runId = flags.resume!;
  const target = resolveResumeTarget(resultsDir(), runId);
  if (target.status === "error") {
    for (const line of target.lines) console.error(line);
    process.exit(1);
  }
  const runDir = target.runDir;

  const allStages = loadV2Stages(resultsDir()).filter(
    (stage) => stage.runName === runId,
  );
  for (const broken of unresumableV2Stages(allStages)) {
    console.warn(
      `Warning: ${broken.stageId} in ${runId} has no readable ${broken.plan === null ? "plan" : "record"} and cannot be resumed. Its measurements, if any, stay on disk unread.`,
    );
  }

  const unfinished = incompleteV2Stages(allStages);
  if (unfinished.length === 0) {
    console.log(
      `--- ${runId} has no unfinished Combination left; writing its report ---`,
    );
  }

  const checkpoint = await loadCheckpoint(runDir);
  if (!checkpoint) {
    console.error(
      `Error: ${runId} has no ${CHECKPOINT_FILE}, so the v1 leaves of its finished Combinations cannot be recovered.`,
    );
    console.error(
      "  Nothing in that directory was ever written to stt.json. Delete it and start a fresh run.",
    );
    process.exit(1);
  }

  // Archived labels against a runnable set: a checkpoint left mid-run by whisper-cli must
  // be refused by name, not read as an empty set and resumed under crispasr, which would
  // file crispasr numbers next to whisper-cli ones in the same run.
  const retired = checkpoint.harnesses.filter((h) => !isAsrHarnessId(h));
  if (retired.length > 0) {
    console.error(
      `Error: ${runId} was started under ASR Harness "${checkpoint.harnesses.join(", ")}", and ${retired.join(", ")} is retired and no longer built.`,
    );
    console.error(
      `  That run can never be finished. Delete ${runDir} to start fresh; nothing in it was ever written to stt.json.`,
    );
    process.exit(1);
  }
  const harnesses = checkpoint.harnesses.filter(isAsrHarnessId);

  console.log("=== Codictate STT Benchmark (resume) ===");
  console.log(`Resuming: ${runId}`);
  console.log(`ASR harnesses: ${harnesses.join(", ")}`);
  console.log(
    `Unfinished combinations: ${unfinished.length === 0 ? "none" : unfinished.map((s) => s.stageId).join(", ")}`,
  );
  console.log("");

  const store = {
    librispeech: checkpoint.librispeech,
    fleurs: checkpoint.fleurs,
  };

  if (recoverCompletedCheckpointLeaf(store, checkpoint.inProgress, allStages)) {
    console.warn(
      `Recovered ${checkpoint.inProgress!.modelId}/${checkpoint.inProgress!.datasetKey} from its completed v2 record; the earlier process stopped before saving its v1 checkpoint leaf. Peak RSS is unavailable for that recovered leaf.`,
    );
    saveCheckpoint(runDir, {
      ...checkpoint,
      librispeech: store.librispeech,
      fleurs: store.fleurs,
      inProgress: undefined,
    });
  }

  // The description cannot be re-typed on a resume: `--description` is not forbidden, but
  // the run page's title comes from it and a second wording would silently replace the
  // first. The checkpoint's is preferred, and a v2 record's is the fallback for a
  // checkpoint written before the field existed.
  const description =
    checkpoint.description ??
    allStages
      .map((stage) => stage.record?.description)
      .find(
        (text): text is string => typeof text === "string" && text !== "",
      ) ??
    flags.description ??
    "";

  if (unfinished.length > 0) {
    // The pools the *plans* name, not the pools the flags would select.
    const languages = [
      ...new Set(
        unfinished
          .map((stage) => stage.plan.datasetId)
          .filter((id) => id.startsWith("fleurs/"))
          .map((id) => id.slice("fleurs/".length)),
      ),
    ];
    const splits = [
      ...new Set(
        unfinished
          .map((stage) => stage.plan.datasetId)
          .filter((id) => id.startsWith("librispeech/"))
          .map((id) => id.slice("librispeech/".length)),
      ),
    ];

    console.log("--- Building manifests ---");
    const pools = buildPools(languages, splits);
    console.log("");

    const stages: Stage[] = [];
    for (const stage of unfinished.sort((a, b) =>
      a.stageId < b.stageId ? -1 : 1,
    )) {
      const pool = pools.find(
        (candidate) =>
          datasetIdFor(candidate.datasetType, candidate.datasetKey) ===
          stage.plan.datasetId,
      );
      if (!pool) {
        console.error(
          `Error: ${stage.stageId} measures ${stage.plan.datasetId}, which is not on disk.`,
        );
        console.error(
          "  Restore that dataset, or delete the run directory - its plan cannot be finished without the audio it names.",
        );
        process.exit(1);
      }
      // Every complaint about the plan at once, before a single clip is measured. The
      // scan that found this stage used `isRunPlan`, because a scan must survive one bad
      // file; here the plan is about to be trusted completely - it decides which clips
      // are skipped as already done and which are measured - so the stricter form runs,
      // and the run id is passed so a plan belonging to a different run is caught rather
      // than resumed under this one's name.
      assertRunPlanOnDisk(stage.plan, `${runId}/${stage.stageId}`);

      // The plan's clips must still be the clips at the offsets it recorded. Checked on
      // clipIds rather than on the v1 ordering token, because identity is what a resume
      // is correct in terms of: the plan names the clips and `resumeSelection` works on
      // the names, so a re-ordered manifest cannot make it measure the wrong audio - but
      // it *would* make the `sampleRange` this stage records point at clips it never
      // transcribed, and every v1 cursor is derived from those offsets.
      const atRecordedOffsets = pool.consumable
        .slice(stage.plan.fromIndex, stage.plan.toIndex)
        .map((entry) => entry.clipId);
      if (
        atRecordedOffsets.length !== stage.plan.orderedClipIds.length ||
        atRecordedOffsets.some(
          (clipId, index) => clipId !== stage.plan.orderedClipIds[index],
        )
      ) {
        console.error(
          `Error: the ordered clip list for ${stage.plan.datasetId} has changed since ${runId} was planned.`,
        );
        console.error(
          `  ${stage.stageId} selected consumable ${stage.plan.fromIndex}-${stage.plan.toIndex}, and those offsets now name different clips.`,
        );
        console.error(
          "  Its Run Plan still names the right audio, but the sampleRange it would record would point at clips it never transcribed, and every v1 cursor is derived from those offsets.",
        );
        console.error(
          `  Fix the dataset so the ordering matches, or delete ${runDir} - nothing in it was ever written to stt.json.`,
        );
        process.exit(1);
      }

      // The bucket the run filed this Combination under, read back from its stage id,
      // and the selected Harness that produces it - not `harnesses[0]`. Parakeet and
      // hviske force their bucket, so bucket-to-Harness is not invertible; the selected
      // Harness is whichever of the run's own Harnesses maps onto the recorded bucket.
      const recorded = parseStageId(stage.stageId);
      const bucket = recorded?.bucket;
      const harness = harnesses.find(
        (candidate) =>
          harnessBucketForModel(stage.plan.model, candidate) === bucket,
      );
      if (!bucket || !isBenchmarkHarnessLabel(bucket) || !harness) {
        console.error(
          `Error: cannot tell which ASR Harness ${stage.stageId} in ${runId} was measured under.`,
        );
        console.error(
          `  Its stage id records the bucket "${bucket ?? "?"}", and the run's Harness set is "${harnesses.join(", ")}". Resuming under a guessed Harness would file these numbers against a Harness that never produced them.`,
        );
        console.error(
          `  Delete ${runDir} to discard the run - nothing in it was ever written to stt.json.`,
        );
        process.exit(1);
      }
      stages.push({
        harness,
        bucket,
        modelId: stage.plan.model,
        pool,
        stageId: stage.stageId,
        plan: stage.plan,
        // Recovered from the plan, not recomputed from a cursor: the plan is the record of
        // what this run selected, and the cursor cannot see the run it belongs to.
        range: {
          startIndex: stage.plan.fromIndex,
          endIndex: stage.plan.toIndex,
          manifestFingerprint: pool.fingerprint,
        },
        recordedSamples: stage.record.samples,
        startedAt: stage.record.startedAt,
      });
    }

    console.log("--- Running benchmarks ---");
    await runStages(runDir, stages, flags, store, harnesses, {
      demand: checkpoint.demand,
      description,
    });
  }

  await finishRun(runDir, runId, description, store, checkpoint.demand ?? null);
}

async function main() {
  const flags = parseArgs();

  // Report-only mode: regenerate reports + charts for all runs
  if (flags.reportOnly) {
    const runs = readdirSync(resultsDir())
      .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
      .sort();
    if (runs.length === 0) {
      console.error("No existing benchmark runs found in results/");
      process.exit(1);
    }
    for (const run of runs) {
      const runDir = join(resultsDir(), run);
      const jsonPath = join(runDir, "stt.json");
      if (!existsSync(jsonPath)) continue;
      console.log(`\n--- Regenerating: ${run} ---`);
      await writeReport(readResultsFile(jsonPath), runDir);
    }
    return;
  }

  if (flags.aggregate) {
    await aggregateAllRuns();
    return;
  }

  if (flags.resume !== null) {
    await resumeRun(flags);
    return;
  }

  await startNewRun(flags);
}

// -- Aggregate --

/**
 * Merge every run into `results/stt.json`, pooling v2 Samples and keeping the v1
 * depth-wins rule for the leaves that have no Samples.
 *
 * Two rules rather than one, because the archive has two kinds of leaf and only one of
 * them can be pooled:
 *
 * - A **v2** Combination is pooled per `clipId`: disjoint continuations union, an
 *   overlapping rerun replaces only the clips it re-measured, and the earlier run's other
 *   clips survive. `sampleCount` is the pooled unique scored clips.
 * - A **v1** aggregate leaf keeps the old resolution: depth wins over recency, ties to the
 *   newer run. Not a preference - a rate and a count have no clips to intersect, so
 *   keeping the deeper leaf is the only resolution available. A v1 leaf is never
 *   reinterpreted as per-clip measurements; there is no inverse.
 *
 * The pooled leaves are written **over** the v1 ones for the Combinations they cover, so
 * a Combination measured under v2 publishes its pooled numbers and one measured only
 * under v1 stays visible as the legacy measurement it is.
 */
async function aggregateAllRuns(): Promise<void> {
  const runs = readdirSync(resultsDir())
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  if (runs.length === 0) {
    console.error("No existing benchmark runs found in results/");
    process.exit(1);
  }
  console.log("--- Aggregating all runs ---");

  // Counted across every run so the operator sees at a glance that the merge
  // dropped something, rather than only the per-Combination warnings scrolling by.
  let rejectedShallower = 0;

  const merged: BenchmarkResults = {
    description: "Aggregated results from all benchmark runs",
    hardware: getHardwareInfo(),
    runDate: new Date().toISOString(),
    config: {
      sampleSize: 0,
      // Corrected below, once it is known whether the printed number came from a v2 pool
      // or from a v1 claimed range width. It starts as the honest v1 answer.
      sampleSizeBasis: "v1-claimed-range",
      warmupCount: 3,
      normalization: "whisper-basic",
    },
    librispeech: {},
    fleurs: {},
  };
  // Tracked apart, because they are different claims. Every archived run's
  // `config.sampleSize` is its *claimed range width* and sits exactly `warmupCount` above
  // its deepest `utteranceCount` (400 against 397, 200 against 197, 50 against 47), so
  // printing the v1 maximum under the pooled wording would claim 400 measured clips where
  // 397 exist and no v2 Sample does.
  let v1ClaimedMax = 0;
  let pooledMax = 0;

  for (const run of runs) {
    const jsonPath = join(resultsDir(), run, "stt.json");
    if (!existsSync(jsonPath)) continue;
    const data = readResultsFile(jsonPath);
    console.log(`  merging: ${run}`);

    v1ClaimedMax = Math.max(v1ClaimedMax, data.config.sampleSize);

    for (const field of ["librispeech", "fleurs"] as const) {
      for (const [datasetKey, byHarness] of Object.entries(data[field])) {
        for (const [harness, byModel] of Object.entries(byHarness)) {
          // Archived labels. Guarding on runnable ids here silently drops every
          // whisper-cli bucket out of the aggregate, including the comparison run
          // that justified retiring it.
          if (!isBenchmarkHarnessLabel(harness) || !byModel) continue;
          for (const [modelId, result] of Object.entries(byModel)) {
            if (result.utteranceCount <= 0) continue;
            // Depth wins, not recency. A newer run at 20 utterances is a shallower
            // measurement of the same Combination, not a correction of a 200-utterance
            // one, and letting it overwrite publishes the noisier number under a
            // sampleSize the row never had. Ties go to the newer run, which the
            // chronological `runs` order already gives us.
            const existing = getCombinationResult(
              merged[field],
              datasetKey,
              harness,
              modelId,
            );
            if (
              existing !== undefined &&
              result.utteranceCount < existing.utteranceCount
            ) {
              console.log(
                `  [WARN] ${datasetKey}/${harness}/${modelId}: keeping ${existing.utteranceCount} utterances from an earlier run, rejecting newer shallower result (${result.utteranceCount} utterances)`,
              );
              rejectedShallower++;
              continue;
            }
            setCombinationResult(
              merged[field],
              datasetKey,
              harness,
              modelId,
              result,
            );
          }
        }
      }
    }
  }

  console.log(
    `\n  ${rejectedShallower} shallower result${rejectedShallower === 1 ? "" : "s"} rejected in favour of a deeper earlier run`,
  );

  // The v2 half: pooled per clipId, over completed runs only.
  const stages = loadV2Stages(resultsDir());
  const records = completedV2Records(stages);
  const skippedIncomplete = stages.filter(
    (stage) => stage.record !== null && stage.record.status === "incomplete",
  );
  if (skippedIncomplete.length > 0) {
    console.log(
      `\n  ${skippedIncomplete.length} incomplete v2 combination${skippedIncomplete.length === 1 ? "" : "s"} contributed nothing - not even the clips they finished: ${skippedIncomplete.map((s) => `${s.runName}/${s.stageId}`).join(", ")}`,
    );
  }

  if (records.length > 0) {
    const pooled = pooledV2Leaves(records);
    console.log(
      `\n  pooling ${records.length} v2 run record${records.length === 1 ? "" : "s"} into ${pooled.leaves.length} combination${pooled.leaves.length === 1 ? "" : "s"}`,
    );
    for (const leaf of pooled.leaves) {
      console.log(
        `  [pooled] ${leaf.datasetKey}/${leaf.harness}/${leaf.modelId}: ${leaf.sampleCount} unique scored clips from ${leaf.runIds.length} run${leaf.runIds.length === 1 ? "" : "s"}${leaf.replacedCount > 0 ? `, ${leaf.replacedCount} clip(s) replaced by a later run` : ""}`,
      );
      setCombinationResult(
        merged[leaf.field],
        leaf.datasetKey,
        leaf.harness,
        leaf.modelId,
        leaf.leaf,
      );
      // A pooled depth is backed by a Sample per clip, unlike the v1 claimed range
      // width beside it.
      pooledMax = Math.max(pooledMax, leaf.sampleCount);
    }
    for (const bucket of pooled.unplaceableBuckets) {
      console.warn(
        `Warning: pooled bucket ${bucket} names a corpus this repository does not store; it is not in the aggregate.`,
      );
    }
    for (const bucket of pooled.foreignHarnessBuckets) {
      console.warn(
        `Warning: pooled bucket ${bucket} was measured by another harness. benchmarks/results/ files leaves under an ASR Harness bucket and renders them as Codictate rows, so it is left out of the aggregate rather than published under the wrong product's name.`,
      );
    }
  }

  // The label follows the number. `pooledMax` wins only when it is the number printed;
  // otherwise the figure is a v1 claimed width and says so.
  merged.config.sampleSize = Math.max(v1ClaimedMax, pooledMax);
  merged.config.sampleSizeBasis =
    pooledMax > 0 && pooledMax >= v1ClaimedMax
      ? "pooled-v2"
      : "v1-claimed-range";
  console.log(
    merged.config.sampleSizeBasis === "pooled-v2"
      ? `\n  depth: ${merged.config.sampleSize} pooled unique scored clips`
      : `\n  depth: ${merged.config.sampleSize} - the deepest v1 claimed range width, not a count of measured clips (no v2 pool reached it)`,
  );

  const jsonPath = join(resultsDir(), "stt.json");
  await Bun.write(jsonPath, JSON.stringify(merged, null, 2));
  console.log(`\nAggregated JSON written to ${jsonPath}`);

  await writeReport(merged, resultsDir(), { noChunks: true });
  console.log("\n" + generateMarkdownReport(merged));
}

// -- A new run --

async function startNewRun(flags: ReturnType<typeof parseArgs>): Promise<void> {
  // Interactive setup, unless the caller drove everything with flags.
  const useTui = !flags.modelsExplicit && !flags.noTui;

  // `--from` is a scripted intent and the TUI is not. The TUI only ever offers a delta
  // from each cursor (it exists to add coverage), and it overwrites `flags.demand` with
  // what was picked on screen - so a typed `--from` combined with a TUI-chosen depth would
  // be a rewind nobody selected in the TUI. Refused rather than honoured silently.
  if (flags.from !== null && useTui) {
    console.error(
      "Error: --from cannot be combined with the interactive picker. The picker only offers a delta from each cursor, so a typed --from would rewind a range nobody selected on screen.",
    );
    console.error(
      "  Name the models on the command line instead: --models <ids> --from N --samples M. --no-tui also works.",
    );
    process.exit(1);
  }

  if (useTui) {
    const plan = await promptBenchmarkPlan({
      coverage: loadCoverage(resultsDir()),
      availableLanguages: DEFAULT_FLEURS_LANGUAGES,
      usedNames: existingRunNames(),
    });
    flags.harnesses = plan.harnesses;
    flags.models = plan.models;
    flags.splits = plan.splits;
    flags.languages = plan.languages;
    // The TUI only ever offers a delta: it exists to add coverage, and a target depth is a
    // scripted, re-runnable intent that belongs on the command line.
    flags.demand = { mode: "delta", count: plan.samples };
    flags.name = plan.name;
    flags.description = plan.description;
  }

  console.log("=== Codictate STT Benchmark ===");
  if (flags.name) console.log(`Name: ${flags.name}`);
  console.log(`ASR harnesses: ${flags.harnesses.join(", ")}`);
  console.log(`Models: ${flags.models.join(", ")}`);
  console.log(`LibriSpeech splits: ${flags.splits.join(", ") || "none"}`);
  console.log(`FLEURS languages: ${flags.languages.join(", ") || "none"}`);
  console.log(`Depth: ${describeDemand(flags.demand, flags.from)}`);
  if (flags.from !== null) {
    console.log(
      `From: --from ${flags.from} (explicit start into the consumable range; every cursor is ignored for this run only)`,
    );
  }
  if (flags.planOnly)
    console.log("Plan only: ON (nothing will be transcribed)");
  if (flags.offloadModels) console.log("Offload models: ON");
  console.log("");

  if (flags.splits.length === 0 && flags.languages.length === 0) {
    console.error(
      "Error: no datasets selected. --splits none and --languages none together leave nothing to benchmark.",
    );
    console.error(
      "  Keep one side: --splits none --languages da_dk benchmarks FLEURS Danish only.",
    );
    process.exit(1);
  }

  // A plan preview writes nothing and creates no run directory, so it needs no identity.
  // It also reads only what is already on disk - hence no download and no convert - which
  // is what makes it safe to run while something else is benchmarking.
  if (flags.planOnly) {
    flags.skipDownload = true;
    flags.skipConvert = true;
  }

  if (!flags.name && !flags.planOnly) {
    console.error(
      "Error: --name is required. Used as URL slug for the benchmark page.",
    );
    console.error(
      "  Format: lowercase letters, numbers, and hyphens (e.g. tiny-base-triage)",
    );
    process.exit(1);
  }

  if (flags.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flags.name)) {
    console.error(`Error: invalid name "${flags.name}".`);
    console.error(
      "  Must be lowercase, alphanumeric, separated by hyphens (e.g. tiny-base-triage)",
    );
    console.error(
      "  No uppercase, spaces, underscores, or leading/trailing hyphens.",
    );
    process.exit(1);
  }

  // A name collision is now a collision, finished or not. An unfinished run of the same
  // name is no longer "this run": a resume names a run id, so the name says nothing about
  // which run an invocation meant, and treating it as an implicit resume is what made the
  // wrong run resumable in the first place.
  if (flags.name && existsSync(resultsDir())) {
    const sameName = readdirSync(resultsDir())
      .filter((d) => d.endsWith(`_${flags.name}`))
      .sort();
    const finished = sameName.filter((d) =>
      existsSync(join(resultsDir(), d, "stt.json")),
    );
    if (finished.length > 0) {
      console.error(
        `Error: name "${flags.name}" already used in ${finished[0]}. Choose a unique name.`,
      );
      process.exit(1);
    }
    const unfinished = sameName.filter(
      (d) => !existsSync(join(resultsDir(), d, "stt.json")),
    );
    if (unfinished.length > 0 && !flags.planOnly) {
      console.error(
        `Error: "${flags.name}" has an unfinished run in ${unfinished[0]}.`,
      );
      console.error(
        `  Finish it with --resume ${unfinished[0]}, which re-reads the Run Plan it was started with, or delete that directory to discard it.`,
      );
      console.error(
        "  An orchestrator driving this as a batch stage finds that run id from the `batchId` on its Run Plan (--batch), and resumes it by id rather than re-issuing --name.",
      );
      console.error(
        "  Re-running the same --name no longer resumes: a name is not a run identity, and guessing which unfinished run was meant is how the wrong one got resumed.",
      );
      process.exit(1);
    }
  }

  if (!flags.description && !flags.planOnly) {
    console.error(
      "Error: --description is required. Describe the goal of this benchmark run.",
    );
    process.exit(1);
  }

  // Step 1: Datasets on disk. The plan needs every selected dataset's complete ordered
  // manifest, so downloading and converting come first.
  if (!flags.skipDownload) {
    console.log("--- Downloading datasets ---");
    if (flags.splits.length > 0) await downloadLibriSpeech();
    if (flags.languages.length > 0) await downloadFleurs(flags.languages);
    console.log("");
  }

  if (!flags.skipConvert && flags.splits.length > 0) {
    console.log("--- Converting audio ---");
    await convertLibriSpeech(DATASETS_DIR);
    console.log("");
  }

  // Step 2: Build the ordered manifests, complete and unsliced.
  console.log("--- Building manifests ---");
  const pools = buildPools(flags.languages, flags.splits);
  console.log("");

  if (pools.length === 0) {
    console.error(
      "Error: none of the selected datasets are on disk. Nothing can be planned, let alone benchmarked.",
    );
    console.error(
      "  Drop --skip-download, or check benchmarks/datasets/ for the splits and locales you asked for.",
    );
    process.exit(1);
  }

  console.log("--- Sample pools ---");
  for (const pool of pools) {
    console.log(
      `  ${pool.datasetKey}: ${WARMUP_RESERVATION} reserved warmup + ${pool.consumable.length} consumable  [v1 ordering ${pool.fingerprint}]`,
    );
  }
  console.log("");

  // `--from` is the one offset a human types, so its bound is checked against the pools
  // that were actually selected rather than clamped. It cannot be checked at parse time:
  // how many consumable clips exist depends on --splits and --languages.
  if (flags.from !== null) {
    const error = fromIndexError(
      flags.from,
      new Map(pools.map((pool) => [pool.datasetKey, pool.consumable.length])),
    );
    if (error) {
      console.error(error);
      process.exit(1);
    }
  }

  // Step 3: Where every Combination has got to. Derived from the run directories, which
  // are the source of truth; the root aggregate is deliberately not read.
  const coverage = loadCoverage(resultsDir());
  const currentFingerprints = Object.fromEntries(
    pools.map((pool) => [pool.datasetKey, pool.fingerprint]),
  );

  // An offset into a list that has changed is not a shallower measurement of the same
  // sample, it is a pointer into something that no longer exists. Refuse, loudly, rather
  // than restart the cursor from zero and silently re-measure or skip clips.
  const conflicts = manifestFingerprintConflicts(
    coverage.cursors,
    currentFingerprints,
  );
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      for (const line of formatFingerprintConflict(conflict)) {
        console.error(line);
      }
    }
    process.exit(1);
  }

  for (const line of coverage.cursors.inconsistencies) {
    console.warn(`Warning: ${line}`);
  }

  // The v2 half of the cursor, over completed run records only. Printed beside the v1
  // cursor because the two are derived from different records of the same measurements,
  // and `cursor` vs `maxMeasuredEnd` is the signal that a range was measured past a hole.
  const completedRecords = completedV2Records(loadV2Stages(resultsDir()));
  const v2SamplesByDataset = new Map<string, SampleMeasurementV2[]>();
  for (const record of completedRecords) {
    // Codictate's own measurements only. `harness` is half of the compatibility key, and
    // a cursor that pooled another product's Samples would report a depth this Harness
    // never measured - and then skip those clips.
    if (record.harness !== CODICTATE_V2_HARNESS) continue;
    const key = `${record.model}|${record.datasetId}`;
    const into = v2SamplesByDataset.get(key) ?? [];
    into.push(...record.samples);
    v2SamplesByDataset.set(key, into);
  }

  // Step 4: Plan every Combination before a single clip runs.
  const planned: PlannedCombination[] = [];
  const plannedKeys = new Map<string, PlannedCombination>();
  for (const harness of flags.harnesses) {
    for (const modelId of flags.models) {
      const bucket = harnessBucketForModel(modelId, harness);
      for (const pool of pools) {
        // Keyed by the bucket the results are filed under, not by the selected Harness,
        // because that is the key the cursor is stored under. Parakeet and hviske ignore
        // the selected Harness, so a two-Harness run must not plan them twice and consume
        // two ranges for one measurement.
        const key = `${bucket}|${modelId}|${pool.datasetKey}`;
        const already = plannedKeys.get(key);
        if (already) {
          console.log(
            `  [${modelId}] ${pool.datasetKey}: planned once under "${bucket}" (harness ${already.harness}); it does not run per selected Harness`,
          );
          continue;
        }
        const cursor = cursorFor(
          coverage.cursors,
          bucket,
          modelId,
          pool.datasetKey,
          pool.fingerprint,
        );
        const orderedClipIds = pool.consumable.map((entry) => entry.clipId);
        const completedV2Samples =
          v2SamplesByDataset.get(
            `${modelId}|${datasetIdFor(pool.datasetType, pool.datasetKey)}`,
          ) ?? [];
        const v2 = v2DatasetCoverage(orderedClipIds, completedV2Samples);
        const continuationCursor = reconciledContinuationCursor(
          orderedClipIds,
          cursor,
          completedV2Samples,
        );
        if (v2.maxMeasuredEnd > continuationCursor) {
          console.log(
            `  [${modelId}] ${pool.datasetKey}: cursor ${continuationCursor} (legacy prefix plus contiguous v2), deepest v2 measured end ${v2.maxMeasuredEnd} - ${v2.maxMeasuredEnd - continuationCursor} clip(s) sit past a hole and are not a depth`,
          );
        }
        const combination: PlannedCombination = {
          harness,
          bucket,
          modelId,
          pool,
          plan: planRange(
            continuationCursor,
            pool.consumable.length,
            flags.demand,
            flags.from ?? undefined,
          ),
        };
        planned.push(combination);
        plannedKeys.set(key, combination);
      }
    }
  }

  console.log(`--- Plan: ${describeDemand(flags.demand, flags.from)} ---`);
  let plannedHarness: string | null = null;
  for (const combination of planned) {
    if (flags.harnesses.length > 1 && combination.harness !== plannedHarness) {
      console.log(`  === Harness: ${combination.harness} ===`);
      plannedHarness = combination.harness;
    }
    console.log(
      `  ${formatPlanLine(combination.modelId, combination.pool.datasetKey, combination.plan)}`,
    );
  }

  const rewinds = planned.filter((p) => p.plan.rewind && p.plan.count > 0);
  if (rewinds.length > 0) {
    console.log(
      `\n  REWIND: ${rewinds.length} combination${rewinds.length === 1 ? " will re-measure clips it has" : "s will re-measure clips they have"} already been measured on. Nothing is deleted and no cursor moves backwards; the same clips are simply run again.`,
    );
  }

  const gaps = planned.filter((p) => p.plan.gap && p.plan.count > 0);
  if (gaps.length > 0) {
    console.log(
      `\n  GAP: ${gaps.length} combination${gaps.length === 1 ? "" : "s"} start past their cursor. The clips in between stay unmeasured and the cursor does not move over them - the depth this buys is coverage past a hole, not a deeper prefix.`,
    );
  }

  const clipsToRun = planned.reduce((total, p) => total + p.plan.count, 0);
  const combinationsToRun = planned.filter((p) => p.plan.count > 0).length;
  console.log(
    `\n  ${clipsToRun} clip${clipsToRun === 1 ? "" : "s"} to transcribe across ${combinationsToRun} combination${combinationsToRun === 1 ? "" : "s"}`,
  );
  const exhausted = planned.filter((p) => p.plan.truncated);
  if (exhausted.length > 0) {
    console.log(
      `  ${exhausted.length} combination${exhausted.length === 1 ? "" : "s"} will run short of what was asked for because the dataset is exhausted; the true depth is what gets recorded`,
    );
  }
  console.log("");

  // Step 5: Refuse to start over clips an unfinished run already owns.
  //
  // Blocked rather than merged, and named rather than guessed. Two processes measuring one
  // clip write two measurements of it, and the newest-wins rule in pooling would then
  // decide which one counts by timestamp - a coin flip dressed as a policy. The operator
  // has the information to choose, and the message hands them the run id to choose with.
  const allV2Stages = loadV2Stages(resultsDir());
  // Said out loud on the one path where the operator can still act on it. An unfinished
  // stage whose plan will not parse blocks nothing - `incompleteV2Stages` needs a plan to
  // intersect clip sets with, and pooling ignores an incomplete record entirely - so
  // without this line the run directory sits there unmentioned and unfinishable.
  for (const broken of unresumableV2Stages(allV2Stages)) {
    console.warn(
      `Warning: ${broken.runName}/${broken.stageId} is an unfinished Benchmark Run with no readable ${broken.plan === null ? "Run Plan" : "run record"}.`,
    );
    console.warn(
      "  It can be neither resumed nor pooled, and it does not block this run. Delete that run directory to tidy it up; nothing in it was ever written to stt.json.",
    );
  }
  const incomplete = incompleteV2Stages(allV2Stages);
  for (const combination of planned) {
    if (combination.plan.count === 0) continue;
    const datasetId = datasetIdFor(
      combination.pool.datasetType,
      combination.pool.datasetKey,
    );
    const compatible = incomplete
      .filter(
        (stage) =>
          stage.plan.datasetId === datasetId &&
          stage.plan.model === combination.modelId,
      )
      .map((stage) => ({
        runId: stage.runName,
        orderedClipIds: stage.plan.orderedClipIds,
      }));
    try {
      assertNoOverlappingIncompleteRun(
        {
          orderedClipIds: combination.pool.consumable
            .slice(combination.plan.startIndex, combination.plan.endIndex)
            .map((entry) => entry.clipId),
        },
        compatible,
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      console.error(
        `  Resume it with --resume <runId>, or delete that run directory to discard it. Nothing in an unfinished run was ever written to stt.json.`,
      );
      process.exit(1);
    }
  }

  if (flags.planOnly) {
    console.log(
      "--plan-only: nothing was transcribed and nothing was written.",
    );
    return;
  }

  if (clipsToRun === 0) {
    console.log(
      "Nothing to run: every selected Combination is already measured at this depth. Raise --samples, or --to a deeper target.",
    );
    return;
  }

  // Step 6: Download the models that actually have clips to run.
  if (!flags.skipDownload) {
    console.log("--- Downloading models ---");
    for (const modelId of flags.models) {
      const model = getSpeechModel(modelId);
      // Both single-file Engines download here: whisper.cpp GGML weights, and hviske
      // GGUF weights from their Mirror. Parakeet is the exception - it installs a
      // CoreML/ONNX bundle through the app, not a file this step can fetch.
      if (
        !model ||
        (model.engine !== "whisper_cpp" && model.engine !== "hviske")
      ) {
        console.log(
          `  [${modelId}] skipped (${model ? `engine ${model.engine} is not downloadable here` : "unknown model"})`,
        );
        continue;
      }
      // The cursor makes this exact rather than heuristic: a model with no clips left to
      // run in any selected dataset has nothing to download weights for.
      if (!planned.some((p) => p.modelId === modelId && p.plan.count > 0)) {
        console.log(
          `  [${modelId}] skipped (nothing left to measure in the selected datasets)`,
        );
        continue;
      }
      if (modelManager.isModelAvailable(modelId)) {
        console.log(`  [${modelId}] already available`);
        continue;
      }
      console.log(`  [${modelId}] downloading...`);
      await new Promise<void>((resolve, reject) => {
        modelManager.downloadModel(modelId, (_frac, done, error) => {
          if (done) {
            if (error) {
              console.log(`  [${modelId}] FAILED: ${error}`);
              reject(new Error(error));
            } else {
              console.log(`  [${modelId}] done`);
              resolve();
            }
          }
        });
      });
    }
    console.log("");
  }

  // Step 7: The run directory, and every Run Plan in it, written before the first clip.
  const runDir = makeRunDir(flags.name);
  const runName = runDir.slice(resultsDir().length + 1);
  const startedAt = new Date().toISOString();

  const stages: Stage[] = [];
  for (const combination of planned) {
    // A Combination with nothing to measure gets **no plan file and no record file**.
    // A zero-clip plan is a legal value in memory - it is the honest answer once a cursor
    // reaches the end of a pool - and an illegal one on disk, where it is
    // indistinguishable from a half-written file and has nothing to resume.
    // `assertRunPlanOnDisk` refuses one, so writing it would make the run unresumable.
    if (combination.plan.count === 0) {
      console.log(
        `  ${formatPlanLine(combination.modelId, combination.pool.datasetKey, combination.plan)} - skipped, no Run Plan written`,
      );
      continue;
    }
    const { pool, plan: rangePlan } = combination;
    const stageId = stageIdFor(
      pool.datasetKey,
      combination.bucket,
      combination.modelId,
    );
    const runPlan = buildRunPlan({
      runId: `${runName}/${stageId}`,
      ...(flags.batch === undefined ? {} : { batchId: flags.batch }),
      datasetId: datasetIdFor(pool.datasetType, pool.datasetKey),
      harness: CODICTATE_V2_HARNESS,
      model: combination.modelId,
      consumableClipIds: pool.consumable.map((entry) => entry.clipId),
      warmupClipIds: pool.warmups.map((entry) => entry.clipId),
      fromIndex: rangePlan.startIndex,
      toIndex: rangePlan.endIndex,
      createdAt: startedAt,
    });
    writeStagePlan(runDir, stageId, runPlan);
    stages.push({
      harness: combination.harness,
      bucket: combination.bucket,
      modelId: combination.modelId,
      pool,
      stageId,
      plan: runPlan,
      range: rangeOf(rangePlan, pool.fingerprint),
      recordedSamples: [],
      startedAt,
    });
    // An empty incomplete record beside every plan, so a resume can tell a Combination
    // nobody started from one that does not exist. Without it, a run killed before its
    // first clip would resume as a run with nothing to do and be filed as completed.
    writeStageRecord(
      runDir,
      stageId,
      stageRecord({
        runId: runPlan.runId,
        plan: runPlan,
        status: "incomplete",
        startedAt,
        completedAt: null,
        samples: [],
        description: flags.description,
      }),
    );
  }

  const store = {
    librispeech: {} as DatasetResults,
    fleurs: {} as DatasetResults,
  };
  saveCheckpoint(runDir, {
    harnesses: flags.harnesses,
    librispeech: store.librispeech,
    fleurs: store.fleurs,
    demand: flags.demand,
    description: flags.description,
  });

  // Step 8: Run benchmarks
  //
  // One pass over the plan printed above, in the order it was printed. Harness is the
  // outermost dimension of that order so every selected Harness transcribes the same
  // clips, which is what makes their WER and RTF comparable.
  //
  // One runnable Harness makes that a one-element dimension today, and it stays a
  // dimension on purpose. Harness is a domain dimension rather than a property of the
  // current binary (CONTEXT.md, docs/adr/0002), the result files and every read path are
  // permanently multi-Harness because the archive is, and the last Harness swap was
  // decided by exactly this loop running two of them over identical samples.
  console.log("--- Running benchmarks ---");
  await runStages(runDir, stages, flags, store, flags.harnesses, {
    demand: flags.demand,
    description: flags.description,
  });

  // Step 9: Offload models from disk
  if (flags.offloadModels) {
    console.log("\n--- Offloading models ---");
    for (const modelId of flags.models) {
      const deleted = modelManager.deleteModel(modelId);
      if (deleted) {
        console.log(`  [${modelId}] offloaded (deleted from disk)`);
      } else {
        console.log(`  [${modelId}] offload skipped (bundled or not found)`);
      }
    }
  }

  // Step 10: Write final results, report and charts
  await finishRun(
    runDir,
    runName,
    flags.description ?? "",
    store,
    flags.demand,
  );
}

// `import.meta.main` so the pure helpers above - the atomic write, the resume resolver,
// the stage paths - can be imported by `run-stt.test.ts` without the import starting a
// Benchmark Run.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
