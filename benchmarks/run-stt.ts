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
import { buildAllManifests } from "./scripts/build-manifests";
import { benchmarkModel, type PartialProgress } from "./stt/runner";
import {
  generateMarkdownReport,
  writeReport,
  type BenchmarkResults,
} from "./stt/report";
import {
  getCombinationResult,
  harnessBucketForModel,
  normalizeDatasetResults,
  setCombinationResult,
  type DatasetResults,
} from "./stt/results-schema";
import { LIBRISPEECH_SPLITS, isLibriSpeechSplit } from "./stt/datasets";
import { loadCoverage, isCombinationCovered } from "./stt/coverage";
import { promptBenchmarkPlan } from "./stt/tui";
import {
  DEFAULT_ASR_HARNESS,
  isAsrHarnessId,
  ASR_HARNESS_IDS,
  type AsrHarnessId,
} from "../src/shared/asr-harness";
import { SPEECH_MODEL_IDS, getSpeechModel } from "../src/shared/speech-models";
import { modelManager } from "../src/bun/utils/whisper/model-manager";

// -- Checkpoint types --

interface CheckpointData {
  harnesses: AsrHarnessId[];
  librispeech: DatasetResults;
  fleurs: DatasetResults;
  inProgress?: {
    /** Which Harness was mid-Combination, so a resume does not credit the wrong one. */
    harness: AsrHarnessId;
    modelId: string;
    datasetKey: string;
    datasetType: "librispeech" | "fleurs";
    partial: PartialProgress;
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
      ? raw.harnesses.filter(isAsrHarnessId)
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

function loadLatestResults(): BenchmarkResults | null {
  if (!existsSync(RESULTS_BASE_DIR)) return null;
  const runs = readdirSync(RESULTS_BASE_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const jsonPath = join(RESULTS_BASE_DIR, runs[i], "stt.json");
    if (existsSync(jsonPath)) {
      try {
        return readResultsFile(jsonPath);
      } catch {
        continue;
      }
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
    samples: 200,
    skipDownload: false,
    skipConvert: false,
    skipExisting: false,
    offloadModels: false,
    reportOnly: false,
    aggregate: false,
    noTui: false,
    name: undefined as string | undefined,
    description: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--harness": {
        // Comma-separated so CI can compare Harnesses in one run, same as the TUI.
        const values = args[++i].split(",");
        const unknown = values.filter((v) => !isAsrHarnessId(v));
        if (unknown.length > 0) {
          console.error(
            `Error: unknown --harness ${unknown.join(", ")}. Known: ${ASR_HARNESS_IDS.join(", ")}`,
          );
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
        const values = args[++i].split(",");
        const unknown = values.filter((v) => !isLibriSpeechSplit(v));
        if (unknown.length > 0) {
          console.error(
            `Error: unknown --splits ${unknown.join(", ")}. Known: ${LIBRISPEECH_SPLITS.join(", ")}`,
          );
          process.exit(1);
        }
        flags.splits = values;
        break;
      }
      case "--languages":
        flags.languages = args[++i].split(",");
        break;
      case "--samples":
        flags.samples = parseInt(args[++i], 10);
        break;
      case "--skip-download":
        flags.skipDownload = true;
        break;
      case "--skip-convert":
        flags.skipConvert = true;
        break;
      case "--skip-existing":
        flags.skipExisting = true;
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
      case "--description":
        flags.description = args[++i];
        break;
    }
  }
  return flags;
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
            if (!isAsrHarnessId(harness) || !byModel) continue;
            for (const [modelId, result] of Object.entries(byModel)) {
              if (result.utteranceCount > 0) {
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
    }

    const jsonPath = join(RESULTS_BASE_DIR, "stt.json");
    await Bun.write(jsonPath, JSON.stringify(merged, null, 2));
    console.log(`\nAggregated JSON written to ${jsonPath}`);

    await writeReport(merged, RESULTS_BASE_DIR, { noChunks: true });
    console.log("\n" + generateMarkdownReport(merged));
    return;
  }

  // Interactive setup, unless the caller drove everything with flags.
  const useTui = !flags.modelsExplicit && !flags.noTui;
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
    flags.samples = plan.samples;
    flags.name = plan.name;
    flags.description = plan.description;
  }

  console.log("=== Codictate STT Benchmark ===");
  if (flags.name) console.log(`Name: ${flags.name}`);
  console.log(`ASR harnesses: ${flags.harnesses.join(", ")}`);
  console.log(`Models: ${flags.models.join(", ")}`);
  console.log(`LibriSpeech splits: ${flags.splits.join(", ") || "none"}`);
  console.log(`FLEURS languages: ${flags.languages.join(", ") || "none"}`);
  console.log(`Samples: ${flags.samples}`);
  if (flags.skipExisting) console.log("Skip existing: ON");
  if (flags.offloadModels) console.log("Offload models: ON");
  console.log("");

  if (!flags.name) {
    console.error(
      "Error: --name is required. Used as URL slug for the benchmark page.",
    );
    console.error(
      "  Format: lowercase letters, numbers, and hyphens (e.g. tiny-base-triage)",
    );
    process.exit(1);
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flags.name)) {
    console.error(`Error: invalid name "${flags.name}".`);
    console.error(
      "  Must be lowercase, alphanumeric, separated by hyphens (e.g. tiny-base-triage)",
    );
    console.error(
      "  No uppercase, spaces, underscores, or leading/trailing hyphens.",
    );
    process.exit(1);
  }

