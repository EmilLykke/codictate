import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODELS_DIR } from "../../src/bun/platform/runtime";
import { fixBrandMishearings } from "../../src/bun/utils/whisper/speech2text";
import {
  getSpeechModel,
  isHviskeSpeechModelId,
  HVISKE_TRANSCRIPTION_LANGUAGE_ID,
} from "../../src/shared/speech-models";
import {
  DEFAULT_ASR_HARNESS,
  HVISKE_ASR_HARNESS,
  HVISKE_CRISPASR_BACKEND,
  type AsrHarnessId,
} from "../../src/shared/asr-harness";
import { buildWhisperHarnessCommand } from "../../src/bun/utils/whisper/whisper-harness-command";
import { modelManager } from "../../src/bun/utils/whisper/model-manager";
import { getPlatform } from "../../src/bun/platform";
import { computeWer, computeCer, type WerResult } from "./wer";
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
  cer?: number;
  meanRTF: number;
  peakRSS_MB: PeakRSSStats | null;
  utteranceCount: number;
  totalAudioSec: number;
  totalWallSec: number;
}

export interface PartialProgress {
  utterancesDone: number;
  totalWer: number;
  totalRefWords: number;
  totalCer?: number;
  totalRefChars?: number;
  totalAudioSec: number;
  totalWallSec: number;
}

export type CheckpointCallback = (progress: PartialProgress) => void;

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

/**
 * How to invoke one Speech Model: which Harness, which crispasr backend, which
 * language.
 *
 * hviske GGUF weights load only under crispasr's cohere backend, so they ignore the
 * run's selected Harness rather than being silently transcribed by the wrong one and
 * reported as an hviske result. `harnessBucketForModel` files their results under the
 * same forced Harness, so what the report says produced a number is what produced it.
 *
 * Language is pinned for the same reason. hviske is Danish-only and the app always
 * sends `--language da` (see `speech2text.ts`), so a benchmark that passed the
 * dataset's own language would be measuring an invocation no user can produce.
 */
function harnessInvocationFor(
  modelId: string,
  harness: AsrHarnessId,
  language: string | null,
): {
  harness: AsrHarnessId;
  language: string | null;
  crispasrBackend?: typeof HVISKE_CRISPASR_BACKEND;
} {
  if (isHviskeSpeechModelId(modelId)) {
    return {
      harness: HVISKE_ASR_HARNESS,
      language: HVISKE_TRANSCRIPTION_LANGUAGE_ID,
      crispasrBackend: HVISKE_CRISPASR_BACKEND,
    };
  }
  return { harness, language };
}

