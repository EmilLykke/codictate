/**
 * Model ratings (1-10) for the in-app model picker and website.
 * These are curated values that reflect real-world user experience.
 * Regenerate by running: bun benchmarks/stt/generate-ratings.ts
 */

export interface ModelRatings {
  speed: number
  accuracy: number
  languages: number
}

export const MODEL_RATINGS: Record<string, ModelRatings> = {
  'large-v3-q5_0': { speed: 6, accuracy: 10, languages: 10 },
  'large-v3-turbo-q5_0': { speed: 7, accuracy: 9, languages: 9 },
  'parakeet-tdt-0.6b-v3': { speed: 10, accuracy: 8, languages: 8 },
  'small-q5_1': { speed: 8, accuracy: 6, languages: 4 },
}
