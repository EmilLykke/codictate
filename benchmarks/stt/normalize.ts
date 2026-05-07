/**
 * Text normalization matching Whisper's BasicTextNormalizer.
 * Applied to both hypothesis and reference before WER comparison.
 */

const WHISPER_ARTIFACTS_RE =
  /\[BLANK_AUDIO]|\(music\)|\[silence]|\[music]|\[MUSIC]|\[applause]|\[Applause]|\[laughter]|\[Laughter]/gi;

export function normalizeForWer(text: string): string {
  let t = text;
  t = t.replace(WHISPER_ARTIFACTS_RE, "");
  t = t.toLowerCase();
  // Strip anything that isn't a letter, number, or whitespace (keeps diacritics)
  t = t.replace(/[^\p{L}\p{N}\s]/gu, "");
  t = t.replace(/\s+/g, " ");
  t = t.trim();
  return t;
}
