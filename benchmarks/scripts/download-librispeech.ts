import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATASETS_DIR = join(import.meta.dir, "../datasets/librispeech");

const SPLITS = [
  {
    name: "test-clean",
    url: "https://www.openslr.org/resources/12/test-clean.tar.gz",
  },
  {
    name: "test-other",
    url: "https://www.openslr.org/resources/12/test-other.tar.gz",
  },
];

async function downloadAndExtract(name: string, url: string): Promise<void> {
  const splitDir = join(DATASETS_DIR, name);
  if (existsSync(splitDir)) {
    console.log(`[librispeech] ${name} already exists, skipping`);
    return;
  }

  mkdirSync(DATASETS_DIR, { recursive: true });

  const tarPath = join(DATASETS_DIR, `${name}.tar.gz`);

  console.log(`[librispeech] downloading ${name} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${name}: ${response.status}`);
  }

  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  const totalMB = totalBytes
    ? `${(totalBytes / 1024 / 1024).toFixed(0)} MB`
    : "unknown size";
  console.log(`[librispeech] ${totalMB}`);

  const writer = Bun.file(tarPath).writer();
  const reader = response.body!.getReader();
  let downloaded = 0;
  let lastLog = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    downloaded += value.length;
    const now = Date.now();
    if (now - lastLog > 2000) {
      const pct = totalBytes
        ? ` (${((downloaded / totalBytes) * 100).toFixed(0)}%)`
        : "";
      process.stdout.write(
        `\r[librispeech] ${(downloaded / 1024 / 1024).toFixed(1)} MB${pct}`,
      );
      lastLog = now;
    }
  }
  await writer.end();
  console.log(`\n[librispeech] download complete`);

  console.log(`[librispeech] extracting ${name} ...`);
  const proc = Bun.spawn(["tar", "xzf", tarPath, "-C", DATASETS_DIR], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`tar extraction failed for ${name}`);
  }

  // LibriSpeech extracts into LibriSpeech/<split-name>/
  // Move to our expected location
  const extractedDir = join(DATASETS_DIR, "LibriSpeech", name);
  if (existsSync(extractedDir) && !existsSync(splitDir)) {
    const mv = Bun.spawn(["mv", extractedDir, splitDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await mv.exited;
  }

  // Cleanup
  try {
    const { unlinkSync, rmSync } = await import("node:fs");
    unlinkSync(tarPath);
    const lsDir = join(DATASETS_DIR, "LibriSpeech");
    if (existsSync(lsDir)) rmSync(lsDir, { recursive: true });
  } catch {
    // non-critical cleanup
  }

  console.log(`[librispeech] ${name} ready`);
}

export async function downloadLibriSpeech(): Promise<void> {
  for (const split of SPLITS) {
    await downloadAndExtract(split.name, split.url);
  }
}

if (import.meta.main) {
  downloadLibriSpeech().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
