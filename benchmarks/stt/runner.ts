import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { RECORDING_PATH, MODELS_DIR } from "../../src/bun/platform/runtime";
import { fixBrandMishearings } from "../../src/bun/utils/whisper/speech2text";
import { getSpeechModel } from "../../src/shared/speech-models";
import { whisperCliLanguageArg } from "../../src/shared/transcription-languages";
import { findWhisperCliBinary } from "../../src/bun/utils/whisper/find-whisper-cli";
import { modelManager } from "../../src/bun/utils/whisper/model-manager";
import { getPlatform } from "../../src/bun/platform";
import { computeWer, type WerResult } from "./wer";
import { computeRtf } from "./rtf";
import { measurePeakRss } from "./memory";
import type { ManifestEntry } from "../scripts/build-manifests";

const WARMUP_COUNT = 3;
const MEMORY_SAMPLE_COUNT = 10;

const VENDORS_WHISPER_DIR = join(import.meta.dir, "../../vendors/whisper");

function resolveModelPath(modelId: string): string | null {
  const speech = getSpeechModel(modelId);
  if (!speech) return null;

  if (speech.engine === "whisperkit") {
    const dir = modelManager.getParakeetInstallDir(modelId);
    return existsSync(dir) ? dir : null;
  }

  // Check standard model manager path first
  const managerPath = modelManager.getModelPath(modelId);
  if (existsSync(managerPath)) return managerPath;

  // Fallback: models dir (for models downloaded via app)
  const modelsPath = join(MODELS_DIR, speech.artifactName);
  if (existsSync(modelsPath)) return modelsPath;

  // Fallback: vendors dir (bundled turbo model in dev)
  const vendorsPath = join(VENDORS_WHISPER_DIR, speech.artifactName);
  if (existsSync(vendorsPath)) return vendorsPath;

  return null;
}

export interface UtteranceResult {
  id: string;
  wallClockMs: number;
  wer: WerResult;
  hypothesis: string;
}

export interface PeakRSSStats {
  min: number;
  avg: number;
  max: number;
}

export interface ModelDatasetResult {
  wer: number;
  meanRTF: number;
  peakRSS_MB: PeakRSSStats | null;
  utteranceCount: number;
  totalAudioSec: number;
  totalWallSec: number;
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) chunks.push(value);
  }
  const len = chunks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function transcribeWhisper(
  modelPath: string,
  language: string,
): Promise<string> {
  const binary = await findWhisperCliBinary();
  const lang = whisperCliLanguageArg(language);
  const args = [
    binary,
    "-m",
    modelPath,
    "-t",
    String(Math.max(4, availableParallelism?.() ?? 4)),
    "--language",
    lang,
    "-f",
    RECORDING_PATH,
    "--no-prints",
    "-nt",
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
  });

  const stderrPromise = drainStream(proc.stderr);
  const stdoutPromise = drainStream(proc.stdout);
  await proc.exited;
  await stderrPromise;
  const stdoutBytes = await stdoutPromise;
  const raw = new TextDecoder("utf-8").decode(stdoutBytes).trim();
  return fixBrandMishearings(raw);
}

async function transcribeParakeet(modelPath: string): Promise<string> {
  const helper = getPlatform().findParakeetHelperBinary();
  const proc = Bun.spawn([helper, "transcribe", RECORDING_PATH, modelPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
  });

  const stderrPromise = drainStream(proc.stderr);
  const stdoutPromise = drainStream(proc.stdout);
  await proc.exited;
  await stderrPromise;
  const out = new TextDecoder("utf-8").decode(await stdoutPromise).trim();

  let text = "";
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as { kind?: string; text?: string };
      if (obj.kind === "final" && typeof obj.text === "string") {
        text = obj.text;
        break;
      }
    } catch {
      // ignore non-JSON
    }
  }
  return fixBrandMishearings(text.trim());
}

async function runUtterance(
  entry: ManifestEntry,
  modelId: string,
  modelPath: string,
): Promise<UtteranceResult> {
  copyFileSync(entry.audioPath, RECORDING_PATH);

  const speech = getSpeechModel(modelId)!;
  const start = performance.now();
  const hypothesis =
    speech.engine === "whisperkit"
      ? await transcribeParakeet(modelPath)
      : await transcribeWhisper(modelPath, entry.language);
  const wallClockMs = performance.now() - start;

  const wer = computeWer(entry.transcript, hypothesis);
  return { id: entry.id, wallClockMs, wer, hypothesis };
}