  if (existsSync(RESULTS_BASE_DIR)) {
    const existing = readdirSync(RESULTS_BASE_DIR).find((d) =>
      d.endsWith(`_${flags.name}`),
    );
    if (existing) {
      console.error(
        `Error: name "${flags.name}" already used in ${existing}. Choose a unique name.`,
      );
      process.exit(1);
    }
  }

  if (!flags.description) {
    console.error(
      "Error: --description is required. Describe the goal of this benchmark run.",
    );
    process.exit(1);
  }

  // Step 1: Load previous results for --skip-existing
  const previousResults = flags.skipExisting ? loadLatestResults() : null;
  if (flags.skipExisting) {
    if (previousResults) {
      console.log("--- Loaded previous results for --skip-existing ---");
    } else {
      console.log(
        "--- No previous results found, --skip-existing has no effect ---",
      );
    }
    console.log("");
  }

  // A model is only skipped for download when every Combination it would run in
  // this harness is already covered at this depth.
  const coverage = loadCoverage(RESULTS_BASE_DIR);
  const plannedDatasetKeys = [...flags.splits, ...flags.languages];
  const skippedModels = new Set<string>();

  // Step 2: Download datasets
  if (!flags.skipDownload) {
    console.log("--- Downloading datasets ---");
    if (flags.splits.length > 0) await downloadLibriSpeech();
    if (flags.languages.length > 0) await downloadFleurs(flags.languages);
    console.log("");
  }

  // Step 3: Convert audio
  if (!flags.skipConvert && flags.splits.length > 0) {
    console.log("--- Converting audio ---");
    await convertLibriSpeech(DATASETS_DIR);
    console.log("");
  }

