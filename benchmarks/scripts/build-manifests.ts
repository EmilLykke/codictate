import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry {
  id: string;
  audioPath: string;
  transcript: string;
  language: string;
  audioDurationSec: number;
}

// -- WAV duration from header (same logic as start-rec.ts) --

function readAscii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString("ascii");
}

function estimateWavDurationSec(filePath: string): number {
  const buf = Buffer.from(readFileSync(filePath));
  if (buf.length < 44) return 0;
  if (readAscii(buf, 0, 4) !== "RIFF") return 0;
  if (readAscii(buf, 8, 12) !== "WAVE") return 0;

  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (off + 8 <= buf.length) {
    const chunkId = readAscii(buf, off, off + 4);
    const chunkSize = buf.readUInt32LE(off + 4);
    const dataStart = off + 8;
    off += 8 + chunkSize + (chunkSize % 2);
    if (chunkId === "fmt ") {
      if (dataStart + 16 > buf.length) return 0;
      channels = buf.readUInt16LE(dataStart + 2);
      sampleRate = buf.readUInt32LE(dataStart + 4);
      bitsPerSample = buf.readUInt16LE(dataStart + 14);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return 0;
  const bytesPerFrame = channels * (bitsPerSample / 8);
  if (!bytesPerFrame || !Number.isInteger(bytesPerFrame)) return 0;
  return dataSize / bytesPerFrame / sampleRate;
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
): ManifestEntry[] {
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
        audioDurationSec: estimateWavDurationSec(wavPath),
      });
    }
  }

  console.log(`[manifest] LibriSpeech ${split}: ${entries.length} utterances`);
  return entries;
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

export function buildFleursManifest(
  datasetsDir: string,
  fleursLang: string,
  sampleSize: number,
): ManifestEntry[] {
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
    const transcript = cols[3]; // normalized transcription

    // FLEURS audio is in audio/test/<filename>
    const audioPath = join(langDir, "audio", "test", fileName);
    if (!existsSync(audioPath)) continue;

    rawEntries.push({
      id: `${fleursLang}_${id}`,
      audioPath,
      transcript,
      language: codLang,
      audioDurationSec: estimateWavDurationSec(audioPath),
    });
  }

  // Subsample with deterministic seed
  const shuffled = seededShuffle(rawEntries, 42);
  const sampled = shuffled.slice(0, sampleSize);

  console.log(
    `[manifest] FLEURS ${fleursLang}: ${sampled.length}/${rawEntries.length} utterances (sample ${sampleSize})`,
  );
  return sampled;
}

export function buildAllManifests(
  datasetsDir: string,
  fleursLanguages: string[],
  sampleSize: number,
): {
  librispeech: Record<string, ManifestEntry[]>;
  fleurs: Record<string, ManifestEntry[]>;
} {
  const librispeech: Record<string, ManifestEntry[]> = {};
  for (const split of ["test-clean", "test-other"]) {
    const entries = buildLibriSpeechManifest(datasetsDir, split);
    if (entries.length > 0) librispeech[split] = entries;
  }

  const fleurs: Record<string, ManifestEntry[]> = {};
  for (const lang of fleursLanguages) {
    const entries = buildFleursManifest(datasetsDir, lang, sampleSize);
    if (entries.length > 0) fleurs[lang] = entries;
  }

  return { librispeech, fleurs };
}

if (import.meta.main) {
  const datasetsDir = join(import.meta.dir, "../datasets");
  const result = buildAllManifests(
    datasetsDir,
    ["es_419", "da_dk", "hu_hu"],
    200,
  );
  const outputDir = join(import.meta.dir, "../results");
  mkdirSync(outputDir, { recursive: true });
  Bun.write(join(outputDir, "manifests.json"), JSON.stringify(result, null, 2));
  console.log("[manifest] written to results/manifests.json");
}
