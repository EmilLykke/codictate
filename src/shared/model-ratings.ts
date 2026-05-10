/**
 * Model ratings (1-10) computed from benchmark data.
 * Regenerate by running: bun benchmarks/stt/generate-ratings.ts
 */

export interface ModelRatings {
  speed: number;
  accuracy: number;
  languages: number;
}

export const MODEL_RATINGS: Record<string, ModelRatings> = {
  "base": { speed: 9, accuracy: 5, languages: 10 },
  "base-q5_1": { speed: 9, accuracy: 5, languages: 10 },
  "base-q8_0": { speed: 9, accuracy: 5, languages: 10 },
  "base.en": { speed: 8, accuracy: 9, languages: 1 },
  "base.en-q5_1": { speed: 9, accuracy: 9, languages: 1 },
  "base.en-q8_0": { speed: 9, accuracy: 9, languages: 1 },
  "large-v1": { speed: 5, accuracy: 9, languages: 10 },
  "large-v2": { speed: 5, accuracy: 9, languages: 10 },
  "large-v2-q5_0": { speed: 6, accuracy: 9, languages: 10 },
  "large-v2-q8_0": { speed: 6, accuracy: 9, languages: 10 },
  "large-v3": { speed: 5, accuracy: 10, languages: 10 },
  "large-v3-q5_0": { speed: 6, accuracy: 9, languages: 10 },
  "large-v3-turbo": { speed: 7, accuracy: 9, languages: 10 },
  "large-v3-turbo-q5_0": { speed: 7, accuracy: 9, languages: 10 },
  "large-v3-turbo-q8_0": { speed: 7, accuracy: 9, languages: 10 },
  "medium": { speed: 7, accuracy: 9, languages: 10 },
  "medium-q5_0": { speed: 7, accuracy: 9, languages: 10 },
  "medium-q8_0": { speed: 7, accuracy: 9, languages: 10 },
  "medium.en": { speed: 7, accuracy: 10, languages: 1 },
  "medium.en-q5_0": { speed: 8, accuracy: 10, languages: 1 },
  "medium.en-q8_0": { speed: 7, accuracy: 10, languages: 1 },
  "parakeet-tdt-0.6b-v3": { speed: 10, accuracy: 9, languages: 8 },
  "small": { speed: 8, accuracy: 7, languages: 10 },
  "small-q5_1": { speed: 8, accuracy: 7, languages: 10 },
  "small-q8_0": { speed: 8, accuracy: 7, languages: 10 },
  "small.en": { speed: 8, accuracy: 10, languages: 1 },
  "small.en-q5_1": { speed: 8, accuracy: 10, languages: 1 },
  "small.en-q8_0": { speed: 8, accuracy: 10, languages: 1 },
  "tiny": { speed: 9, accuracy: 3, languages: 10 },
  "tiny-q5_1": { speed: 9, accuracy: 2, languages: 10 },
  "tiny-q8_0": { speed: 9, accuracy: 3, languages: 10 },
  "tiny.en": { speed: 8, accuracy: 9, languages: 1 },
  "tiny.en-q5_1": { speed: 8, accuracy: 9, languages: 1 },
  "tiny.en-q8_0": { speed: 8, accuracy: 9, languages: 1 },
};
