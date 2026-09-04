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
import { type SampleRange } from "./sample-cursor";
import {
  assertV2OnV1Leaf,
  pooledCer,
  pooledInferenceRtf,
  pooledSpeed,
  pooledWer,
  responseMsFromWindow,
  resumeSelection,
  type LeafSpeedV2 as SharedLeafSpeedV2,
  type RunPlan,
  type SampleMeasurementV2,
} from "../contract";

/**
 * Clips the peak-RSS measurement re-runs the Harness on.
 *
 * There is no warmup constant here any more. Which clips warm the model is the Run
 * Plan's `warmupClipIds`, read from the plan rather than taken off the head of the array
 * handed in: "the first three entries of this array" and "the reserved warmup pool" were
 * two spellings of one fact, and a resume that re-prepended the reservation to a
 * different slice made them disagree.
 */
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

/**
 * The timing regime every Codictate v2 Sample records, and the reason it has to be on
 * the record rather than inferred.
 *
 * Codictate is timed at the direct adapter call boundary; Wispr Flow is timed from the
 * UI-observed paste. Pooled speed is filtered by regime, and an **absent** regime is
 * treated as speed-incompatible on purpose: the alternative is guessing, and the failure
 * mode of guessing is publishing a UI-observed number that is ~85 ms optimistic per clip
 * as though it were a direct-adapter one. So a Sample that does not say which
 * instrumentation produced it contributes to counts and accuracy and to no speed figure -
 * which means omitting this field here would make every Codictate speed number vanish
 * from the comparison rather than be wrong. See `benchmarks/contract/timing.ts`.
 */
export const CODICTATE_TIMING_REGIME = "direct-adapter" as const;

/**
 * What a v1 leaf's `wer` and `meanRTF` say when there was nothing to measure.
 *
 * Negative, because both fields are rates on a type that cannot express absence, and
 * because zero is the *best* value each of them can take: a zero WER is a perfect
 * transcription and a zero RTF is an instant one. Every reader in this repository
 * already treats a negative rate as "N/A" - `fmtAccuracy` and `fmtSpeed` in `report.ts`,
 * and the `wer < 0` filter in `charts.py` - and the archive has carried `-1` for an
 * absent Speech Model since the first Benchmark Run, so this is the existing convention
 * named rather than a new one.
 */
export const UNMEASURED_RATE = -1;

export interface UtteranceResult {
  id: string;
  /**
   * Canonical clip identity, carried so the v1 per-utterance view and the v2 Sample
   * agree about which audio file a number belongs to. See `ManifestEntry.clipId`.
   */
  clipId: string;
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
  results: readonly Pick<UtteranceResult, "warmup" | "status">[],
): number {
  return results.filter((result) => !result.warmup && result.status !== "ok")
    .length;
}

/**
 * The same rule over v2 Samples: scored, not a warmup, and the engine returned nothing.
 *
 * A second function rather than a widened `countTranscriptionFailures`, because the two
 * shapes spell the warmup flag differently (`warmup` here, `isWarmup` on the contract
 * type) and a structural union that accepted either would also accept an object with
 * neither. One rule, two adapters onto it.
 *
 * Counts timeouts too, per the pinned failure taxonomy: `failureCount` is every
 * unsuccessful Sample and `timeoutCount` is the subset that timed out. This Harness has
 * no timeout to report - a `TranscriptionResult` is `ok` or `failed` (ADR-0006) - so the
 * subset is always empty here, and that is a fact about this adapter rather than about
 * the run.
 */
export function countFailedScoredSamples(
  samples: readonly SampleMeasurementV2[],
): number {
  return samples.filter((sample) => !sample.isWarmup && sample.status !== "ok")
    .length;
}

export interface PeakRSSStats {
  min: number;
  avg: number;
  max: number;
}

/**
 * The v2 speed figures a leaf publishes: the contract's shared shape, unchanged.
 *
 * `SharedLeafSpeedV2` from `benchmarks/contract/v1-leaf.ts` is what both repositories
 * write and `assertV2OnV1Leaf` validates. The whole `SpeedSummary` rather than a single
 * rate, because the counts are the story behind the rate: only successful Samples are in
 * the numerator *and* the denominator, so a product that timed out on its ten slowest
 * clips would otherwise post a faster number than one that answered all of them.
 *
 * An alias rather than an extension. It briefly widened the shape with `responseMs` and
 * `audioDurationSec`, because a ratio cannot be pooled across leaves without the two sums
 * it was divided by and the pinned shape had neither. The contract has since pinned both
 * onto `SpeedSummary`, so the local widening would now be a second name for the same two
 * fields - and, worse, a second accumulator computing them, which is a second chance for
 * the per-leaf and the cross-leaf figure to drift.
 */
