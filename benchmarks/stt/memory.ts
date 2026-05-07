import { getPlatformRuntime } from "../../src/bun/platform/runtime";

interface MemoryResult {
  peakRssBytes: number | null;
  exitCode: number;
}

function parseMaxRss(stderr: string): number | null {
  // macOS /usr/bin/time -l reports bytes:
  //   "12345678  maximum resident set size"
  const match = stderr.match(/(\d+)\s+maximum resident set size/);
  if (match) return parseInt(match[1], 10);
  // GNU /usr/bin/time -v reports KB:
  //   "Maximum resident set size (kbytes): 12345"
  const gnuMatch = stderr.match(
    /Maximum resident set size \(kbytes\):\s*(\d+)/,
  );
  if (gnuMatch) return parseInt(gnuMatch[1], 10) * 1024;
  return null;
}

export async function measurePeakRss(command: string[]): Promise<MemoryResult> {
  const platform = getPlatformRuntime();

  let timeCmd: string[];
  if (platform === "macos") {
    timeCmd = ["/usr/bin/time", "-l", ...command];
  } else {
    timeCmd = ["/usr/bin/time", "-v", ...command];
  }

  const proc = Bun.spawn(timeCmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    },
  });

  const stderrChunks: Uint8Array[] = [];
  const stderrReader = proc.stderr!.getReader();
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    if (value) stderrChunks.push(value);
  }
  await proc.exited;

  const stderrText = new TextDecoder().decode(Buffer.concat(stderrChunks));
  const peakRssBytes = parseMaxRss(stderrText);

  return {
    peakRssBytes,
    exitCode: proc.exitCode ?? 1,
  };
}
