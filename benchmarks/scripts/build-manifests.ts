import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRISPEECH_SPLITS } from "../stt/datasets";
import { estimateWavDurationSecFromBytes } from "../../src/shared/wav-duration";
import {
  assertUniqueClipIds,
  fleursClipId,
  librispeechClipId,
} from "../contract";

export interface ManifestEntry {
  /**
   * The legacy manifest id, and **not** the identity of the clip.
   *
   * FLEURS spells it `<locale>_<TSV column 0>`, and column 0 is a *sentence* id that
   * several recordings share: `da_dk/test.tsv` has 930 rows and 350 distinct column-0
   * values (measured, `benchmarks/contract/fleurs-identity.manual.ts`). So this string
   * repeats, and anything that treats it as identity collapses 930 Danish clips to 350.
   *
   * It survives for exactly one reason: `manifestFingerprint` in
   * `benchmarks/stt/sample-cursor.ts` is computed over it, and that v1 ordering token is
   * recorded in every archived leaf's `sampleRange`. Recomputing it over `clipId` would
   * change the token for every dataset, and every archived offset would then read as a
   * pointer into a list that no longer exists - `manifestFingerprintConflicts` would
   * refuse every run. The v1 token is frozen legacy; identity is `clipId`.
   */
  id: string;
  /**
   * Canonical clip identity: the audio file's corpus-relative POSIX path.
   *
   * The one string a measurement is keyed by, in this repository and in
   * `dictation-product-benchmark`. Derived through `benchmarks/contract/clip-identity.ts`
   * rather than assembled here, so the two repositories cannot spell it differently.
   * Unique by construction - `buildFleursManifest` and `buildLibriSpeechManifest` assert
   * it before they return.
   */
  clipId: string;
  /**
   * FLEURS TSV column 0. Metadata, never identity.
   *
   * Kept because it is the right key for "did the model get this *sentence* right across
   * speakers", and absent for LibriSpeech, which has no sentence level. Never a dedup
   * key and never a fingerprint input; see `clipId`.
   */
  sentenceId?: string;
  audioPath: string;
  transcript: string;
  rawTranscript?: string;
  language: string;
  audioDurationSec: number;
}

/**
 * A clip's duration in seconds, or a refusal.
 *
 * Throws rather than returning `0`, which is what the `?? 0` here used to do. A zero
 * duration is the denominator of every speed metric, and the contract's own review found
 * the hole worse than a division by zero: a zero-duration Sample was treated as a silent
 * zero denominator, and the failure was in the **flattering** direction - it discounted a
 * pooled ratio rather than inflating it. There is no honest number to substitute for "the
 * WAV header would not parse", so the run stops on the clip it cannot measure and names
 * it, which is recoverable (`--resume <runId>` re-reads the plan and re-measures nothing
 * already done) in a way a published discount is not.
 *
 * The contract guards a zero from any source as well, counting it under
 * `missingDurationCount` rather than `speedExcludedCount` - a bad WAV and a mistimed
 * hotkey want different fixes. This is the upstream half.
 */
function estimateWavDurationSec(filePath: string): number {
  const seconds = estimateWavDurationSecFromBytes(readFileSync(filePath));
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `Cannot read the audio duration of ${filePath} (parsed ${seconds ?? "nothing"}). ` +
        `A duration is the denominator of every speed metric, so a clip without one cannot ` +
        `be measured - and a zero there discounts the pooled ratio instead of failing. ` +
        `Re-download or re-convert that clip, then resume the run.`,
    );
  }
  return seconds;
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
        clipId: librispeechClipId(split, id),
        audioPath: wavPath,
        transcript,
        language: "en",
        audioDurationSec: withDurations ? estimateWavDurationSec(wavPath) : 0,
      });
    }
  }

  const ordered =
    (options?.withShuffle ?? true) ? seededShuffle(entries, 42) : entries;
  // Cheap here and unfixable later: a duplicate clipId means one audio file would be
  // measured twice under one identity, so a pool would keep one of the two measurements
  // and a resume would skip the other. LibriSpeech utterance ids are unique across the
  // corpus, so this only ever fires on a broken checkout - which is exactly when a
  // Benchmark Run must not start.
  assertUniqueClipIds(
    ordered.map((entry) => entry.clipId),
    `LibriSpeech ${split} manifest`,
  );
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
 * One locale's FLEURS entries, parsed out of `test.tsv` in the file's own row order.
 *
 * The pure half of `buildFleursManifest`: no shuffle, no durations, and the only
 * filesystem question - "is this clip's wav on disk" - is a callback. Extracted so the
 * identity rule can be asserted on every machine. `benchmarks/datasets/` is git-ignored
 * (the corpora are gigabytes), so a test that reads the real TSV has to be a `.manual.ts`
 * or `bun test` goes red on a fresh checkout; this seam lets the CI-safe test assert the
 * same rule against a synthetic mirror of the same shape.
 *
 * `audioDurationSec` is left at 0. The caller measures the clips it is about to
 * transcribe, through `hydrateDurations`.
 */