  // Step 4: Download models (skip fully-covered Combinations when --skip-existing)
  if (!flags.skipDownload) {
    console.log("--- Downloading models ---");
    for (const modelId of flags.models) {
      const model = getSpeechModel(modelId);
      if (!model || model.engine !== "whisper_cpp") {
        console.log(`  [${modelId}] skipped (not a whisper_cpp model)`);
        continue;
      }
      const buckets = [
        ...new Set(
          flags.harnesses.map((h) => harnessBucketForModel(modelId, h)),
        ),
      ];
      if (
        flags.skipExisting &&
        plannedDatasetKeys.length > 0 &&
        buckets.every((bucket) =>
          plannedDatasetKeys.every((datasetKey) =>
            isCombinationCovered(
              coverage,
              bucket,
              modelId,
              datasetKey,
              flags.samples,
            ),
          ),
        )
      ) {
        console.log(`  [${modelId}] skipped (already benchmarked)`);
        skippedModels.add(modelId);
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

  // Step 5: Build manifests
  console.log("--- Building manifests ---");
  const manifests = buildAllManifests(
    DATASETS_DIR,
    flags.languages,
    flags.samples,
    flags.splits,
  );
  console.log("");

  // Step 6: Set up run directory + checkpoint
  const existingRunDir = findIncompleteRun();
  const runDir = existingRunDir ?? makeRunDir(flags.name);
  const checkpoint = existingRunDir
    ? await loadCheckpoint(existingRunDir)
    : null;

  if (checkpoint) {
    console.log(`\n--- Resuming from checkpoint in ${existingRunDir} ---`);
    const sameHarnesses =
      checkpoint.harnesses.length === flags.harnesses.length &&
      checkpoint.harnesses.every((h) => flags.harnesses.includes(h));
    if (!sameHarnesses) {
      console.error(
        `Error: checkpoint in ${existingRunDir} was run under harness set "${checkpoint.harnesses.join(", ")}", not "${flags.harnesses.join(", ")}".`,
      );
      console.error(
        "  Finish or delete that run before starting one on another harness set.",
      );
      process.exit(1);
    }
  }

  const librispeechResults: DatasetResults = checkpoint?.librispeech ?? {};
  const fleursResults: DatasetResults = checkpoint?.fleurs ?? {};

  // Pre-fill results from previous run
  if (previousResults) {
    let prefilledCount = 0;
    for (const [field, store] of [
      ["librispeech", librispeechResults],
      ["fleurs", fleursResults],
    ] as const) {
      for (const [datasetKey, byHarness] of Object.entries(
        previousResults[field],
      )) {
        for (const [harness, byModel] of Object.entries(byHarness)) {
          if (!isAsrHarnessId(harness) || !byModel) continue;
          for (const [modelId, result] of Object.entries(byModel)) {
            if (
              flags.models.includes(modelId) &&
              result.utteranceCount > 0 &&
              getCombinationResult(store, datasetKey, harness, modelId) ===
                undefined
            ) {
              setCombinationResult(store, datasetKey, harness, modelId, result);
              prefilledCount++;
            }
          }
        }
      }
    }
    console.log(`  ${prefilledCount} benchmark combinations pre-filled`);
  }

  // Step 7: Run benchmarks
  console.log("--- Running benchmarks ---");

  function getPartial(
    harness: AsrHarnessId,
    type: "librispeech" | "fleurs",
    key: string,
    modelId: string,
  ): PartialProgress | undefined {
    const ip = checkpoint?.inProgress;
    if (
      ip &&
      ip.harness === harness &&
      ip.modelId === modelId &&
      ip.datasetType === type &&
      ip.datasetKey === key
    ) {
      return ip.partial;
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

  // Harness is the outer loop so every selected Harness transcribes the same sample
  // files, which is what makes their WER and RTF comparable.
  for (const harness of flags.harnesses) {
    if (flags.harnesses.length > 1) {
      console.log(`\n=== Harness: ${harness} ===`);
    }

    for (const modelId of flags.models) {
      console.log(`\n[${modelId} / ${harness}]`);
      const bucket = harnessBucketForModel(modelId, harness);
      if (bucket !== harness) {
        console.log(
          `  [${modelId}] recorded under "${bucket}": Parakeet runs through its own helper, so harness does not apply`,
        );
      }

      for (const [datasetType, datasetManifests, store, computeCer] of [
        [
          "librispeech" as const,
          manifests.librispeech,
          librispeechResults,
          false,
        ],
        ["fleurs" as const, manifests.fleurs, fleursResults, true],
      ] as const) {
        for (const [datasetKey, entries] of Object.entries(datasetManifests)) {
          const label =
            datasetType === "librispeech"
              ? `LibriSpeech ${datasetKey}`
              : `FLEURS ${datasetKey}`;

          if (
            getCombinationResult(store, datasetKey, bucket, modelId) !==
            undefined
          ) {
            console.log(`  [${modelId}] ${label}: skipped (already done)`);
            continue;
          }

          // Combination-level skipping, opt-in via --skip-existing. Coverage spans every
          // previous run, so this skips a Combination already recorded at least this deep
          // even if it came from an older run. Interactive runs never set this: the models
          // were hand-picked, so they run.
          if (
            flags.skipExisting &&
            isCombinationCovered(
              coverage,
              bucket,
              modelId,
              datasetKey,
              flags.samples,
            )
          ) {
            console.log(
              `  [${modelId}] ${label}: skipped (already benchmarked at >= ${flags.samples} samples)`,
            );
            continue;
          }

          const capped = entries.slice(0, flags.samples);
          const partial = getPartial(harness, datasetType, datasetKey, modelId);

          const result = await benchmarkModel(modelId, capped, label, {
            harness,
            partial,
            computeCer,
            onCheckpoint: (progress) => {
              void saveCheckpoint(
                runDir,
                checkpointData({
                  harness,
                  modelId,
                  datasetKey,
                  datasetType,
                  partial: progress,
                }),
              );
            },
          });

          setCombinationResult(store, datasetKey, bucket, modelId, result);
          void saveCheckpoint(runDir, checkpointData());
        }
      }
    }
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
  const results: BenchmarkResults = {
    description: flags.description,
    hardware: getHardwareInfo(),
    runDate: new Date().toISOString(),
    config: {
      sampleSize: flags.samples,
      warmupCount: 3,
      normalization: "whisper-basic",
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
