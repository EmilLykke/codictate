import { getSpeechModel } from "../../src/shared/speech-models";

export const ACCURACY_FLOOR = 0.5;
export const ACCURACY_CEILING = 0.95;
export const SPEED_RATING_THRESHOLD_MS = 350;

export function rateSpeed(rtf: number): number {
  if (rtf <= 0) return 1;
  const ms = rtf * 1000;
  return Math.max(
    1,
    Math.min(10, Math.round(10 - (9 * ms) / SPEED_RATING_THRESHOLD_MS)),
  );
}

export function rateAccuracy(accuracy: number | null): number {
  if (accuracy === null) return 1;
  const range = ACCURACY_CEILING - ACCURACY_FLOOR;
  return Math.max(
    1,
    Math.min(
      10,
      Math.round(1 + (9 * Math.max(0, accuracy - ACCURACY_FLOOR)) / range),
    ),
  );
}

export function rateLanguages(count: number): number {
  if (count >= 90) return 10;
  if (count >= 50) return 9;
  if (count >= 25) return 8;
  if (count >= 10) return 6;
  if (count >= 5) return 4;
  return Math.max(1, Math.min(3, count));
}

/**
 * A declared language list is authoritative for any Speech Engine, not just Parakeet:
 * the hviske Speech Models declare Danish alone, and reading them as multilingual
 * whisper.cpp weights rated them 10 for languages.
 */
export function modelSupportedLanguages(id: string): number {
  const model = getSpeechModel(id);
  if (!model) return 1;
  const declared = model.supportedTranscriptionLanguageIds;
  if (declared) return declared.length;
  if (id.includes(".en")) return 1;
  return 99;
}

/**
 * True only for Speech Models that can produce English and nothing else, which is what
 * makes averaging their accuracy over the English conditions alone the fair reading.
 * A single-language model in some other language (hviske, Danish) is not this: it would
 * be judged on conditions it cannot answer either way.
 */
export function isEnglishOnlyModel(id: string): boolean {
  const declared = getSpeechModel(id)?.supportedTranscriptionLanguageIds;
  if (declared) return declared.length === 1 && declared[0] === "en";
  return id.includes(".en");
}