async function transcribeWhisper(
  modelPath: string,
  audioPath: string,
  language: string,
  harness: AsrHarnessId,
  modelId: string,
): Promise<string> {
  const { argv } = await buildWhisperHarnessCommand({
    ...harnessInvocationFor(modelId, harness, language),
    modelPath,
    audioPath,
  });

  const proc = Bun.spawn(argv, {
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

async function transcribeParakeet(
  modelPath: string,
  audioPath: string,
): Promise<string> {
  const helper = getPlatform().findParakeetHelperBinary();
  const proc = Bun.spawn([helper, "transcribe", audioPath, modelPath], {
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
  harness: AsrHarnessId,
): Promise<UtteranceResult> {
  // The Sample is read where it already lives. It used to be copied over RECORDING_PATH,
  // the app's own recording buffer, roughly 200 times per Benchmark Combination - so a
  // Benchmark Run alongside a running Codictate clobbered whatever the user had just
  // dictated. Nothing on this path needs that path; the Harness command takes an audioPath.
  const speech = getSpeechModel(modelId)!;
  const start = performance.now();
  const hypothesis =
    speech.engine === "whisperkit"
      ? await transcribeParakeet(modelPath, entry.audioPath)
      : await transcribeWhisper(
          modelPath,
          entry.audioPath,
          entry.language,
          harness,
          modelId,
        );
  const wallClockMs = performance.now() - start;

  const wer = computeWer(entry.transcript, hypothesis);
  return { id: entry.id, wallClockMs, wer, hypothesis };
}

async function measureModelMemory(
  modelId: string,
  modelPath: string,
  sampleEntry: ManifestEntry,
  harness: AsrHarnessId,
): Promise<number | null> {
  const speech = getSpeechModel(modelId);
  if (!speech) return null;

  let command: string[];

  if (speech.engine === "whisperkit") {
    const helper = getPlatform().findParakeetHelperBinary();
    command = [helper, "transcribe", sampleEntry.audioPath, modelPath];
  } else {
    command = (
      await buildWhisperHarnessCommand({
        ...harnessInvocationFor(modelId, harness, null),
        modelPath,
        audioPath: sampleEntry.audioPath,
      })
    ).argv;
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
  options?: {
    partial?: PartialProgress;
    onCheckpoint?: CheckpointCallback;
    computeCer?: boolean;
    /**
     * ASR Harness to run Whisper models under. Ignored for Parakeet, which has
     * only its own helper.
     */
    harness?: AsrHarnessId;
  },
): Promise<ModelDatasetResult> {
  const harness = options?.harness ?? DEFAULT_ASR_HARNESS;
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

  const partial = options?.partial;
  const onCheckpoint = options?.onCheckpoint;
  const startOffset = partial?.utterancesDone ?? 0;

  const benchEntries = entries.slice(WARMUP_COUNT);

  if (startOffset > 0) {
    console.log(
      `  [${modelId}] ${datasetLabel}: resuming from utterance ${startOffset}/${benchEntries.length}`,
    );
  } else {
    console.log(
      `  [${modelId}] ${datasetLabel}: ${entries.length} utterances (${WARMUP_COUNT} warmup)`,
    );
  }

  // Warmup (skip if resuming)
  if (startOffset === 0) {
    const warmupEntries = entries.slice(0, WARMUP_COUNT);
    for (let i = 0; i < warmupEntries.length; i++) {
      await runUtterance(warmupEntries[i], modelId, modelPath, harness);
      process.stdout.write(`    warmup ${i + 1}/${WARMUP_COUNT}\r`);
    }
  }

  // Benchmark
  const shouldComputeCer = options?.computeCer ?? false;
  const results: UtteranceResult[] = [];
  let totalWer = partial?.totalWer ?? 0;
  let totalRefWords = partial?.totalRefWords ?? 0;
  let totalCerErrors = partial?.totalCer ?? 0;
  let totalRefChars = partial?.totalRefChars ?? 0;
  let totalAudioSec = partial?.totalAudioSec ?? 0;
  let totalWallSec = partial?.totalWallSec ?? 0;

  for (let i = startOffset; i < benchEntries.length; i++) {
    const entry = benchEntries[i];
    const result = await runUtterance(entry, modelId, modelPath, harness);
    results.push(result);

    totalWer +=
      result.wer.substitutions + result.wer.insertions + result.wer.deletions;
    totalRefWords += result.wer.refWords;
    totalAudioSec += entry.audioDurationSec;
    totalWallSec += result.wallClockMs / 1000;

    if (shouldComputeCer && entry.rawTranscript) {
      const cer = computeCer(entry.rawTranscript, result.hypothesis);
      totalCerErrors += cer.substitutions + cer.insertions + cer.deletions;
      totalRefChars += cer.refChars;
    }

    if ((i + 1) % 50 === 0 || i === benchEntries.length - 1) {
      const currentWer = totalRefWords > 0 ? totalWer / totalRefWords : 0;
      const cerStr =
        shouldComputeCer && totalRefChars > 0
          ? ` | CER: ${((totalCerErrors / totalRefChars) * 100).toFixed(2)}%`
          : "";
      console.log(
        `    ${i + 1}/${benchEntries.length} | WER: ${(currentWer * 100).toFixed(2)}%${cerStr} | RTF: ${computeRtf(totalWallSec, totalAudioSec).toFixed(3)}`,
      );

      onCheckpoint?.({
        utterancesDone: i + 1,
        totalWer,
        totalRefWords,
        totalCer: shouldComputeCer ? totalCerErrors : undefined,
        totalRefChars: shouldComputeCer ? totalRefChars : undefined,
        totalAudioSec,
        totalWallSec,
      });
    }
  }

  // Memory measurement on small sample
  let peakRSS_MB: PeakRSSStats | null = null;
  if (benchEntries.length > 0) {
    console.log(`    measuring peak RSS ...`);
    const memSample = benchEntries.slice(0, MEMORY_SAMPLE_COUNT);
    const validResults: number[] = [];
    for (const entry of memSample) {
      const rss = await measureModelMemory(modelId, modelPath, entry, harness);
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
  const aggCer =
    shouldComputeCer && totalRefChars > 0
      ? totalCerErrors / totalRefChars
      : undefined;
  const meanRTF = computeRtf(totalWallSec, totalAudioSec);

  const cerStr =
    aggCer !== undefined ? ` | CER: ${(aggCer * 100).toFixed(2)}%` : "";
  console.log(
    `    done | WER: ${(aggWer * 100).toFixed(2)}%${cerStr} | RTF: ${meanRTF.toFixed(3)} | RSS: ${peakRSS_MB ? `${peakRSS_MB.min}/${peakRSS_MB.avg}/${peakRSS_MB.max}` : "N/A"} MB (min/avg/max)`,
  );

  const result: ModelDatasetResult = {
    wer: aggWer,
    meanRTF,
    peakRSS_MB,
    utteranceCount: benchEntries.length,
    totalAudioSec,
    totalWallSec,
  };
  if (aggCer !== undefined) result.cer = aggCer;
  return result;
}
