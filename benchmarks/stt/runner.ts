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
  TranscriptionResult,
} from "../../src/bun/utils/whisper/engines/transcription";
import { getPlatform } from "../../src/bun/platform";
import { computeWer, computeCer, type WerResult } from "./wer";
import { computeRtf } from "./rtf";
import { measurePeakRss } from "./memory";
import type { ManifestEntry } from "../scripts/build-manifests";
import { WARMUP_RESERVATION, type SampleRange } from "./sample-cursor";

/**
 * Leading entries of the array handed to `benchmarkModel` that are transcribed but not
 * scored, so the model is warm.
 *
 * The same constant the cursor reserves at the head of every dataset's ordered manifest,
 * because they are the same three clips: the caller prepends the reserved warmups to the
 * range it planned, so "the first three entries of this array" and "the permanently
 * reserved warmup pool" must not be able to drift apart.
 */
const WARMUP_COUNT = WARMUP_RESERVATION;
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
  /**
   * Whether this utterance was a warmup, i.e. transcribed only so the model is warm and
   * excluded from every published number.
   *
   * Carried on the result rather than left implicit in which loop produced it, so that
   * the one place which decides what a warmup is excluded from - `countTranscriptionFailures`
   * - is a function over data instead of a property of control flow.
   */
  warmup: boolean;
  /**
   * How the transcription ended.
   *
   * Kept rather than dropped because a `failed` utterance is still scored, as an empty
   * hypothesis, and is therefore indistinguishable from a badly transcribed one once only
   * the rate survives. `benchmarkModel` counts these into the leaf's `failures`; without
   * the status here that count could not be taken at all.
   */
  status: TranscriptionResult["status"];
  wallClockMs: number;
  wer: WerResult;
  hypothesis: string;
}

/**
 * Scored utterances the Speech Engine returned nothing usable for.
 *
 * Warmups are filtered here for the same reason they are excluded from WER: they are
 * transcribed to warm the model and are not part of the sample being reported on. A
 * warmup that fails is a fact about the first three clips, not about the measurement.
 *
 * Not derivable downstream from anything else the leaf publishes: a failed utterance is
 * scored as an empty hypothesis, so it is still inside `utteranceCount` and still inside
 * the WER numerator. Emitting the count is the only way a consumer can disclose it.
 */
export function countTranscriptionFailures(
  results: readonly UtteranceResult[],
): number {
  return results.filter((result) => !result.warmup && result.status !== "ok")
    .length;
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
  /**
   * Which consumable entries of the dataset's ordered manifest this leaf measured, and the
   * ordering those offsets index into.
   *
   * The whole point of recording it: `--samples N` means "N clips this Speech Model has not
   * been measured on before", and the cursor that makes that possible is derived by taking
   * the deepest `endIndex` across every run whose `manifestFingerprint` matches the manifest
   * on disk. A leaf without this field contributes nothing to any cursor.
   *
   * Optional because it is a read type as well as a write type. The archive predates it, and
   * `scripts/backfill-sample-ranges.ts` deliberately refuses to fill it in for the three
   * pre-d8b91ee runs' LibriSpeech leaves - those were scored in filesystem-traversal order,
   * so their `utteranceCount` maps to no offset in the seeded ordering. Absent has to keep
   * meaning "position unknown"; every new run sets it, see `CompletedModelDatasetResult`.
   */
  sampleRange?: SampleRange;
  /**
   * Scored utterances whose transcription failed, and which were therefore scored as an
   * empty hypothesis rather than dropped.
   *
   * Published because it cannot be reconstructed: a failure is counted in
   * `utteranceCount` and folded into `wer` exactly like a real 100%-error utterance, so a
   * leaf that omits this number reports an engine that produced nothing as an engine that
   * transcribed badly. `dictation-product-benchmark` emits the same field under the same
   * name on its external-product leaf, so a head-to-head table can print both columns.
   *
   * No `failuresByStatus` breakdown alongside it, unlike that repo. A
   * `TranscriptionResult` here is `ok` or `failed` and nothing else (ADR-0006), so a
   * breakdown could only ever be `{ timeout: 0, failed: n }` - a zero that states a fact
   * about this union rather than about the run, and which reads as "we never timed out"
   * when the truth is that this harness has no timeout to report.
   *
   * Optional for the same reason `referenceWords` is: this is a read type as well as a
   * write type, and the runs archived before the count existed have no number on disk and
   * must still load. Every new run sets it - see `CompletedModelDatasetResult`.
   */
  failures?: number;
  totalAudioSec: number;
  totalWallSec: number;
}

/**
 * A result this build produces, as opposed to one it may read off disk.
 *
 * `referenceWords`, `failures` and `sampleRange` are optional on the read type because the
 * archive predates them, and required here so that a new emit path which forgets the
 * denominator, the failure count or the sample range fails `bun run tsc` rather than
 * quietly writing another unpoolable, undisclosed or unlocatable leaf. A clean run
 * therefore emits `failures: 0`, which is a different claim from omitting the field: one
 * says nothing failed, the other says nobody counted. A leaf without a `sampleRange`
 * contributes nothing to any cursor, so a forgotten range makes a Benchmark Run that
 * measured 400 clips look like a Combination nobody has ever touched.
 */
