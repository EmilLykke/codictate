#!/usr/bin/env bun
/**
 * Reads an stt.json benchmark file and generates src/shared/model-ratings.ts
 * with computed 1-10 ratings for speed, accuracy, and languages.
 *
 * Run: bun benchmarks/stt/generate-ratings.ts [path/to/stt.json]
 *
 * If no path is given, defaults to benchmarks/results/stt.json.
 */

import { join } from "node:path";
import {
  rateSpeed,
  rateAccuracy,
  rateLanguages,
  modelSupportedLanguages,
  isEnglishOnlyModel,
} from "./rating-utils";
import {
  harnessBucketForModel,
  harnessLabelsPresent,
  isBenchmarkHarnessLabel,
  normalizeDatasetResults,
  DEFAULT_HARNESS_LABEL,
  type BenchmarkHarnessLabel,
  type DatasetResults,
} from "./results-schema";
import { getSpeechModel } from "../../src/shared/speech-models";

const ROOT = join(import.meta.dir, "../..");
const args = Bun.argv.slice(2);

/**
 * Which archived Harness's numbers to rate from. Defaults to the shipping Harness and
 * has to be named out loud to read any other, because substituting a retired Harness's
 * measurements for the shipping one's is a product decision, not a fallback.
 */
const harnessArg = args
  .find((a) => a.startsWith("--harness="))
  ?.slice("--harness=".length);
if (harnessArg !== undefined && !isBenchmarkHarnessLabel(harnessArg)) {
  console.error(`Error: unknown --harness=${harnessArg}`);
  process.exit(1);
}
const RATING_HARNESS: BenchmarkHarnessLabel =
  harnessArg ?? DEFAULT_HARNESS_LABEL;

const positional = args.find((a) => !a.startsWith("--"));
const STT_JSON_PATH = positional
  ? join(process.cwd(), positional)
  : join(ROOT, "benchmarks/results/stt.json");
const OUTPUT_PATH = join(ROOT, "src/shared/model-ratings.ts");

interface DatasetResult {
  wer: number;
  meanRTF: number;
  totalAudioSec: number;
  totalWallSec: number;
}

const raw = await Bun.file(STT_JSON_PATH).text();
const data = JSON.parse(raw);

type ConditionModels = Record<string, DatasetResult>;

const librispeech = normalizeDatasetResults(data.librispeech);
const fleurs = normalizeDatasetResults(data.fleurs);

/**
 * Whether one archived bucket's entry for a Speech Model is the one to rate from.
 *
 * Ratings describe what users get, so they come from one ASR Harness only - the
 * shipping one unless `--harness=` says otherwise. Results from any other Harness exist
 * to answer whether it should become the shipping one and must not leak into the app's
 * model ratings.
 *
 * The rule is `harnessBucketForModel`, not a plain bucket match, because two Engines
 * never sat in the rating Harness's bucket in the first place: Parakeet runs through
 * its own helper and hviske is pinned to crispasr's cohere backend. Their numbers are
 * Harness-independent by construction, so excluding them would drop real measurements
 * for no reason.
 */
function ratesFrom(bucket: string, modelId: string): boolean {
  return harnessBucketForModel(modelId, RATING_HARNESS) === bucket;
}

function ratingHarnessConditions(results: DatasetResults): ConditionModels[] {
  return Object.values(results).map((byHarness) => {
    const models: ConditionModels = {};
    for (const [bucket, byModel] of Object.entries(byHarness)) {
      for (const [modelId, result] of Object.entries(byModel ?? {})) {
        if (ratesFrom(bucket, modelId)) {
          models[modelId] = result as DatasetResult;
        }
      }
    }
    return models;
  });
}

const englishConditions = ratingHarnessConditions(librispeech);
const multilingualConditions = ratingHarnessConditions(fleurs);
const allConditions: ConditionModels[] = [
  ...englishConditions,
  ...multilingualConditions,
];

const modelIds = [
  ...new Set(allConditions.flatMap((c) => Object.keys(c))),
].sort();

/**
 * Refuse to write a ratings file the input cannot support.
 *
 * `src/shared/model-ratings.ts` drives the speed/accuracy/language bars in the model
 * picker, and this script overwrites it wholesale, so every silent partial read here
 * lands in the UI. Three ways that goes wrong, all now fatal:
 *
 * - No results under the rating Harness at all.
 * - A key that is not a known Model ID, which means the harness level was misread and
 *   Harness names were taken for Speech Models.
 * - Speech Models measured in this file under some *other* Harness but not under the
 *   rating one. This is the case a pre-harness archive now hits: 33 whisper Speech
 *   Models measured under whisper-cli and only Parakeet in the shipping bucket, which
 *   would quietly rewrite the ratings file down to a single model.
 */
