import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";

async function checkFfmpeg(): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(
      "ffmpeg not found. Install via: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)",
    );
  }
}

function findFlacFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFlacFiles(fullPath));
    } else if (extname(entry.name).toLowerCase() === ".flac") {
      results.push(fullPath);
    }
  }
  return results;
}

async function convertFile(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  if (existsSync(outputPath)) return;

  const dir = join(outputPath, "..");
  mkdirSync(dir, { recursive: true });

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "-y",
      outputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg failed converting ${inputPath}`);
  }
}

export async function convertLibriSpeech(datasetsDir: string): Promise<void> {
  await checkFfmpeg();

  for (const split of ["test-clean", "test-other"]) {
    const splitDir = join(datasetsDir, "librispeech", split);
    if (!existsSync(splitDir)) {
      console.log(`[convert] ${split} not found, skipping`);
      continue;
    }

    const wavDir = join(datasetsDir, "librispeech", "wav", split);
    const flacFiles = findFlacFiles(splitDir);
    console.log(
      `[convert] ${split}: ${flacFiles.length} FLAC files to convert`,
    );

    let converted = 0;
    for (const flacPath of flacFiles) {
      const wavName = basename(flacPath, ".flac") + ".wav";
      const outputPath = join(wavDir, wavName);
      await convertFile(flacPath, outputPath);
      converted++;
      if (converted % 100 === 0) {
        console.log(`[convert] ${split}: ${converted}/${flacFiles.length}`);
      }
    }
    console.log(`[convert] ${split}: done (${converted} files)`);
  }
}

if (import.meta.main) {
  const datasetsDir = join(import.meta.dir, "../datasets");
  convertLibriSpeech(datasetsDir).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
