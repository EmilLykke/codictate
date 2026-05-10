const WHISPER_ARTIFACTS_RE =
  /\[BLANK_AUDIO]|\(music\)|\[silence]|\[music]|\[MUSIC]|\[applause]|\[Applause]|\[laughter]|\[Laughter]/gi;

export function normalizeForWer(text: string): string {
  let t = text;
  t = t.replace(WHISPER_ARTIFACTS_RE, "");
  t = t.toLowerCase();
  t = t.replace(/[^\p{L}\p{N}\s]/gu, "");
  t = t.replace(/\s+/g, " ");
  t = t.trim();
  return t;
}

export function normalizeForCer(text: string): string {
  let t = text;
  t = t.replace(WHISPER_ARTIFACTS_RE, "");
  t = t.trim();
  return t;
}
