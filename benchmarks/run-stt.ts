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
import {
  benchmarkModel,
  type ModelDatasetResult,
  type PartialProgress,
} from "./stt/runner";
import {
  generateMarkdownReport,
  writeReport,
  type BenchmarkResults,
} from "./stt/report";
import { SPEECH_MODEL_IDS, getSpeechModel } from "../src/shared/speech-models";
import { modelManager } from "../src/bun/utils/whisper/model-manager";

// -- Checkpoint types --

interface CheckpointData {
  librispeech: Record<string, Record<string, ModelDatasetResult>>;
  fleurs: Record<string, Record<string, ModelDatasetResult>>;
  inProgress?: {
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
  return (await Bun.file(path).json()) as CheckpointData;
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

function isFullyCovered(
  prev: BenchmarkResults,
  modelId: string,
  languages: string[],
): boolean {
  const libriSplits = Object.keys(prev.librispeech);
  for (const split of libriSplits) {
    const r = prev.librispeech[split]?.[modelId];
    if (!r || r.utteranceCount === 0) return false;
  }
  for (const lang of languages) {
    const r = prev.fleurs[lang]?.[modelId];
    if (!r || r.utteranceCount === 0) return false;
  }
  return libriSplits.length > 0;
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
        return JSON.parse(readFileSync(jsonPath, "utf-8")) as BenchmarkResults;
      } catch {
        continue;
      }
    }
  }
  return null;
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

// -- CLI arg parsing --

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    models: SPEECH_MODEL_IDS as string[],
    languages: DEFAULT_FLEURS_LANGUAGES as string[],
    samples: 200,
    skipDownload: false,
    skipConvert: false,
    skipExisting: false,
    offloadModels: false,
    reportOnly: false,
    name: undefined as string | undefined,
    description: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--models":
        flags.models = args[++i].split(",");
        break;
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

  console.log("=== Codictate STT Benchmark ===");
  if (flags.name) console.log(`Name: ${flags.name}`);
  console.log(`Models: ${flags.models.join(", ")}`);
  console.log(`FLEURS languages: ${flags.languages.join(", ")}`);
  console.log(`Samples: ${flags.samples}`);
  if (flags.skipExisting) console.log("Skip existing: ON");
  if (flags.offloadModels) console.log("Offload models: ON");
  console.log("");

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
      const existing = (await Bun.file(jsonPath).json()) as BenchmarkResults;
      await writeReport(existing, runDir);
    }
    return;
  }

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
  const skippedModels = new Set<string>();
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

  // Step 2: Download datasets
  if (!flags.skipDownload) {
    console.log("--- Downloading datasets ---");
    await downloadLibriSpeech();
    await downloadFleurs(flags.languages);
    console.log("");
  }

  // Step 3: Convert audio
  if (!flags.skipConvert) {
    console.log("--- Converting audio ---");
    await convertLibriSpeech(DATASETS_DIR);
    console.log("");
  }

  // Step 4: Download models (skip fully-covered models when --skip-existing)
  if (!flags.skipDownload) {
    console.log("--- Downloading models ---");
    for (const modelId of flags.models) {
      const model = getSpeechModel(modelId);
      if (!model || model.engine !== "whisper_cpp") {
        console.log(`  [${modelId}] skipped (not a whisper_cpp model)`);
        continue;
      }
      if (
        previousResults &&
        isFullyCovered(previousResults, modelId, flags.languages)
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
  }

  const librispeechResults: Record<
    string,
    Record<string, ModelDatasetResult>
  > = checkpoint?.librispeech ?? {};
  const fleursResults: Record<
    string,
    Record<string, ModelDatasetResult>
  > = checkpoint?.fleurs ?? {};

  // Pre-fill results from previous run
  if (previousResults) {
    let skippedCount = 0;
    for (const [split, models] of Object.entries(previousResults.librispeech)) {
      for (const [modelId, result] of Object.entries(models)) {
        if (
          flags.models.includes(modelId) &&
          result.utteranceCount > 0 &&
          !librispeechResults[split]?.[modelId]
        ) {
          if (!librispeechResults[split]) librispeechResults[split] = {};
          librispeechResults[split][modelId] = result;
          skippedCount++;
        }
      }
    }
    for (const [lang, models] of Object.entries(previousResults.fleurs)) {
      for (const [modelId, result] of Object.entries(models)) {
        if (
          flags.models.includes(modelId) &&
          result.utteranceCount > 0 &&
          !fleursResults[lang]?.[modelId]
        ) {
          if (!fleursResults[lang]) fleursResults[lang] = {};
          fleursResults[lang][modelId] = result;
          skippedCount++;
        }
      }
    }
    console.log(`  ${skippedCount} model/dataset combinations pre-filled`);
  }

  // Step 7: Run benchmarks
  console.log("--- Running benchmarks ---");

  function isCompleted(
    type: "librispeech" | "fleurs",
    key: string,
    modelId: string,
  ): boolean {
    const store = type === "librispeech" ? librispeechResults : fleursResults;
    return store[key]?.[modelId] !== undefined;
  }

  function getPartial(
    type: "librispeech" | "fleurs",
    key: string,
    modelId: string,
  ): PartialProgress | undefined {
    const ip = checkpoint?.inProgress;
    if (
      ip &&
      ip.modelId === modelId &&
      ip.datasetType === type &&
      ip.datasetKey === key
    ) {
      return ip.partial;
    }
    return undefined;
  }

  for (const modelId of flags.models) {
    console.log(`\n[${modelId}]`);

    // LibriSpeech
    for (const [split, entries] of Object.entries(manifests.librispeech)) {
      if (isCompleted("librispeech", split, modelId)) {
        console.log(
          `  [${modelId}] LibriSpeech ${split}: skipped (already done)`,
        );
        continue;
      }
      if (!librispeechResults[split]) librispeechResults[split] = {};
      const capped = entries.slice(0, flags.samples);
      const partial = getPartial("librispeech", split, modelId);

      librispeechResults[split][modelId] = await benchmarkModel(
        modelId,
        capped,
        `LibriSpeech ${split}`,
        {
          partial,
          onCheckpoint: (progress) => {
            void saveCheckpoint(runDir, {
              librispeech: librispeechResults,
              fleurs: fleursResults,
              inProgress: {
                modelId,
                datasetKey: split,
                datasetType: "librispeech",
                partial: progress,
              },
            });
          },
        },
      );

      void saveCheckpoint(runDir, {
        librispeech: librispeechResults,
        fleurs: fleursResults,
      });
    }

    // FLEURS
    for (const [lang, entries] of Object.entries(manifests.fleurs)) {
      if (isCompleted("fleurs", lang, modelId)) {
        console.log(`  [${modelId}] FLEURS ${lang}: skipped (already done)`);
        continue;
      }
      if (!fleursResults[lang]) fleursResults[lang] = {};
      const capped = entries.slice(0, flags.samples);
      const partial = getPartial("fleurs", lang, modelId);

      fleursResults[lang][modelId] = await benchmarkModel(
        modelId,
        capped,
        `FLEURS ${lang}`,
        {
          partial,
          onCheckpoint: (progress) => {
            void saveCheckpoint(runDir, {
              librispeech: librispeechResults,
              fleurs: fleursResults,
              inProgress: {
                modelId,
                datasetKey: lang,
                datasetType: "fleurs",
                partial: progress,
              },
            });
          },
        },
      );

      void saveCheckpoint(runDir, {
        librispeech: librispeechResults,
        fleurs: fleursResults,
      });
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