export type LeafSpeedV2 = SharedLeafSpeedV2;

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
  /**
   * Word errors, as a whole number, so a pooled rate needs no multiplication.
   *
   * `wer * referenceWords` recovers the same value on an archived leaf, and that is
   * exactly why this field exists: a float times a float is a float, and a pooled
   * numerator built out of 25 of them accumulates a rounding error into a published
   * rate. Storing the count keeps the numerator whole and the rate checkable by eye.
   *
   * Optional because it is a read type as well as a write type. An archived leaf has
   * only the rate and the denominator; a reader derives the count from those two and
   * **skips** the leaf when the denominator is absent, never treating it as zero.
   */
  wordErrors?: number;
  cer?: number;
  /** Reference characters the CER was divided by. Absent wherever `cer` is absent. */
  referenceChars?: number;
  /** Character errors, whole. Absent wherever `cer` is absent. See `wordErrors`. */
  charErrors?: number;
  meanRTF: number;
  /**
   * The pooled v2 speed summary for this leaf, computed by the contract.
   *
   * Written so `report.ts` and `benchmarks/stt/charts.py` read one number rather than
   * each deriving it: `charts.py` used to arithmetically average per-dataset RTFs, which
   * is a mean of means on the speed axis and a different number from the speed of the
   * combined sample. `speedV2.wallRtf` is `responseMsPerAudioSec / 1000` and comes from
   * `pooledSpeed`, so the two surfaces cannot drift apart by construction.
   *
   * Optional on read: every archived leaf predates per-Sample measurements and has only
   * `meanRTF`. A reader falls back to the pooled `totalWallSec / totalAudioSec` sums for
   * those, which is the same arithmetic over the only inputs they carry.
   */
  speedV2?: LeafSpeedV2;
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
export type CompletedModelDatasetResult = PoolableLeaf & {
  sampleRange: SampleRange;
};

/**
 * A leaf with every derivable field present and no `sampleRange`.
 *
 * The completeness half of `CompletedModelDatasetResult`, without the location half. A
 * pooled leaf spans the ranges of every run behind it and therefore has no single
 * `[startIndex, endIndex)` - but it still has a denominator, an error count, a failure
 * count and a speed summary, and a write path that forgot any of those should still fail
 * `bun run tsc` rather than quietly publishing another unpoolable leaf.
 */
