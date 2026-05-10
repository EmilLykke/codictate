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

const ROOT = join(import.meta.dir, "../..");
const STT_JSON_PATH = Bun.argv[2]
  ? join(process.cwd(), Bun.argv[2])
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

const englishConditions: ConditionModels[] = Object.values(
  data.librispeech as Record<string, ConditionModels>,
);
const multilingualConditions: ConditionModels[] = Object.values(
  data.fleurs as Record<string, ConditionModels>,
);
const allConditions: ConditionModels[] = [
  ...englishConditions,
  ...multilingualConditions,
];

const modelIds = [
  ...new Set(allConditions.flatMap((c) => Object.keys(c))),
].sort();

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
