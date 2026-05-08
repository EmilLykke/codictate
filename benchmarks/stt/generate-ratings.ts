#!/usr/bin/env bun
/**
 * Reads benchmarks/results/stt.json and generates src/shared/model-ratings.ts
 * with computed 1-10 ratings for speed, accuracy, and languages.
 *
 * Run: bun benchmarks/stt/generate-ratings.ts
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const STT_JSON_PATH = join(ROOT, "benchmarks/results/stt.json");
const OUTPUT_PATH = join(ROOT, "src/shared/model-ratings.ts");

const MODEL_SUPPORTED_LANGUAGES: Record<string, number> = {
  "small-q5_1": 99,
  "large-v3-turbo-q5_0": 99,
  "large-v3-q5_0": 99,
  "parakeet-tdt-0.6b-v3": 25,
};

interface DatasetResult {
  wer: number;
  meanRTF: number;
  totalAudioSec: number;
  totalWallSec: number;
}

function rateSpeed(rtf: number): number {
  if (rtf <= 0) return 1;
  const score = Math.round(10 - rtf * 9);
  return Math.max(1, Math.min(10, score));
}

function rateAccuracy(accuracy: number): number {
  const score = Math.round((accuracy - 0.5) * 18 + 1);
  return Math.max(1, Math.min(10, score));
}

function rateLanguages(count: number): number {
  if (count >= 90) return 10;
  if (count >= 50) return 9;
  if (count >= 25) return 8;
  if (count >= 10) return 6;
  if (count >= 5) return 4;
  return Math.max(1, Math.min(3, count));
}

const raw = await Bun.file(STT_JSON_PATH).text();
const data = JSON.parse(raw);

type ConditionModels = Record<string, DatasetResult>;

const conditions: ConditionModels[] = [
  ...Object.values(data.librispeech as Record<string, ConditionModels>),
  ...Object.values(data.fleurs as Record<string, ConditionModels>),
];

const modelIds = [
  ...new Set(conditions.flatMap((c) => Object.keys(c))),
].sort();

const rtfs = modelIds.map((id) => {
  let totalAudio = 0;
  let totalWall = 0;
  for (const cond of conditions) {
    const r = cond[id];
    if (r && r.meanRTF > 0) {
      totalAudio += r.totalAudioSec;
      totalWall += r.totalWallSec;
    }
  }
  return totalAudio > 0 ? totalWall / totalAudio : 0;
});

const accuracies = modelIds.map((id) => {
  const wers = conditions
    .map((c) => c[id]?.wer)
    .filter((w): w is number => w !== undefined && w >= 0);
  if (wers.length === 0) return 0;
  return 1 - wers.reduce((sum, w) => sum + w, 0) / wers.length;
});

const languageCounts = modelIds.map(
  (id) => MODEL_SUPPORTED_LANGUAGES[id] ?? 1,
);

const ratings: Record<string, { speed: number; accuracy: number; languages: number }> = {};
for (let i = 0; i < modelIds.length; i++) {
  ratings[modelIds[i]] = {
    speed: rateSpeed(rtfs[i]),
    accuracy: rateAccuracy(accuracies[i]),
    languages: rateLanguages(languageCounts[i]),
  };
}

const entries = Object.entries(ratings)
  .map(([id, r]) => `  "${id}": { speed: ${r.speed}, accuracy: ${r.accuracy}, languages: ${r.languages} },`)
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