export type PoolableLeaf = ModelDatasetResult & {
  referenceWords: number;
  wordErrors: number;
  failures: number;
  speedV2: LeafSpeedV2;
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

/**
 * The Speech Engine Adapter, split at the timing window.
 *
 * Two functions rather than one, and the split is the measurement: `responseMs` starts on
 * the statement immediately before `invoke` and ends when `invoke` returns the final
 * transcript, so **nothing else may sit inside that window** - no manifest read, no WAV
 * read, no logging. Those are the harness's costs and they would be charged to the Speech
 * Model. Building the Transcription Request is one of them, which is why `prepare` is a
 * separate call made before the clock starts.
 *
 * It is also the seam the tests need. `measureClips` is the loop that has to be proved to
 * invoke the adapter exactly once per selected clip, on 400 distinct audio files, and
 * to invoke it zero times for a clip a previous session already measured. Proving that
 * against `runTranscription` would mean transcribing 400 clips per assertion; proving it
 * against a counting fake takes milliseconds and asserts the same property.
 *
 * Deliberately *not* a Dictation Plan and not a settings read: AGENTS.md keeps the
 * benchmark out of both, and `transcriptionRequestFor` is this harness's door into the
 * adapter.
 */
export interface AdapterSeam {
  /** Built **outside** the timing window. */
  prepare: (entry: ManifestEntry) => TranscriptionRequest;
  /** The only statement **inside** the timing window. */
  invoke: (request: TranscriptionRequest) => Promise<TranscriptionResult>;
}

/** The Speech Engine Adapter for one Benchmark Combination. */
export function adapterFor(
  modelId: string,
  modelPath: string,
  harness: AsrHarnessId,
): AdapterSeam {
  return {
    // The Sample is read where it already lives. It used to be copied over
    // RECORDING_PATH, the app's own recording buffer, roughly 200 times per Benchmark
    // Combination - so a Benchmark Run alongside a running Codictate clobbered whatever
    // the user had just dictated. Nothing on this path needs that path; a Transcription
    // Request takes an audioPath.
    prepare: (entry) =>
      transcriptionRequestFor(
        modelId,
        modelPath,
        entry.audioPath,
        harness,
        entry.language,
      ),
    invoke: runTranscription,
  };
}

/** One clip, measured once: the v2 Sample and the v1 per-utterance view of it. */
interface MeasuredClip {
  sample: SampleMeasurementV2;
  utterance: UtteranceResult;
}

async function measureClip(
  entry: ManifestEntry,
  adapter: AdapterSeam,
  now: () => number,
  isWarmup: boolean,
  computeCerToo: boolean,
  onFailure: (failure: FailedTranscription) => void,
): Promise<MeasuredClip> {
  const request = adapter.prepare(entry);

  // The timing window. Two statements and one call between them, on purpose.
  const startedAtMs = now();
  const result = await adapter.invoke(request);
  const transcriptReturnedAtMs = now();

  const elapsedMs = responseMsFromWindow({
    regime: CODICTATE_TIMING_REGIME,
    startedAtMs,
    transcriptReturnedAtMs,
  });

  if (result.status === "failed") onFailure(result);
  const hypothesis = result.status === "ok" ? result.rawTranscript : "";

  const wer = computeWer(entry.transcript, hypothesis);
  const cer =
    computeCerToo && entry.rawTranscript
      ? computeCer(entry.rawTranscript, hypothesis)
      : null;

  const sample: SampleMeasurementV2 = {
    clipId: entry.clipId,
    ...(entry.sentenceId === undefined ? {} : { sentenceId: entry.sentenceId }),
    audioDurationSec: entry.audioDurationSec,
    // `null` on a failure, never zero: a zero would price a failure as an instant
    // transcription in the pooled ratio.
    responseMs: result.status === "ok" ? elapsedMs : null,
    status: result.status === "ok" ? "ok" : "failed",
    wordErrors: wer.substitutions + wer.insertions + wer.deletions,
    referenceWords: wer.refWords,
    charErrors: cer ? cer.substitutions + cer.insertions + cer.deletions : 0,
    referenceChars: cer ? cer.refChars : 0,
    isWarmup,
    overhead: {
      timingRegime: CODICTATE_TIMING_REGIME,
      // No engine-reported inference duration exists to record: a TranscriptionResult is
      // a status and a transcript (ADR-0006). Recorded as null rather than as the
      // adapter wall time, because the two are different measurements and a copy of
      // `responseMs` under another name would read as an independent number.
      inferenceMs: null,
      // The adapter call's wall clock, recorded for **every** Sample including the ones
      // that failed - where `responseMs` is `null`, because a failure has no response to
      // time. It exists so the v1 `totalWallSec` can keep its v1 meaning: wall clock over
      // audio, over all scored Samples, unfiltered. Never an input to a published v2
      // metric; that is `responseMs`, and everything provenance-filtered lives under
      // `speedV2`.
      wallClockMs: elapsedMs,
    },
    ...(result.status === "failed" && result.diagnostic
      ? { failureDiagnostic: result.diagnostic }
      : {}),
  };

  return {
    sample,
    utterance: {
      id: entry.id,
      clipId: entry.clipId,
      warmup: isWarmup,
      status: result.status,
      wallClockMs: elapsedMs,
      wer,
      hypothesis,
    },
  };
}

export interface MeasureClipsInput {
  /**
   * The immutable Run Plan. Read, never rebuilt: a resumed process re-reads the plan the
   * run was started with, because rebuilding one from the current flags is how a resume
   * silently re-slices and files a partial numerator against clips it never transcribed.
   */
  plan: Pick<RunPlan, "orderedClipIds" | "warmupClipIds">;
  /** Every clip the plan names, by `clipId`, with durations already hydrated. */
  entriesByClipId: ReadonlyMap<string, ManifestEntry>;
  adapter: AdapterSeam;
  /**
   * Samples already on disk for this run. Every scored clip among them is skipped -
   * including one recorded as `failed`, which is a measurement and not a retry
   * opportunity - and every warmup among them is replayed anyway.
   */
  recordedSamples?: readonly SampleMeasurementV2[];
  computeCer?: boolean;
  /**
   * Called after **every** scored clip, with every Sample recorded so far.
   *
   * Every clip, not every fiftieth. A 50-clip batch is how a killed run loses up to 49
   * clips it had already paid for, and those clips are then re-transcribed by the resume
   * - which is the cheap half of the damage. The expensive half is that the checkpoint on
   * disk described a depth the record could not back up.
   */
  onScoredClip?: (samples: readonly SampleMeasurementV2[]) => void;
  /** Injected so a test can assert the timing window without a real clock. */
  now?: () => number;
  onFailure?: (failure: FailedTranscription) => void;
  /**
   * Progress line, printed by `benchmarkModel` and silent in tests.
   *
   * Handed the Samples so far rather than left to read them, because the running WER on
   * that line is a fold over the record and must not be a second accumulator that can
   * disagree with it.
   */
  onProgress?: (
    done: number,
    total: number,
    samples: readonly SampleMeasurementV2[],
  ) => void;
}

export interface MeasureClipsOutcome {
  /** Every Sample of this run: the recorded ones first, then this session's. */
  samples: SampleMeasurementV2[];
  /** This session's utterance views, for the failure count and the log lines. */
  utterances: UtteranceResult[];
  /** Scored clips this session skipped because they were already measured. */
  skippedScoredClips: number;
  /** Adapter invocations this session made: warmups replayed plus clips measured. */
  adapterInvocations: number;
}

/**
 * Measure a Run Plan's clips, resuming from whatever is already recorded.
 *
 * The three lists come from `resumeSelection` in the contract rather than from an
 * integer offset into the array, which is the v1 bug this replaces. v1 resumed from
 * `partial.utterancesDone`, an offset into a slice whose start was recomputed from the
 * flags - so a resume with different flags resumed a different slice at the same offset,
 * and the warmup reservation had to be re-prepended by the caller for the offset to mean
 * anything. Set operations on `clipId` have no such coupling: warmups replay because they
 * are the plan's warmup list, and a scored clip is skipped because its identity is
 * already in the record.
 */
export async function measureClips(
  input: MeasureClipsInput,
): Promise<MeasureClipsOutcome> {
  const now = input.now ?? (() => performance.now());
  const computeCerToo = input.computeCer ?? false;
  const onFailure = input.onFailure ?? (() => {});
  const recorded = input.recordedSamples ?? [];

  const selection = resumeSelection(
    {
      orderedClipIds: input.plan.orderedClipIds,
      warmupClipIds: input.plan.warmupClipIds,
    } as RunPlan,
    recorded,
  );

  const entryFor = (clipId: string): ManifestEntry => {
    const entry = input.entriesByClipId.get(clipId);
    if (!entry) {
      throw new Error(
        `Run Plan names "${clipId}" but no manifest entry was supplied for it. The plan ` +
          `and the manifest were built from different lists, so the range cannot be run.`,
      );
    }
    return entry;
  };

  // Every Sample already recorded is kept verbatim, warmups included. A replayed warmup
  // is evidence that a resumed session warmed the model, and a recorded failure is a
  // measurement - rewriting either would launder it.
  const samples: SampleMeasurementV2[] = [...recorded];
  const utterances: UtteranceResult[] = [];
  let adapterInvocations = 0;

  // Warmup, on every call including a resume. A resumed Benchmark Run is a fresh cold
  // process, so it needs warming exactly as much as the first one did; the reservation
  // exists so that replaying it costs three clips of wall time and changes no published
  // number, since a warmup is never scored and never advances the cursor.
  for (const clipId of selection.warmupsToReplay) {
    const measured = await measureClip(
      entryFor(clipId),
      input.adapter,
      now,
      true,
      computeCerToo,
      onFailure,
    );
    adapterInvocations++;
    samples.push(measured.sample);
    utterances.push(measured.utterance);
  }

  for (const clipId of selection.remaining) {
    const measured = await measureClip(
      entryFor(clipId),
      input.adapter,
      now,
      false,
      computeCerToo,
      onFailure,
    );
    adapterInvocations++;
    samples.push(measured.sample);
    utterances.push(measured.utterance);

    // After every scored clip, before anything else can fail.
    input.onScoredClip?.(samples);
    input.onProgress?.(
      selection.scoredToSkip.length +
        utterances.filter((u) => !u.warmup).length,
      input.plan.orderedClipIds.length,
      samples,
    );
  }

  return {
    samples,
    utterances,
    skippedScoredClips: selection.scoredToSkip.length,
    adapterInvocations,
  };
}

/**
 * A Sample's adapter wall clock in seconds, for the **legacy** `totalWallSec` sum.
 *
 * From `overhead.wallClockMs`, which is recorded for every Sample including the failures
 * that carry `responseMs: null`. Falls back to `responseMs` for a record written before
 * that field existed, and to zero only when neither is there - which is a Sample that
 * never reached the adapter at all.
 */
function wallClockSecOf(sample: SampleMeasurementV2): number {
  const recorded = sample.overhead?.wallClockMs;
  if (typeof recorded === "number" && Number.isFinite(recorded)) {
    return recorded / 1000;
  }
  return typeof sample.responseMs === "number" ? sample.responseMs / 1000 : 0;
}

/**
 * The v1 leaf and the v2 speed summary, both computed from the same Samples.
 *
 * One derivation rather than two accumulators. v1 carried running numerators through the
 * checkpoint (`PartialProgress`) so a resumed run could report what an uninterrupted one
 * would have; with a Sample per clip on disk the totals are a fold over the record, which
 * cannot drift from it and needs no resume-time bookkeeping.
 */
export function leafFromSamples(
  samples: readonly SampleMeasurementV2[],
  options: {
    range: SampleRange;
    peakRSS_MB: PeakRSSStats | null;
    computeCer: boolean;
  },
): CompletedModelDatasetResult {
  return {
    ...poolableLeafFromSamples(samples, options),
    sampleRange: options.range,
  };
}

/**
 * Everything on a leaf except the `sampleRange`, which not every leaf can have.
 *
 * The shared body of `leafFromSamples` and `pooledLeafFromSamples`. Split so that the
 * pooled variant does not have to build a range and then drop it: a pooled leaf spans the
 * ranges of every run behind it, so there is no single `[startIndex, endIndex)` that
 * describes it, and constructing a placeholder to delete is how a placeholder eventually
 * ships.
 */
function poolableLeafFromSamples(
  samples: readonly SampleMeasurementV2[],
  options: {
    peakRSS_MB: PeakRSSStats | null;
    computeCer: boolean;
    /**
     * How many Benchmark Runs these Samples came from, so the contract's guard can
     * enforce that a leaf pooling more than one carries no `sampleRange`. One by default:
     * `leafFromSamples` builds a single run's leaf and does attach a range.
     */
    pooledRunCount?: number;
  },
): PoolableLeaf {
  const scored = samples.filter((sample) => !sample.isWarmup);
  const speed = pooledSpeed(scored);
  const inference = pooledInferenceRtf(scored);
  // A Sample with a zero denominator is handed to the pool as an **absent** leaf, not as
  // `0 / 0`. `SampleMeasurementV2` requires `charErrors` and `referenceChars` to be
  // numbers - the contract's type guard rejects a Sample without them - so "this clip was
  // never scored for CER" can only be written as a zero denominator on disk, and it has
  // to be translated back here. Passing the zeros straight through counts an unscored
  // clip in `leafCount` instead of `skippedCount`, which is the honesty counter the
  // contract documents as load-bearing: a pooled rate over half the clips is a different
  // claim from one over all of them, and a caller that cannot see the skips reports the
  // first as the second. Every LibriSpeech clip and every FLEURS row with an empty
  // `raw_transcription` is in this case.
  const word = pooledWer(
    scored.map((sample) =>
      sample.referenceWords > 0
        ? {
            wordErrors: sample.wordErrors,
            referenceWords: sample.referenceWords,
          }
        : {},
    ),
  );
  const char = pooledCer(
    scored.map((sample) =>
      sample.referenceChars > 0
        ? {
            charErrors: sample.charErrors,
            referenceChars: sample.referenceChars,
          }
        : {},
    ),
  );

  // `totalWallSec` and `totalAudioSec` keep their **v1 meaning**: wall clock over audio,
  // over **all** scored Samples, unfiltered - failures and provenance-less Samples
  // included.
  //
  // They were briefly filtered to the speed-compatible successes so that `meanRTF` would
  // equal `speedV2.wallRtf`. That was wrong, and the reason is the same one this whole
  // change is about: these are archived fields. Every leaf in `benchmarks/results/`
  // carries them under the v1 definition and can never be re-measured, so redefining
  // them in place makes eight archived Benchmark Runs incomparable to every new one -
  // silently, because the numbers stay plausible. `dictation-product-benchmark` also
  // keeps them as session wall clock over audio, so a redefinition here would put two
  // meanings under one field name across two repositories.
  //
  // Everything provenance-filtered lives under `speedV2` and nowhere else. The two
  // numbers on one leaf are *supposed* to differ, and `speedV2.wallRtf` is the only one
  // that may be published.
  let totalAudioSec = 0;
  let totalWallSec = 0;
  for (const sample of scored) {
    totalAudioSec += sample.audioDurationSec;
    totalWallSec += wallClockSecOf(sample);
  }

  const leaf: PoolableLeaf = {
    // `UNMEASURED_RATE`, not zero. `pooledWer` returns `null` when no clip carried a
    // denominator, and a fresh metric must not spell "unmeasured" as the best possible
    // score - a zero WER is a perfect transcription and a zero RTF is instant. Reachable:
    // a Combination where nothing was scorable would otherwise write `wer: 0` beside
    // `failures: 400`. `-1` is not a new convention: it is what the archive's
    // absent-Speech-Model leaves have always carried, and what `fmtAccuracy`, `fmtSpeed`
    // and `charts.py` already read as N/A - so no archived value changes meaning, and the
    // website reader, a separate repository, needs no private knowledge that 0 meant N/A.
    wer: word.rate ?? UNMEASURED_RATE,
    referenceWords: word.references,
    wordErrors: word.errors,
    // The v1 quotient over the v1, unfiltered sums. Not `speedV2.wallRtf`.
    meanRTF: totalAudioSec > 0 ? totalWallSec / totalAudioSec : UNMEASURED_RATE,
    peakRSS_MB: options.peakRSS_MB,
    utteranceCount: speed.sampleCount,
    failures: speed.failureCount,
    // `...speed` supplies `responseMs` and `audioDurationSec` itself: the contract pinned
    // the filtered numerator and denominator onto `SpeedSummary`, so there is one
    // implementation of the provenance-and-status filter instead of a local copy beside
    // it. The copy was a second chance to drift, and the leaf guard catching a
    // disagreement afterwards is worse than not having two.
    speedV2: {
      ...speed,
      inferenceRtf: inference.rtf,
      inferenceMs: inference.inferenceMs,
      inferenceAudioSec: inference.audioDurationSec,
      inferenceSampleCount: inference.leafCount,
      inferenceSkippedCount: inference.skippedCount,
    },
    totalAudioSec,
    totalWallSec,
  };

  // `char.rate !== null` rather than `char.references > 0`: the same condition stated as
  // the thing that actually matters, so there is no `?? 0` fallback on an unreachable
  // branch for a later reader to wonder about.
  if (options.computeCer && char.rate !== null) {
    leaf.cer = char.rate;
    leaf.referenceChars = char.references;
    leaf.charErrors = char.errors;
  }

  // Validated against the contract's executable definition of the shared leaf, at the one
  // place a leaf is built, rather than against its prose. It reports every complaint at
  // once and it enforces the things this file cannot see on its own: that the summary is
  // under `speedV2` and never `speed`, that `wordErrors` is present so two consumers
  // cannot pool an exact integer against a derived float, that `wer * referenceWords`
  // really is `wordErrors`, and - when it is told the run count - that a leaf pooling
  // more than one run carries no `sampleRange`.
  assertV2OnV1Leaf(leaf, { pooledRunCount: options.pooledRunCount });
  return leaf;
}

/**
 * The same leaf for a **pooled** set of Samples: no `sampleRange`, no peak RSS.
 *
 * No range, because a pooled leaf spans the ranges of every run that contributed to it
 * and there is no single `[startIndex, endIndex)` that describes it - `[0, 400)` from one
 * run and `[400, 800)` from the next pool to 800 clips whose recorded ranges are two, and
 * a leaf claiming `[0, 800)` would be inventing a range nobody measured. A leaf with no
 * range contributes to no cursor, which is exactly right here: `--aggregate` merges
 * leaves that are already counted, and `loadCoverage` deliberately never reads its output.
 *
 * No peak RSS, because it is measured per session on ten clips and is not poolable: the
 * min/avg/max of two runs' triples is not the min/avg/max of their clips.
 */
export function pooledLeafFromSamples(
  samples: readonly SampleMeasurementV2[],
  options: { computeCer: boolean; pooledRunCount: number },
): PoolableLeaf {
  return poolableLeafFromSamples(samples, {
    peakRSS_MB: null,
    computeCer: options.computeCer,
    pooledRunCount: options.pooledRunCount,
  });
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
   * Which consumable entries of the dataset this Combination measured, recorded onto the
   * v1 leaf.
   *
   * Required, and passed in rather than inferred: the caller planned the range, so the
   * caller says. Kept beside the v2 plan rather than derived from it, because the two
   * answer different questions - `SampleRange` is an offset pair against the v1 ordering
   * token, `plan` is the clip set - and the v1 cursor still reads the offsets.
   */
  range: SampleRange;
  /**
   * The immutable v2 Run Plan for this Combination: which clips are scored, in order,
   * and which are replayed as warmups.
   *
   * Read, never rebuilt. A resumed process re-reads the plan its run was started with;
   * recomputing one from the current flags is how a resume re-slices and files a partial
   * numerator against clips it never transcribed.
   */
  plan: Pick<RunPlan, "orderedClipIds" | "warmupClipIds">;
  /** Samples already recorded for this run, from an interrupted earlier session. */
  recordedSamples?: readonly SampleMeasurementV2[];
  /** Called after every scored clip, with every Sample recorded so far. */
  onScoredClip?: (samples: readonly SampleMeasurementV2[]) => void;
  computeCer?: boolean;
  /**
   * ASR Harness to run Whisper models under. Ignored for Parakeet, which has
   * only its own helper.
   */
  harness?: AsrHarnessId;
  /**
   * Default true. Set false to skip the peak-RSS measurement, which spawns the Harness
   * ten more times and has nothing to say in a test.
   */
  measureMemory?: boolean;
  /** Default: the real Speech Engine Adapter. Overridden by the tests. See `AdapterSeam`. */
  adapter?: AdapterSeam;
  /** Injected clock, so a test can assert the timing window deterministically. */
  now?: () => number;
}

/**
 * What one Benchmark Combination produced: the v1 leaf, and the v2 Samples behind it.
 *
 * Both, because they are not each other's summary. The leaf is what `stt.json` has always
 * carried and what every archived reader loads; the Samples are what v1 had no way to
 * record - which clip produced which number - and are what make two runs poolable, an
 * overlapping rerun replaceable, and a resume able to tell a clip it transcribed from one
 * it never reached.
 */
export interface BenchmarkModelOutcome {
  result: CompletedModelDatasetResult;
  samples: SampleMeasurementV2[];
}

/**
 * A v1-shaped progress snapshot, folded out of the v2 Samples.
 *
 * Derived rather than accumulated. `PartialProgress` used to be the resume state itself,
 * carrying running numerators across sessions; with a Sample per clip on disk it is a
 * *view*, kept because `dictation-product-benchmark` mirrors this interface in
 * `src/codictate-compat.ts` and writes a Codictate-shaped `checkpoint.json` from it. A
 * view cannot drift from the record it is folded from.
 */
export function partialFromSamples(
  samples: readonly SampleMeasurementV2[],
): PartialProgress {
  const scored = samples.filter((sample) => !sample.isWarmup);
  const totals = {
    utterancesDone: scored.length,
    totalWer: 0,
    totalRefWords: 0,
    totalCer: 0,
    totalRefChars: 0,
    failures: countFailedScoredSamples(scored),
    totalAudioSec: 0,
    totalWallSec: 0,
  };
  for (const sample of scored) {
    totals.totalWer += sample.wordErrors;
    totals.totalRefWords += sample.referenceWords;
    totals.totalCer += sample.charErrors;
    totals.totalRefChars += sample.referenceChars;
    if (sample.status !== "ok" || typeof sample.responseMs !== "number")
      continue;
    totals.totalAudioSec += sample.audioDurationSec;
    totals.totalWallSec += sample.responseMs / 1000;
  }
  return totals;
}

/**
 * The sentinel leaf for a Speech Model that is not on disk.
 *
 * Zero-width at the index it was planned from: nothing was measured, so nothing was
 * consumed and the cursor must not move. Omitting the range would type-check as an
 * incomplete leaf; claiming the planned width would burn clips this never transcribed.
 */
export function unmeasuredLeaf(
  range: SampleRange,
): CompletedModelDatasetResult {
  return {
    ...leafFromSamples([], {
      range: {
        startIndex: range.startIndex,
        endIndex: range.startIndex,
        manifestFingerprint: range.manifestFingerprint,
      },
      peakRSS_MB: null,
      computeCer: false,
    }),
  };
}

export async function benchmarkModel(
  modelId: string,
  entries: ManifestEntry[],
  datasetLabel: string,
  options: BenchmarkModelOptions,
): Promise<BenchmarkModelOutcome> {
  const harness = options?.harness ?? DEFAULT_ASR_HARNESS;
  const speech = getSpeechModel(modelId);
  if (!speech) {
    throw new Error(`Unknown model: ${modelId}`);
  }

  const adapterOverride = options.adapter;
  const modelPath = adapterOverride ? "" : resolveModelPath(modelId);
  if (modelPath === null) {
    console.log(`  [skip] ${modelId} not found`);
    return {
      result: unmeasuredLeaf(options.range),
      samples: [...(options.recordedSamples ?? [])],
    };
  }

  const entriesByClipId = new Map(
    entries.map((entry) => [entry.clipId, entry]),
  );

  const plan = options.plan;
  const recorded = options.recordedSamples ?? [];
  const alreadyMeasured = resumeSelection(
    {
      orderedClipIds: plan.orderedClipIds,
      warmupClipIds: plan.warmupClipIds,
    } as RunPlan,
    recorded,
  );

  if (alreadyMeasured.scoredToSkip.length > 0) {
    console.log(
      `  [${modelId}] ${datasetLabel}: resuming clips ${options.range.startIndex + 1}-${options.range.endIndex}, ${alreadyMeasured.scoredToSkip.length}/${plan.orderedClipIds.length} already measured and never re-transcribed`,
    );
  } else {
    console.log(
      `  [${modelId}] ${datasetLabel}: clips ${options.range.startIndex + 1}-${options.range.endIndex} (${plan.orderedClipIds.length} scored, ${plan.warmupClipIds.length} reserved warmup)`,
    );
  }

  const shouldComputeCer = options?.computeCer ?? false;
  const outcome = await measureClips({
    plan,
    entriesByClipId,
    adapter: adapterOverride ?? adapterFor(modelId, modelPath, harness),
    recordedSamples: recorded,
    computeCer: shouldComputeCer,
    onScoredClip: options.onScoredClip,
    now: options.now,
    onFailure: (failure) => reportTranscriptionFailure(modelId, failure),
    onProgress: (done, total, samples) => {
      // Progress is logged every fiftieth clip and the checkpoint is written every clip.
      // They used to share one condition, which is how a 50-clip batch became the
      // checkpoint interval: the log line's job is to not flood a console, and the
      // checkpoint's job is to lose nothing.
      if (done % 50 !== 0 && done !== total) return;
      const partial = partialFromSamples(samples);
      const wer =
        partial.totalRefWords > 0
          ? partial.totalWer / partial.totalRefWords
          : 0;
      const cerStr =
        shouldComputeCer && (partial.totalRefChars ?? 0) > 0
          ? ` | CER: ${(((partial.totalCer ?? 0) / (partial.totalRefChars ?? 1)) * 100).toFixed(2)}%`
          : "";
      console.log(
        `    ${done}/${total} | WER: ${(wer * 100).toFixed(2)}%${cerStr} | RTF: ${computeRtf(partial.totalWallSec, partial.totalAudioSec).toFixed(3)}`,
      );
    },
  });

  // Memory measurement on small sample
  let peakRSS_MB: PeakRSSStats | null = null;
  const scoredEntries = plan.orderedClipIds
    .map((clipId) => entriesByClipId.get(clipId))
    .filter((entry): entry is ManifestEntry => entry !== undefined);
  // Off by default when the adapter is injected: peak RSS is measured by spawning the
  // Harness ten more times, which a test with a fake adapter has neither the weights nor
  // the reason to do.
  if (
    (options.measureMemory ?? adapterOverride === undefined) &&
    scoredEntries.length > 0
  ) {
    console.log(`    measuring peak RSS ...`);
    const memSample = scoredEntries.slice(0, MEMORY_SAMPLE_COUNT);
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

  const result = leafFromSamples(outcome.samples, {
    range: options.range,
    peakRSS_MB,
    computeCer: shouldComputeCer,
  });

  const cerStr =
    result.cer !== undefined ? ` | CER: ${(result.cer * 100).toFixed(2)}%` : "";
  console.log(
    `    done | WER: ${(result.wer * 100).toFixed(2)}%${cerStr} | RTF: ${result.meanRTF.toFixed(3)} | RSS: ${peakRSS_MB ? `${peakRSS_MB.min}/${peakRSS_MB.avg}/${peakRSS_MB.max}` : "N/A"} MB (min/avg/max)`,
  );
  // Printed unconditionally, including as a zero. `reportTranscriptionFailure` speaks once
  // per distinct reason and never says how many, so a log that only mentioned failures
  // when there were some could not tell "nothing failed" from "nothing counted them".
  console.log(
    `    failures: ${result.failures}/${result.utteranceCount} utterances scored as an empty hypothesis`,
  );

  return { result, samples: outcome.samples };
}
