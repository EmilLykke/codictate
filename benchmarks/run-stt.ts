import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { downloadLibriSpeech } from "./scripts/download-librispeech";
import {
  downloadFleurs,
  DEFAULT_FLEURS_LANGUAGES,
} from "./scripts/download-fleurs";
import { convertLibriSpeech } from "./scripts/convert-audio";
import { buildAllManifests } from "./scripts/build-manifests";
import { benchmarkModel, type ModelDatasetResult } from "./stt/runner";
import {
  generateMarkdownReport,
  writeReport,
  type BenchmarkResults,
} from "./stt/report";
import { SPEECH_MODEL_IDS } from "../src/shared/speech-models";

const DATASETS_DIR = join(import.meta.dir, "datasets");
const RESULTS_DIR = join(import.meta.dir, "results");

// -- CLI arg parsing --

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    models: SPEECH_MODEL_IDS as string[],
    languages: DEFAULT_FLEURS_LANGUAGES as string[],
    sampleSize: 200,
    maxSamples: Infinity,
    skipDownload: false,
    skipConvert: false,
    reportOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--models":
        flags.models = args[++i].split(",");
        break;
      case "--languages":
        flags.languages = args[++i].split(",");
        break;
      case "--sample-size":
        flags.sampleSize = parseInt(args[++i], 10);
        break;
      case "--samples":
        flags.maxSamples = parseInt(args[++i], 10);
        break;
      case "--skip-download":
        flags.skipDownload = true;
        break;
      case "--skip-convert":
        flags.skipConvert = true;
        break;
      case "--report-only":
        flags.reportOnly = true;
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
  console.log(`Models: ${flags.models.join(", ")}`);
  console.log(`FLEURS languages: ${flags.languages.join(", ")}`);
  console.log(`Sample size: ${flags.sampleSize}`);
  if (flags.maxSamples < Infinity) {
    console.log(`Max samples per scenario: ${flags.maxSamples}`);
  }
  console.log("");

  // Report-only mode: regenerate from existing JSON
  if (flags.reportOnly) {
    const jsonPath = join(RESULTS_DIR, "stt.json");
    const existing = (await Bun.file(jsonPath).json()) as BenchmarkResults;
    await writeReport(existing, RESULTS_DIR);
    console.log("\n" + generateMarkdownReport(existing));
    return;
  }

  // Step 1: Download datasets
  if (!flags.skipDownload) {
    console.log("--- Downloading datasets ---");
    await downloadLibriSpeech();
    await downloadFleurs(flags.languages);
    console.log("");
  }

  // Step 2: Convert audio
  if (!flags.skipConvert) {
    console.log("--- Converting audio ---");
    await convertLibriSpeech(DATASETS_DIR);
    console.log("");
  }

  // Step 3: Build manifests
  console.log("--- Building manifests ---");
  const manifests = buildAllManifests(
    DATASETS_DIR,
    flags.languages,
    flags.sampleSize,
  );
  console.log("");

  // Step 4: Run benchmarks
  console.log("--- Running benchmarks ---");
  const librispeechResults: Record<
    string,
    Record<string, ModelDatasetResult>
  > = {};
  const fleursResults: Record<string, Record<string, ModelDatasetResult>> = {};

  for (const modelId of flags.models) {
    console.log(`\n[${modelId}]`);

    // LibriSpeech
    for (const [split, entries] of Object.entries(manifests.librispeech)) {
      if (!librispeechResults[split]) librispeechResults[split] = {};
      const capped = entries.slice(0, flags.maxSamples);
      librispeechResults[split][modelId] = await benchmarkModel(
        modelId,
        capped,
        `LibriSpeech ${split}`,
      );
    }

    // FLEURS
    for (const [lang, entries] of Object.entries(manifests.fleurs)) {
      if (!fleursResults[lang]) fleursResults[lang] = {};
      const capped = entries.slice(0, flags.maxSamples);
      fleursResults[lang][modelId] = await benchmarkModel(
        modelId,
        capped,
        `FLEURS ${lang}`,
      );
    }
  }

  // Step 5: Write results
  mkdirSync(RESULTS_DIR, { recursive: true });

  const results: BenchmarkResults = {
    hardware: getHardwareInfo(),
    runDate: new Date().toISOString(),
    config: {
      sampleSize: flags.sampleSize,
      warmupCount: 3,
      normalization: "whisper-basic",
    },
    librispeech: librispeechResults,
    fleurs: fleursResults,
  };

  const jsonPath = join(RESULTS_DIR, "stt.json");
  await Bun.write(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nJSON written to ${jsonPath}`);

  // Step 6: Write report + charts
  await writeReport(results, RESULTS_DIR);
  console.log("\n" + generateMarkdownReport(results));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
