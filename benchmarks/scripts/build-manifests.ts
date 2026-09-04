import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRISPEECH_SPLITS } from "../stt/datasets";
import { estimateWavDurationSecFromBytes } from "../../src/shared/wav-duration";

export interface ManifestEntry {
  id: string;
  audioPath: string;
  transcript: string;
  rawTranscript?: string;
  language: string;
  audioDurationSec: number;
}

function estimateWavDurationSec(filePath: string): number {
  return estimateWavDurationSecFromBytes(readFileSync(filePath)) ?? 0;
}

/**
 * Fill in `audioDurationSec` for the entries a Benchmark Run is about to transcribe.
 *
 * The companion to `withDurations: false`. A run now builds each dataset's *whole* ordered
 * manifest - it has to, because the sample cursor indexes into that list and its
 * fingerprint is taken over it - and reading the duration of every clip in every pool means
 * reading roughly a gigabyte off disk to transcribe a few hundred of them. Durations are
 * the denominator of RTF, so they are still measured, just only where they are used.
 */
export function hydrateDurations(
  entries: readonly ManifestEntry[],
): ManifestEntry[] {
  return entries.map((entry) =>
    entry.audioDurationSec > 0
      ? entry
      : { ...entry, audioDurationSec: estimateWavDurationSec(entry.audioPath) },
  );
}

/**
 * Options for building a manifest.
 *
 * `withDurations` exists because measuring a duration means reading the whole wav, so
 * building every manifest reads roughly a gigabyte off disk. A Benchmark Run needs the
 * durations - they are the denominator of RTF. A consumer that only needs *which*
 * entries were selected, in what order, does not, and reading them anyway competes for
 * disk with whatever run is in flight. Selection and order are unaffected either way,
 * so a manifest built without durations is the same sample in the same sequence.
 */
export interface ManifestOptions {
  /** Default true. Set false to leave `audioDurationSec` at 0 and read no audio. */
  withDurations?: boolean;
}

export interface LibriSpeechManifestOptions extends ManifestOptions {
  /**
   * Default true. Set false for the pre-shuffle traversal order.
   *
   * LibriSpeech was sampled in filesystem-traversal order until d8b91ee ("use seeded
   * shuffle for both", 2026-05-09), which is a fact about three archived Benchmark Runs
   * rather than an option a run should ever choose: those runs measured the first N
   * entries in traversal order, and reproducing which utterances they scored - to
   * recount a denominator, say - means reproducing that order. FLEURS has no such flag
   * because it was seeded from the start.
   */
  withShuffle?: boolean;
}

// -- Deterministic seeded shuffle --

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// -- LibriSpeech manifest --

function findTransFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTransFiles(fullPath));
    } else if (entry.name.endsWith(".trans.txt")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function buildLibriSpeechManifest(
  datasetsDir: string,
  split: string,
  options?: LibriSpeechManifestOptions,
): ManifestEntry[] {
  const withDurations = options?.withDurations ?? true;
  const splitDir = join(datasetsDir, "librispeech", split);
  const wavDir = join(datasetsDir, "librispeech", "wav", split);

  if (!existsSync(splitDir)) {
    console.log(`[manifest] LibriSpeech ${split} not found`);
    return [];
  }

  const transFiles = findTransFiles(splitDir);
  const entries: ManifestEntry[] = [];

  for (const transFile of transFiles) {
    const content = readFileSync(transFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) continue;

      const id = trimmed.slice(0, spaceIdx);
      const transcript = trimmed.slice(spaceIdx + 1);
      const wavPath = join(wavDir, `${id}.wav`);

      if (!existsSync(wavPath)) continue;

      entries.push({
        id,
        audioPath: wavPath,
        transcript,
        language: "en",
        audioDurationSec: withDurations ? estimateWavDurationSec(wavPath) : 0,
      });
    }
  }

  const ordered =
    (options?.withShuffle ?? true) ? seededShuffle(entries, 42) : entries;
  console.log(`[manifest] LibriSpeech ${split}: ${ordered.length} utterances`);
  return ordered;
}

// -- FLEURS manifest --

/** Map FLEURS locale codes to Codictate transcription language IDs. */
const FLEURS_TO_CODICTATE_LANG: Record<string, string> = {
  es_419: "es",
  da_dk: "da",
  hu_hu: "hu",
  en_us: "en",
  fr_fr: "fr",
  de_de: "de",
  it_it: "it",
  pt_br: "pt",
  pl_pl: "pl",
  nl_nl: "nl",
  ru_ru: "ru",
  cs_cz: "cs",
  el_gr: "el",
  fi_fi: "fi",
  sv_se: "sv",
  ro_ro: "ro",
  sk_sk: "sk",
  hr_hr: "hr",
  sl_si: "sl",
  bg_bg: "bg",
  uk_ua: "uk",
  et_ee: "et",
  lv_lv: "lv",
  lt_lt: "lt",
  ca_es: "ca",
};