async function measureModelMemory(
  modelId: string,
  modelPath: string,
  sampleEntry: ManifestEntry,
): Promise<number | null> {
  const speech = getSpeechModel(modelId);
  if (!speech) return null;

  copyFileSync(sampleEntry.audioPath, RECORDING_PATH);

  let command: string[];

  if (speech.engine === "whisperkit") {
    const helper = getPlatform().findParakeetHelperBinary();
    command = [helper, "transcribe", RECORDING_PATH, modelPath];
  } else {
    const binary = await findWhisperCliBinary();
    command = [
      binary,
      "-m",
      modelPath,
      "-t",
      String(Math.max(4, availableParallelism?.() ?? 4)),
      "--language",
      "auto",
      "-f",
      RECORDING_PATH,
      "--no-prints",
      "-nt",
    ];
  }

  const result = await measurePeakRss(command);
  if (result.peakRssBytes !== null) {
    return Math.round(result.peakRssBytes / 1024 / 1024);
  }
  return null;
}

export async function benchmarkModel(
  modelId: string,
  entries: ManifestEntry[],
  datasetLabel: string,
): Promise<ModelDatasetResult> {
  const speech = getSpeechModel(modelId);
  if (!speech) {
    throw new Error(`Unknown model: ${modelId}`);
  }

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) {
    console.log(`  [skip] ${modelId} not found`);
    return {
      wer: -1,
      meanRTF: -1,
      peakRSS_MB: null,
      utteranceCount: 0,
      totalAudioSec: 0,
      totalWallSec: 0,
    };
  }

  console.log(
    `  [${modelId}] ${datasetLabel}: ${entries.length} utterances (${WARMUP_COUNT} warmup)`,
  );

  // Warmup
  const warmupEntries = entries.slice(0, WARMUP_COUNT);
  for (let i = 0; i < warmupEntries.length; i++) {
    await runUtterance(warmupEntries[i], modelId, modelPath);
    process.stdout.write(`    warmup ${i + 1}/${WARMUP_COUNT}\r`);
  }

  // Benchmark
  const benchEntries = entries.slice(WARMUP_COUNT);
  const results: UtteranceResult[] = [];
  let totalWer = 0;
  let totalRefWords = 0;
  let totalAudioSec = 0;
  let totalWallSec = 0;

  for (let i = 0; i < benchEntries.length; i++) {
    const entry = benchEntries[i];
    const result = await runUtterance(entry, modelId, modelPath);
    results.push(result);

    totalWer +=
      result.wer.substitutions + result.wer.insertions + result.wer.deletions;
    totalRefWords += result.wer.refWords;
    totalAudioSec += entry.audioDurationSec;
    totalWallSec += result.wallClockMs / 1000;

    if ((i + 1) % 50 === 0 || i === benchEntries.length - 1) {
      const currentWer = totalRefWords > 0 ? totalWer / totalRefWords : 0;
      console.log(
        `    ${i + 1}/${benchEntries.length} | WER: ${(currentWer * 100).toFixed(2)}% | RTF: ${computeRtf(totalWallSec, totalAudioSec).toFixed(3)}`,
      );
    }
  }

  // Memory measurement on small sample
  let peakRSS_MB: PeakRSSStats | null = null;
  if (benchEntries.length > 0) {
    console.log(`    measuring peak RSS ...`);
    const memSample = benchEntries.slice(0, MEMORY_SAMPLE_COUNT);
    const validResults: number[] = [];
    for (const entry of memSample) {
      const rss = await measureModelMemory(modelId, modelPath, entry);
      if (rss !== null) validResults.push(rss);
    }
    if (validResults.length > 0) {
      peakRSS_MB = {
        min: Math.min(...validResults),
        avg: Math.round(
          validResults.reduce((a, b) => a + b, 0) / validResults.length,
        ),
        max: Math.max(...validResults),
      };
    }
  }

  const aggWer = totalRefWords > 0 ? totalWer / totalRefWords : 0;
  const meanRTF = computeRtf(totalWallSec, totalAudioSec);

  console.log(
    `    done | WER: ${(aggWer * 100).toFixed(2)}% | RTF: ${meanRTF.toFixed(3)} | RSS: ${peakRSS_MB ? `${peakRSS_MB.min}/${peakRSS_MB.avg}/${peakRSS_MB.max}` : "N/A"} MB (min/avg/max)`,
  );

  return {
    wer: aggWer,
    meanRTF,
    peakRSS_MB,
    utteranceCount: benchEntries.length,
    totalAudioSec,
    totalWallSec,
  };
}
