import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODELS_DIR } from "../../src/bun/platform/runtime";
import {
  getSpeechModel,
  isHviskeSpeechModelId,
  HVISKE_TRANSCRIPTION_LANGUAGE_ID,
  PARAKEET_ENGINE_ID,
} from "../../src/shared/speech-models";
import {
  DEFAULT_ASR_HARNESS,
  HVISKE_ASR_HARNESS,
  HVISKE_CRISPASR_BACKEND,
  type AsrHarnessId,
} from "../../src/shared/asr-harness";
import { buildWhisperHarnessCommand } from "../../src/bun/utils/whisper/whisper-harness-command";
import { modelManager } from "../../src/bun/utils/whisper/model-manager";
import { parakeetTranscribeArgv } from "../../src/bun/utils/whisper/engines/parakeet-engine";
import { runTranscription } from "../../src/bun/utils/whisper/engines/run-transcription";
import type {
  FailedTranscription,
  TranscriptionRequest,
} from "../../src/bun/utils/whisper/engines/transcription";
import { getPlatform } from "../../src/bun/platform";
import { computeWer, computeCer, type WerResult } from "./wer";
import { computeRtf } from "./rtf";
import { measurePeakRss } from "./memory";
import type { ManifestEntry } from "../scripts/build-manifests";

/** Leading manifest entries transcribed but not scored, so the model is warm. */
const WARMUP_COUNT = 3;
const MEMORY_SAMPLE_COUNT = 10;

const VENDORS_WHISPER_DIR = join(import.meta.dir, "../../vendors/whisper");