const availableLabels = harnessLabelsPresent(librispeech, fleurs);
const unknownIds = modelIds.filter((id) => !getSpeechModel(id));

/**
 * Model IDs this file measured that the rating Harness rule then excluded. Judged with
 * the same `ratesFrom` rule, so a Parakeet or hviske result sitting in its own forced
 * bucket is never counted as dropped.
 */
const droppedIds = new Set<string>();
for (const results of [librispeech, fleurs]) {
  for (const byHarness of Object.values(results)) {
    for (const [bucket, byModel] of Object.entries(byHarness)) {
      for (const modelId of Object.keys(byModel ?? {})) {
        if (!ratesFrom(bucket, modelId)) droppedIds.add(modelId);
      }
    }
  }
}
for (const id of modelIds) droppedIds.delete(id);
const droppedList = [...droppedIds].sort();

if (modelIds.length === 0 || unknownIds.length > 0 || droppedList.length > 0) {
  console.error(`Error: cannot derive ratings from ${STT_JSON_PATH}`);
  if (unknownIds.length > 0) {
    console.error(
      `  keys that are not Speech Model IDs: ${unknownIds.join(", ")}`,
    );
  } else if (modelIds.length === 0) {
    console.error(`  no results under ASR Harness "${RATING_HARNESS}"`);
  } else {
    console.error(
      `  ${droppedList.length} Speech Model(s) measured here but not under "${RATING_HARNESS}", so rating from this file would drop them: ${droppedList.join(", ")}`,
    );
  }
  console.error(
    `  Harnesses present in this file: ${availableLabels.join(", ") || "none"}`,
  );
  console.error(
    `  Pass --harness=<label> to rate from an archived Harness on purpose, or point at a run measured under ${RATING_HARNESS}.`,
  );
  process.exit(1);
}

if (RATING_HARNESS !== DEFAULT_HARNESS_LABEL) {
  console.warn(
    `Warning: rating from archived ASR Harness "${RATING_HARNESS}", not the shipping "${DEFAULT_HARNESS_LABEL}".`,
  );
}

const rtfs = modelIds.map((id) => {
  let totalAudio = 0;
  let totalWall = 0;
  for (const cond of allConditions) {
    const r = cond[id];
    if (r && r.meanRTF > 0) {
      totalAudio += r.totalAudioSec;
      totalWall += r.totalWallSec;
    }
  }
  return totalAudio > 0 ? totalWall / totalAudio : 0;
});

function avgAccuracy(id: string, conditions: ConditionModels[]): number {
  const wers = conditions
    .map((c) => c[id]?.wer)
    .filter((w): w is number => w !== undefined && w >= 0);
  if (wers.length === 0) return 0;
  return 1 - wers.reduce((sum, w) => sum + w, 0) / wers.length;
}

const accuracies = modelIds.map((id) =>
  avgAccuracy(id, isEnglishOnlyModel(id) ? englishConditions : allConditions),
);

const languageCounts = modelIds.map((id) => modelSupportedLanguages(id));

const ratings: Record<
  string,
  { speed: number; accuracy: number; languages: number }
> = {};
for (let i = 0; i < modelIds.length; i++) {
  ratings[modelIds[i]] = {
    speed: rateSpeed(rtfs[i]),
    accuracy: rateAccuracy(accuracies[i]),
    languages: rateLanguages(languageCounts[i]),
  };
}

const entries = Object.entries(ratings)
  .map(
    ([id, r]) =>
      `  "${id}": { speed: ${r.speed}, accuracy: ${r.accuracy}, languages: ${r.languages} },`,
  )
  .join("\n");

const output = `/**
 * Model ratings (1-10) computed from benchmark data.
 * Regenerate by running: bun benchmarks/stt/generate-ratings.ts
 */

export interface ModelRatings {
  speed: number;
  accuracy: number;
  languages: number;
}

export const MODEL_RATINGS: Record<string, ModelRatings> = {
${entries}
};
`;

await Bun.write(OUTPUT_PATH, output);
console.log(`Wrote ratings to ${OUTPUT_PATH}`);
console.log(ratings);