/**
 * FLEURS entries for one locale, in seeded order.
 *
 * `sampleSize` truncates the ordered list, which a Benchmark Run must not do any more: the
 * sample cursor indexes into the full ordered pool and its fingerprint is taken over the
 * whole thing, so a truncated list would fingerprint differently at every depth. Pass
 * `Number.MAX_SAFE_INTEGER` for the full pool. The parameter survives for the standalone
 * `manifests.json` dump at the bottom of this file, which is a sample preview and not a
 * cursor.
 */
export function buildFleursManifest(
  datasetsDir: string,
  fleursLang: string,
  sampleSize: number,
  options?: ManifestOptions,
): ManifestEntry[] {
  const withDurations = options?.withDurations ?? true;
  const langDir = join(datasetsDir, "fleurs", fleursLang);
  const tsvPath = join(langDir, "test.tsv");

  if (!existsSync(tsvPath)) {
    console.log(`[manifest] FLEURS ${fleursLang} test.tsv not found`);
    return [];
  }

  const codLang =
    FLEURS_TO_CODICTATE_LANG[fleursLang] ?? fleursLang.split("_")[0];
  const content = readFileSync(tsvPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  // TSV columns: id, file_name, raw_transcription, transcription, num_samples, gender, ...
  // First line might be a header
  const firstLine = lines[0];
  const hasHeader =
    firstLine?.includes("file_name") || firstLine?.includes("transcription");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rawEntries: ManifestEntry[] = [];

  for (const line of dataLines) {
    const cols = line.split("\t");
    if (cols.length < 4) continue;

    const id = cols[0];
    const fileName = cols[1];
    const rawTranscript = cols[2];
    const transcript = cols[3]; // normalized transcription

    // FLEURS audio is in audio/test/<filename>
    const audioPath = join(langDir, "audio", "test", fileName);
    if (!existsSync(audioPath)) continue;

    rawEntries.push({
      id: `${fleursLang}_${id}`,
      audioPath,
      transcript,
      rawTranscript,
      language: codLang,
      audioDurationSec: withDurations ? estimateWavDurationSec(audioPath) : 0,
    });
  }

  // Subsample with deterministic seed
  const shuffled = seededShuffle(rawEntries, 42);
  const sampled = shuffled.slice(0, sampleSize);

  const truncated = sampled.length < rawEntries.length;
  console.log(
    `[manifest] FLEURS ${fleursLang}: ${sampled.length}/${rawEntries.length} utterances${truncated ? ` (sample ${sampleSize})` : ""}`,
  );
  return sampled;
}

/**
 * Every selected dataset's *complete* ordered manifest, without durations.
 *
 * Complete and unsliced because the sample cursor is an offset into this list: a run that
 * built a 400-entry prefix could neither fingerprint the ordering nor tell how many clips
 * are left. Depth is chosen afterwards, per (Speech Model, dataset), by
 * `planRange` in `stt/sample-cursor.ts`.
 *
 * Without durations because building every pool in full would otherwise read every wav in
 * the datasets directory. `hydrateDurations` measures the selected clips instead.
 */
export function buildAllManifests(
  datasetsDir: string,
  fleursLanguages: string[],
  librispeechSplits: readonly string[] = LIBRISPEECH_SPLITS,
): {
  librispeech: Record<string, ManifestEntry[]>;
  fleurs: Record<string, ManifestEntry[]>;
} {
  const librispeech: Record<string, ManifestEntry[]> = {};
  for (const split of librispeechSplits) {
    const entries = buildLibriSpeechManifest(datasetsDir, split, {
      withDurations: false,
    });
    if (entries.length > 0) librispeech[split] = entries;
  }

  const fleurs: Record<string, ManifestEntry[]> = {};
  for (const lang of fleursLanguages) {
    const entries = buildFleursManifest(
      datasetsDir,
      lang,
      Number.MAX_SAFE_INTEGER,
      { withDurations: false },
    );
    if (entries.length > 0) fleurs[lang] = entries;
  }

  return { librispeech, fleurs };
}

if (import.meta.main) {
  const datasetsDir = join(import.meta.dir, "../datasets");
  const result = buildAllManifests(datasetsDir, ["es_419", "da_dk", "hu_hu"]);
  const outputDir = join(import.meta.dir, "../results");
  mkdirSync(outputDir, { recursive: true });
  Bun.write(join(outputDir, "manifests.json"), JSON.stringify(result, null, 2));
  console.log("[manifest] written to results/manifests.json");
}