export type CompletedModelDatasetResult = ModelDatasetResult & {
  referenceWords: number;
  failures: number;
  sampleRange: SampleRange;
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
  /**
   * Failed utterances so far, emitted as `failures`. A resumed run adds to this instead
   * of restarting the count at the utterance it resumed from.
   *
   * Optional, and read as `?? 0`. `dictation-product-benchmark` mirrors this interface in
   * `src/codictate-compat.ts` and writes a Codictate-shaped `checkpoint.json` from it;
   * making the field required here would declare a property that checkpoint does not
   * carry, and `loadCheckpoint` casts `inProgress` without validating it, so the claim
   * would be unsound at runtime rather than caught. Checkpoints written before the count
   * existed are missing it for the same reason.
   */
  failures?: number;
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
  warmup: boolean,
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
  return {
    id: entry.id,
    warmup,
    status: result.status,
    wallClockMs,
    wer,
    hypothesis,
  };
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

export interface BenchmarkModelOptions {
  /**
   * Which consumable entries of the dataset `entries` covers, recorded onto the leaf.
   *
   * Required, and passed in rather than inferred: this function is handed an array that
   * already has the reserved warmups prepended to a planned range, so it cannot know where
   * in the dataset that range sits. The caller planned it, so the caller says.
   */
  range: SampleRange;
  partial?: PartialProgress;
  onCheckpoint?: CheckpointCallback;
  computeCer?: boolean;
  /**
   * ASR Harness to run Whisper models under. Ignored for Parakeet, which has
   * only its own helper.
   */
  harness?: AsrHarnessId;
}

export async function benchmarkModel(
  modelId: string,
  entries: ManifestEntry[],
  datasetLabel: string,
  options: BenchmarkModelOptions,
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
      failures: 0,
      // Zero-width at the cursor it was planned from: nothing was measured, so nothing was
      // consumed and the cursor must not move. Omitting the range would type-check as an
      // incomplete leaf; claiming the planned width would burn clips this never transcribed.
      sampleRange: {
        startIndex: options.range.startIndex,
        endIndex: options.range.startIndex,
        manifestFingerprint: options.range.manifestFingerprint,
      },
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
      `  [${modelId}] ${datasetLabel}: resuming clips ${options.range.startIndex + 1}-${options.range.endIndex} from utterance ${startOffset}/${benchEntries.length}`,
    );
  } else {
    console.log(
      `  [${modelId}] ${datasetLabel}: clips ${options.range.startIndex + 1}-${options.range.endIndex} (${benchEntries.length} scored, ${WARMUP_COUNT} reserved warmup)`,
    );
  }

  // Every utterance this call transcribes, warmups included and flagged as such, so the
  // failure count is taken by `countTranscriptionFailures` over the data rather than by
  // whichever loop happened to run. A resume carries the earlier call's count in
  // `priorFailures` rather than recounting utterances this call never saw.
  const results: UtteranceResult[] = [];
  const priorFailures = partial?.failures ?? 0;

  // Warmup, on every call including a resume. A resumed Benchmark Run is a fresh cold
  // process, so it needs warming exactly as much as the first one did; the reservation
  // exists so that replaying it costs three clips of wall time and changes no published
  // number, since a warmup is never scored and never advances the cursor.
  const warmupEntries = entries.slice(0, WARMUP_COUNT);
  for (let i = 0; i < warmupEntries.length; i++) {
    results.push(
      await runUtterance(warmupEntries[i], modelId, modelPath, harness, true),
    );
    process.stdout.write(`    warmup ${i + 1}/${WARMUP_COUNT}\r`);
  }

  // Benchmark
  const shouldComputeCer = options?.computeCer ?? false;
  let totalWer = partial?.totalWer ?? 0;
  let totalRefWords = partial?.totalRefWords ?? 0;
  let totalCerErrors = partial?.totalCer ?? 0;
  let totalRefChars = partial?.totalRefChars ?? 0;
  let totalAudioSec = partial?.totalAudioSec ?? 0;
  let totalWallSec = partial?.totalWallSec ?? 0;

  for (let i = startOffset; i < benchEntries.length; i++) {
    const entry = benchEntries[i];
    const result = await runUtterance(
      entry,
      modelId,
      modelPath,
      harness,
      false,
    );
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
        failures: priorFailures + countTranscriptionFailures(results),
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

  const failures = priorFailures + countTranscriptionFailures(results);

  const cerStr =
    aggCer !== undefined ? ` | CER: ${(aggCer * 100).toFixed(2)}%` : "";
  console.log(
    `    done | WER: ${(aggWer * 100).toFixed(2)}%${cerStr} | RTF: ${meanRTF.toFixed(3)} | RSS: ${peakRSS_MB ? `${peakRSS_MB.min}/${peakRSS_MB.avg}/${peakRSS_MB.max}` : "N/A"} MB (min/avg/max)`,
  );
  // Printed unconditionally, including as a zero. `reportTranscriptionFailure` speaks once
  // per distinct reason and never says how many, so a log that only mentioned failures
  // when there were some could not tell "nothing failed" from "nothing counted them".
  console.log(
    `    failures: ${failures}/${benchEntries.length} utterances scored as an empty hypothesis`,
  );

  const result: CompletedModelDatasetResult = {
    wer: aggWer,
    referenceWords: totalRefWords,
    meanRTF,
    peakRSS_MB,
    utteranceCount: benchEntries.length,
    failures,
    sampleRange: options.range,
    totalAudioSec,
    totalWallSec,
  };
  if (aggCer !== undefined) {
    result.cer = aggCer;
    result.referenceChars = totalRefChars;
  }
  return result;
}
