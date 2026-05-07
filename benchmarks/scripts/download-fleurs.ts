import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATASETS_DIR = join(import.meta.dir, "../datasets/fleurs");

export const DEFAULT_FLEURS_LANGUAGES = ["es_419", "da_dk", "hu_hu"];

async function downloadLanguage(lang: string): Promise<void> {
  const langDir = join(DATASETS_DIR, lang);
  const audioDir = join(langDir, "audio", "test");

  if (existsSync(langDir) && existsSync(audioDir)) {
    console.log(`[fleurs] ${lang} already exists, skipping`);
    return;
  }

  mkdirSync(DATASETS_DIR, { recursive: true });

  console.log(`[fleurs] downloading ${lang} test split via hf ...`);

  const proc = Bun.spawn(
    [
      "hf",
      "download",
      "google/fleurs",
      `data/${lang}/audio/test.tar.gz`,
      `data/${lang}/test.tsv`,
      "--repo-type",
      "dataset",
      "--local-dir",
      DATASETS_DIR,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`hf download failed for ${lang}`);
  }

  // hf downloads into DATASETS_DIR/data/<lang>/
  // Move to our expected layout: DATASETS_DIR/<lang>/
  const hfDir = join(DATASETS_DIR, "data", lang);
  if (existsSync(hfDir) && !existsSync(langDir)) {
    const mv = Bun.spawn(["mv", hfDir, langDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await mv.exited;
  }

  // Extract audio tar.gz (tar contains test/<files>.wav)
  const tarPath = join(langDir, "audio", "test.tar.gz");
  if (existsSync(tarPath)) {
    console.log(`[fleurs] extracting ${lang} audio ...`);
    const tar = Bun.spawn(
      ["tar", "xzf", tarPath, "-C", join(langDir, "audio")],
      { stdout: "inherit", stderr: "inherit" },
    );
    await tar.exited;
    if (tar.exitCode !== 0) {
      throw new Error(`tar extraction failed for ${lang}`);
    }
    // Remove tar after extraction
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tarPath);
  }

  // Cleanup empty data/ dir
  try {
    const dataDir = join(DATASETS_DIR, "data");
    if (existsSync(dataDir)) {
      const { rmdirSync } = await import("node:fs");
      rmdirSync(dataDir);
    }
  } catch {
    // ignore if not empty (other languages still in progress)
  }

  console.log(`[fleurs] ${lang} ready`);
}

export async function downloadFleurs(
  languages: string[] = DEFAULT_FLEURS_LANGUAGES,
): Promise<void> {
  for (const lang of languages) {
    await downloadLanguage(lang);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const langs = args.length > 0 ? args : DEFAULT_FLEURS_LANGUAGES;
  downloadFleurs(langs).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