export function fleursEntriesFromTsv(
  fleursLang: string,
  tsvText: string,
  options?: {
    /** Absolute directory the wavs live in. Only used to build `audioPath`. */
    audioDir?: string;
    /** Default: every row is kept. `buildFleursManifest` passes `existsSync`. */
    hasAudio?: (audioPath: string) => boolean;
  },
): ManifestEntry[] {
  const codLang =
    FLEURS_TO_CODICTATE_LANG[fleursLang] ?? fleursLang.split("_")[0];
  const audioDir = options?.audioDir ?? "";
  const hasAudio = options?.hasAudio ?? (() => true);

  const lines = tsvText.split("\n").filter((l) => l.trim());

  // TSV columns: id, file_name, raw_transcription, transcription, num_samples, gender, ...
  //
  // Column 0 is the *sentence* id and repeats - FLEURS reads several speakers per
  // sentence - so identity is column 1, `file_name`. See `ManifestEntry.clipId` and
  // `benchmarks/contract/clip-identity.ts::fleursClipId`.
  //
  // First line might be a header. The three downloaded locales have none, so this is a
  // guard against a differently-exported TSV rather than the normal case.
  const firstLine = lines[0];
  const hasHeader =
    firstLine?.includes("file_name") || firstLine?.includes("transcription");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const entries: ManifestEntry[] = [];
  for (const line of dataLines) {
    const cols = line.split("\t");
    if (cols.length < 4) continue;

    const sentenceId = cols[0];
    const fileName = cols[1];
    const rawTranscript = cols[2];
    const transcript = cols[3]; // normalized transcription

    // FLEURS audio is in audio/test/<filename>
    const audioPath = join(audioDir, fileName);
    if (!hasAudio(audioPath)) continue;

    entries.push({
      // Legacy, non-unique, and kept only so the v1 `manifestFingerprint` token does not
      // move under every archived `sampleRange`. See `ManifestEntry.id`.
      id: `${fleursLang}_${sentenceId}`,
      clipId: fleursClipId(fleursLang, fileName),
      sentenceId,
      audioPath,
      transcript,
      rawTranscript,
      language: codLang,
      audioDurationSec: 0,
    });
  }

  // The assertion that would have caught the whole class of bug: with identity taken
  // from column 0 this list holds 930 Danish entries under 350 distinct ids, and every
  // consumer downstream - resume, pooling, coverage - would have treated 580 of them as
  // repeats of clips already done. Asserted on `clipId` (column 1), which is unique.
  assertUniqueClipIds(
    entries.map((entry) => entry.clipId),
    `FLEURS ${fleursLang} manifest`,
  );
  return entries;
}

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

  const rawEntries = fleursEntriesFromTsv(
    fleursLang,
    readFileSync(tsvPath, "utf-8"),
    {
      audioDir: join(langDir, "audio", "test"),
      hasAudio: existsSync,
    },
  ).map((entry) =>
    withDurations
      ? { ...entry, audioDurationSec: estimateWavDurationSec(entry.audioPath) }
      : entry,
  );

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