function resolveModelPath(modelId: string): string | null {
  const speech = getSpeechModel(modelId);
  if (!speech) return null;

  if (speech.engine === PARAKEET_ENGINE_ID) {
    // `isModelAvailable`, not `existsSync`: the directory existing is not the same as the
    // weights being loadable. A half-populated directory used to pass this check and then
    // spend the whole Benchmark Run re-downloading, once per utterance.
    //
    // `reconcileInstalls` first, because the predicate is pure and the benchmark has no boot
    // sequence to have called it: without this, an install still under the old Parakeet
    // folder name reads as missing here.
    modelManager.reconcileInstalls();
    if (!modelManager.isModelAvailable(modelId)) return null;
    return modelManager.getParakeetInstallDir(modelId);
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
  /**
   * Reference words the WER was divided by, i.e. the denominator of this leaf.
   *
   * Without it a consumer cannot pool: averaging per-dataset WERs unweighted is a
   * different number from `sum(errors) / sum(referenceWords)`, and only the second one
   * is the accuracy of the combined sample. `wer * referenceWords` recovers the error
   * count, so any set of leaves can be re-pooled after the fact.
   *
   * Optional because it is a read type as well as a write type: the runs written before
   * this field existed have no denominator on disk and must still load. Every new run
   * sets it - see `CompletedModelDatasetResult`.
   */
  referenceWords?: number;
  cer?: number;
  /** Reference characters the CER was divided by. Absent wherever `cer` is absent. */
  referenceChars?: number;
  meanRTF: number;
  peakRSS_MB: PeakRSSStats | null;
  utteranceCount: number;
  totalAudioSec: number;
  totalWallSec: number;
}

/**
 * A result this build produces, as opposed to one it may read off disk.
 *
 * `referenceWords` is optional on the read type because the archive predates it, and
 * required here so that a new emit path which forgets the denominator fails `bun run
 * tsc` rather than quietly writing another unpoolable leaf.
 */
export type CompletedModelDatasetResult = ModelDatasetResult & {
  referenceWords: number;
};

/**
 * Mid-Combination state written to `checkpoint.json`, carrying running numerators and
 * denominators rather than derived rates. A resumed run adds to these and reports the
 * same `wer`, `referenceWords` and `meanRTF` an uninterrupted run would have, which a
 * checkpoint that stored only the rate so far could not do.
 */
export interface PartialProgress {
  utterancesDone: number;
  /** Word errors so far. Numerator of `wer`. */
  totalWer: number;
  /** Reference words so far. Denominator of `wer`, emitted as `referenceWords`. */
  totalRefWords: number;
  totalCer?: number;
  totalRefChars?: number;
  totalAudioSec: number;
  totalWallSec: number;
}

export type CheckpointCallback = (progress: PartialProgress) => void;

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
 * sends `--language da` (`buildDictationPlan` in `src/shared/dictation-plan.ts` decides
 * it once, per ADR-0005), so a benchmark that passed the dataset's own language would be
 * measuring an invocation no user can produce.
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

/**
 * One Speech Model invocation, as a Transcription Request.
 *
 * Built by hand, deliberately. AGENTS.md keeps the benchmark away from the Dictation Plan, a
 * settings read and the heal pass, so `transcriptionRequestFromPlan` is the app's door into
 * the Speech Engine Adapter and this is the benchmark's. Everything here comes from the
 * Benchmark Combination: the Speech Model, its resolved weights, and the Sample's own
 * language.
 *
 * The Request carries no ASR Harness because there is one (ADR-0002) and the adapter resolves
 * it. `harnessInvocationFor` is still asked, for the two things that do vary per Speech Model
 * - hviske's forced language and its forced crispasr backend - and if a second Harness is ever
 * added, the Harness belongs in the Request rather than back in a second argv builder here.
 */
function transcriptionRequestFor(
  modelId: string,
  modelPath: string,
  audioPath: string,
  harness: AsrHarnessId,
  language: string | null,
): TranscriptionRequest {
  const speech = getSpeechModel(modelId)!;

  if (speech.engine === PARAKEET_ENGINE_ID) {
    return {
      engineId: PARAKEET_ENGINE_ID,
      speechModelId: modelId,
      audioPath,
      modelDir: modelPath,
    };
  }

  const invocation = harnessInvocationFor(modelId, harness, language);
  return {
    engineId: speech.engine,
    speechModelId: modelId,
    audioPath,
    modelPath,
    languageCode: invocation.language,
    // No Benchmark Combination translates. WER is scored against a reference transcript in
    // the Sample's own language, so `-tr` would score English against Danish.
    translateToEnglish: false,
    crispasrBackend: invocation.crispasrBackend ?? null,
  };
}

/**
 * Say so when a Speech Engine fails, once per distinct failure.
 *
 * A failure used to be indistinguishable from silence: a non-zero exit returned stdout
 * anyway, the empty string scored as a 100% WER utterance, and the Benchmark Run finished
 * with plausible-looking numbers produced by an engine that never transcribed anything. The
 * Adapter now classifies that as a `failed` Result (ADR-0006), so this no longer reads exit
 * codes - but the utterance is still scored as an empty hypothesis, so the run still needs
 * somebody to say out loud that a number is not a measurement.
 *
 * The reason is printed rather than the Result's `message`: that sentence is written for the
 * four Dictation surfaces and talks about pasting, which no Benchmark Run does. The engine's
 * own stderr goes to the debug log from inside the adapter.
 *
 * Deduplicated because a broken engine fails identically on all 200 utterances, and 200
 * copies of one line buries the run's actual progress.
 */
const reportedTranscriptionFailures = new Set<string>();

function reportTranscriptionFailure(
  modelId: string,
  failure: FailedTranscription,
): void {
  const key = `${modelId}:${failure.reason}`;
  if (reportedTranscriptionFailures.has(key)) return;
  reportedTranscriptionFailures.add(key);
  console.error(
    `    [!] ${modelId}: ${failure.reason} - scored as an empty hypothesis`,
  );
  // The engine's own words. A Benchmark Run prints to a console with no debug logging on,
  // so without this the reason is all you get and a wedged Harness looks like a bad model.
  if (failure.diagnostic) console.error(`        ${failure.diagnostic}`);
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
  // dictated. Nothing on this path needs that path; a Transcription Request takes an
  // audioPath.
  const request = transcriptionRequestFor(
    modelId,
    modelPath,
    entry.audioPath,
    harness,
    entry.language,
  );

  const start = performance.now();
  const result = await runTranscription(request);
  const wallClockMs = performance.now() - start;

  if (result.status === "failed") reportTranscriptionFailure(modelId, result);
  const hypothesis = result.status === "ok" ? result.rawTranscript : "";

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

  if (speech.engine === PARAKEET_ENGINE_ID) {
    // The adapter's argv, not a second copy of it: peak RSS has to be measured on the
    // command the Benchmark Run actually transcribed with.
    command = parakeetTranscribeArgv(
      getPlatform().findParakeetHelperBinary(),
      sampleEntry.audioPath,
      modelPath,
    );
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
): Promise<CompletedModelDatasetResult> {
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
      referenceWords: 0,
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

  const result: CompletedModelDatasetResult = {
    wer: aggWer,
    referenceWords: totalRefWords,
    meanRTF,
    peakRSS_MB,
    utteranceCount: benchEntries.length,
    totalAudioSec,
    totalWallSec,
  };
  if (aggCer !== undefined) {
    result.cer = aggCer;
    result.referenceChars = totalRefChars;
  }
  return result;
}
