import { join } from "node:path";
import {
  mkdirSync,
  readdirSync,
  existsSync,
  unlinkSync,
  readFileSync,
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
import { benchmarkModel, type PartialProgress } from "./stt/runner";
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
  setCombinationResult,
  type BenchmarkHarnessLabel,
  type DatasetResults,
} from "./stt/results-schema";
import { LIBRISPEECH_SPLITS, isLibriSpeechSplit } from "./stt/datasets";
import { loadCoverage } from "./stt/coverage";
import {
  consumableEntries,
  cursorFor,
  fromIndexError,
  fromResumeRefusal,
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

async function saveCheckpoint(
  runDir: string,
  data: CheckpointData,
): Promise<void> {
  await Bun.write(join(runDir, CHECKPOINT_FILE), JSON.stringify(data, null, 2));
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
    inProgress: raw.inProgress,
  };
}

function deleteCheckpoint(runDir: string): void {
  const path = join(runDir, CHECKPOINT_FILE);
  if (existsSync(path)) unlinkSync(path);
}

function findIncompleteRun(): string | null {
  if (!existsSync(RESULTS_BASE_DIR)) return null;
  const runs = readdirSync(RESULTS_BASE_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const dir = join(RESULTS_BASE_DIR, runs[i]);
    if (
      existsSync(join(dir, CHECKPOINT_FILE)) &&
      !existsSync(join(dir, "stt.json"))
    ) {
      return dir;
    }
  }
  return null;
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
const RESULTS_BASE_DIR = join(import.meta.dir, "results");

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
  const dir = join(RESULTS_BASE_DIR, slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function existingRunNames(): string[] {
  if (!existsSync(RESULTS_BASE_DIR)) return [];
  const names: string[] = [];
  for (const dir of readdirSync(RESULTS_BASE_DIR)) {
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
    }
  }

  if (flags.from !== null && demandFlag === null) {
    console.error(
      `Error: --from needs a depth flag. --from N --samples M measures M clips starting at N; --from N --to M measures from N up to depth M. --from on its own names a start and no end, and falling back to the default --samples ${DEFAULT_SAMPLE_DELTA} would pick a depth nobody asked for on the one path that re-spends clips already measured.`,
    );
    process.exit(1);
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

async function main() {
  const flags = parseArgs();

  // Report-only mode: regenerate reports + charts for all runs
  if (flags.reportOnly) {
    const runs = readdirSync(RESULTS_BASE_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
      .sort();
    if (runs.length === 0) {
      console.error("No existing benchmark runs found in results/");
      process.exit(1);
    }
    for (const run of runs) {
      const runDir = join(RESULTS_BASE_DIR, run);
      const jsonPath = join(runDir, "stt.json");
      if (!existsSync(jsonPath)) continue;
      console.log(`\n--- Regenerating: ${run} ---`);
      await writeReport(readResultsFile(jsonPath), runDir);
    }
    return;
  }

  // Aggregate mode: merge all runs into a single report at results root
  if (flags.aggregate) {
    const runs = readdirSync(RESULTS_BASE_DIR)
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
      config: { sampleSize: 0, warmupCount: 3, normalization: "whisper-basic" },
      librispeech: {},
      fleurs: {},
    };

    for (const run of runs) {
      const jsonPath = join(RESULTS_BASE_DIR, run, "stt.json");
      if (!existsSync(jsonPath)) continue;
      const data = readResultsFile(jsonPath);
      console.log(`  merging: ${run}`);

      merged.config.sampleSize = Math.max(
        merged.config.sampleSize,
        data.config.sampleSize,
      );

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

    const jsonPath = join(RESULTS_BASE_DIR, "stt.json");
    await Bun.write(jsonPath, JSON.stringify(merged, null, 2));
    console.log(`\nAggregated JSON written to ${jsonPath}`);

    await writeReport(merged, RESULTS_BASE_DIR, { noChunks: true });
    console.log("\n" + generateMarkdownReport(merged));
    return;
  }

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

  // A resume already recorded the range it was measuring and carries the clips it
  // finished from that range; rewinding it to a different start would file those clips
  // against a range they do not belong to. Refused for --plan-only too: with a checkpoint
  // on disk the preview would describe a run that would not happen.
  const fromRefusal = fromResumeRefusal(flags.from, findIncompleteRun());
  if (fromRefusal) {
    for (const line of fromRefusal) console.error(line);
    process.exit(1);
  }

  if (useTui) {
    const plan = await promptBenchmarkPlan({
      coverage: loadCoverage(RESULTS_BASE_DIR),
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

  if (flags.name && existsSync(RESULTS_BASE_DIR)) {
    const sameName = readdirSync(RESULTS_BASE_DIR).filter((d) =>
      d.endsWith(`_${flags.name}`),
    );
    const finished = sameName.filter((d) =>
      existsSync(join(RESULTS_BASE_DIR, d, "stt.json")),
    );
    if (finished.length > 0) {
      console.error(
        `Error: name "${flags.name}" already used in ${finished[0]}. Choose a unique name.`,
      );
      process.exit(1);
    }
    // An unfinished run of this name is not a collision, it is this run. `--to N` is meant
    // to be safe to paste again after an interrupted overnight session, and refusing the
    // name it was interrupted under would make that impossible without renaming.
    if (sameName.length > 0) {
      console.log(
        `--- "${flags.name}" has an unfinished run (${sameName[0]}); this invocation will resume it ---\n`,
      );
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
  const manifests = buildAllManifests(
    DATASETS_DIR,
    flags.languages,
    flags.splits,
  );
  console.log("");

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
        fingerprint: manifestFingerprint(entries.map((entry) => entry.id)),
      });
    }
  }

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
      `  ${pool.datasetKey}: ${WARMUP_RESERVATION} reserved warmup + ${pool.consumable.length} consumable  [ordering ${pool.fingerprint}]`,
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
  const coverage = loadCoverage(RESULTS_BASE_DIR);
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

  // Step 4: Plan every Combination before a single clip runs.
  const plans: PlannedCombination[] = [];
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
        const planned: PlannedCombination = {
          harness,
          bucket,
          modelId,
          pool,
          plan: planRange(
            cursor,
            pool.consumable.length,
            flags.demand,
            flags.from ?? undefined,
          ),
        };
        plans.push(planned);
        plannedKeys.set(key, planned);
      }
    }
  }

  console.log(`--- Plan: ${describeDemand(flags.demand, flags.from)} ---`);
  let plannedHarness: string | null = null;
  for (const planned of plans) {
    if (flags.harnesses.length > 1 && planned.harness !== plannedHarness) {
      console.log(`  === Harness: ${planned.harness} ===`);
      plannedHarness = planned.harness;
    }
    console.log(
      `  ${formatPlanLine(planned.modelId, planned.pool.datasetKey, planned.plan)}`,
    );
  }

  const rewinds = plans.filter((p) => p.plan.rewind && p.plan.count > 0);
  if (rewinds.length > 0) {
    console.log(
      `\n  REWIND: ${rewinds.length} combination${rewinds.length === 1 ? " will re-measure clips it has" : "s will re-measure clips they have"} already been measured on. Nothing is deleted and no cursor moves backwards; the same clips are simply run again.`,
    );
  }

  const clipsToRun = plans.reduce((total, p) => total + p.plan.count, 0);
  const combinationsToRun = plans.filter((p) => p.plan.count > 0).length;
  console.log(
    `\n  ${clipsToRun} clip${clipsToRun === 1 ? "" : "s"} to transcribe across ${combinationsToRun} combination${combinationsToRun === 1 ? "" : "s"}`,
  );
  const exhausted = plans.filter((p) => p.plan.truncated);
  if (exhausted.length > 0) {
    console.log(
      `  ${exhausted.length} combination${exhausted.length === 1 ? "" : "s"} will run short of what was asked for because the dataset is exhausted; the true depth is what gets recorded`,
    );
  }
  console.log("");

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

  // Step 5: Download the models that actually have clips to run.
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
      if (!plans.some((p) => p.modelId === modelId && p.plan.count > 0)) {
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

  // Step 6: Set up run directory + checkpoint
  const existingRunDir = findIncompleteRun();
  const runDir = existingRunDir ?? makeRunDir(flags.name);
  const checkpoint = existingRunDir
    ? await loadCheckpoint(existingRunDir)
    : null;

  if (checkpoint) {
    console.log(`\n--- Resuming from checkpoint in ${existingRunDir} ---`);
    // Comparing an archived label set against a runnable one is exactly the check that
    // has to survive a retirement: a checkpoint left mid-run by whisper-cli must be
    // refused by name, not read as an empty set and resumed under crispasr, which
    // would file crispasr numbers next to whisper-cli ones in the same run.
    const sameHarnesses =
      checkpoint.harnesses.length === flags.harnesses.length &&
      checkpoint.harnesses.every((h) =>
        (flags.harnesses as readonly string[]).includes(h),
      );
    if (!sameHarnesses) {
      console.error(
        `Error: checkpoint in ${existingRunDir} was run under harness set "${checkpoint.harnesses.join(", ")}", not "${flags.harnesses.join(", ")}".`,
      );
      const retired = checkpoint.harnesses.filter((h) => !isAsrHarnessId(h));
      if (retired.length > 0) {
        console.error(
          `  ${retired.join(", ")} is retired, so that run can never be finished. Delete ${existingRunDir} to start fresh; its partial results were never written to stt.json.`,
        );
      } else {
        console.error(
          "  Finish or delete that run before starting one on another harness set.",
        );
      }
      process.exit(1);
    }
  }

  const librispeechResults: DatasetResults = checkpoint?.librispeech ?? {};
  const fleursResults: DatasetResults = checkpoint?.fleurs ?? {};

  // Step 7: Run benchmarks
  console.log("--- Running benchmarks ---");

  function inProgressFor(
    planned: PlannedCombination,
  ): NonNullable<CheckpointData["inProgress"]> | undefined {
    const ip = checkpoint?.inProgress;
    if (
      ip &&
      ip.harness === planned.harness &&
      ip.modelId === planned.modelId &&
      ip.datasetType === planned.pool.datasetType &&
      ip.datasetKey === planned.pool.datasetKey
    ) {
      return ip;
    }
    return undefined;
  }

  function checkpointData(
    inProgress?: CheckpointData["inProgress"],
  ): CheckpointData {
    return {
      harnesses: flags.harnesses,
      librispeech: librispeechResults,
      fleurs: fleursResults,
      inProgress,
    };
  }

  // One pass over the plan printed above, in the order it was printed. Harness is the
  // outermost dimension of that order so every selected Harness transcribes the same
  // clips, which is what makes their WER and RTF comparable.
  //
  // One runnable Harness makes that a one-element dimension today, and it stays a
  // dimension on purpose. Harness is a domain dimension rather than a property of the
  // current binary (CONTEXT.md, docs/adr/0002), the result files and every read path are
  // permanently multi-Harness because the archive is, and the last Harness swap was
  // decided by exactly this loop running two of them over identical samples. Keeping the
  // plan single-valued while the reads stay multi-valued would mean maintaining two
  // mental models of the same dimension.
  let runningHarness: string | null = null;
  let runningModel: string | null = null;

  for (const planned of plans) {
    const { harness, bucket, modelId, pool, plan } = planned;

    if (harness !== runningHarness) {
      if (flags.harnesses.length > 1) {
        console.log(`\n=== Harness: ${harness} ===`);
      }
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

    const store =
      pool.datasetType === "librispeech" ? librispeechResults : fleursResults;
    // CER is scored for FLEURS only: LibriSpeech's reference transcripts are already
    // normalised upper-case ASCII, so a character rate over them measures nothing.
    const computeCer = pool.datasetType === "fleurs";

    if (
      getCombinationResult(store, pool.datasetKey, bucket, modelId) !==
      undefined
    ) {
      console.log(`  [${modelId}] ${pool.label}: skipped (already done)`);
      continue;
    }

    // Exhaustion and "already at that depth" are the same case here: nothing to
    // transcribe, so say which one it was and move on to the next dataset rather than
    // throwing and abandoning the models further down the plan.
    if (plan.count === 0) {
      console.log(
        `  ${formatPlanLine(modelId, pool.datasetKey, plan)} - skipped`,
      );
      continue;
    }

    const inProgress = inProgressFor(planned);
    let range = rangeOf(plan, pool.fingerprint);
    const recorded = inProgress?.range;
    if (recorded) {
      // A resume finishes the range that was interrupted. Recomputing one from the cursor
      // would be right only by luck: the cursor cannot see this unfinished run, so a
      // resume with different flags would silently re-slice and file the partial numerator
      // it carries against clips it never transcribed.
      if (recorded.manifestFingerprint !== pool.fingerprint) {
        console.error(
          `Error: the checkpoint in ${runDir} was measuring ${pool.datasetKey} under ordering ${recorded.manifestFingerprint}, but the manifest on disk is ${pool.fingerprint}.`,
        );
        console.error(
          "  Its partial progress counts clips from a list that no longer exists. Delete that run directory to start fresh; nothing in it was ever written to stt.json.",
        );
        process.exit(1);
      }
      if (
        recorded.startIndex !== range.startIndex ||
        recorded.endIndex !== range.endIndex
      ) {
        console.log(
          `  [${modelId}] ${pool.label}: resuming the checkpoint's range ${recorded.startIndex}-${recorded.endIndex} rather than the planned ${range.startIndex}-${range.endIndex}`,
        );
        range = recorded;
      }
    }

    // Reserved warmups first, then the planned range. The warmups are replayed every
    // session and never scored, so they are prepended rather than taken off the head of
    // the range - taking them from the range is what used to burn three fresh clips per
    // session. Durations are measured only for the clips this call transcribes.
    const clips: ManifestEntry[] = hydrateDurations([
      ...pool.warmups,
      ...pool.consumable.slice(range.startIndex, range.endIndex),
    ]);

    const result = await benchmarkModel(modelId, clips, pool.label, {
      harness,
      range,
      partial: inProgress?.partial,
      computeCer,
      onCheckpoint: (progress) => {
        void saveCheckpoint(
          runDir,
          checkpointData({
            harness,
            modelId,
            datasetKey: pool.datasetKey,
            datasetType: pool.datasetType,
            partial: progress,
            range,
          }),
        );
      },
    });

    setCombinationResult(store, pool.datasetKey, bucket, modelId, result);
    void saveCheckpoint(runDir, checkpointData());
  }

  // Step 8: Offload models from disk
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

  // Step 9: Write final results
  //
  // `sampleSize` is the deepest cursor this run reached, not what any flag asked for.
  // With a delta it is the depth the leaves now sit at, which is what the report's
  // "samples per dataset" line has always meant; the flag itself is recorded beside it,
  // because a delta and a target can produce the same depth from different intents.
  const results: BenchmarkResults = {
    description: flags.description ?? "",
    hardware: getHardwareInfo(),
    runDate: new Date().toISOString(),
    config: {
      sampleSize: Math.max(0, ...plans.map((planned) => planned.plan.endIndex)),
      warmupCount: WARMUP_RESERVATION,
      normalization: "whisper-basic",
      sampleSelection:
        flags.demand.mode === "delta"
          ? { mode: "delta", requested: flags.demand.count }
          : { mode: "target", requested: flags.demand.depth },
    },
    librispeech: librispeechResults,
    fleurs: fleursResults,
  };

  const jsonPath = join(runDir, "stt.json");
  await Bun.write(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nJSON written to ${jsonPath}`);

  // Step 10: Delete checkpoint (run complete)
  deleteCheckpoint(runDir);

  // Step 11: Write report + charts to run folder
  await writeReport(results, runDir);

  console.log("\n" + generateMarkdownReport(results));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
