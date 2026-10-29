import { getPlatformRuntime } from "../../src/bun/platform/runtime";
import type { PlatformRuntime } from "../../src/shared/platform";

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

/**
 * The `/usr/bin/time` argv and the env the measured process runs with.
 *
 * `env` is the measured command's whole environment, defaulting to this process's own.
 * ekko needs one: parakeet-cli reads `PARAKEET_ATT_CONTEXT` (`EKKO_ENV`), and peak RSS
 * has to be measured on the process the adapter actually runs. The locale is forced on
 * top either way, because the report is parsed in English.
 */
export function peakRssInvocation(
  command: string[],
  options: {
    platform: PlatformRuntime;
    env?: Record<string, string | undefined>;
  },
): { argv: string[]; env: Record<string, string | undefined> } {
  const timeFlag = options.platform === "macos" ? "-l" : "-v";
  return {
    argv: ["/usr/bin/time", timeFlag, ...command],
    env: {
      ...(options.env ?? process.env),
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    },
  };
}

export async function measurePeakRss(
  command: string[],
  options?: { env?: Record<string, string | undefined> },
): Promise<MemoryResult> {
  const invocation = peakRssInvocation(command, {
    platform: getPlatformRuntime(),
    env: options?.env,
  });

  const proc = Bun.spawn(invocation.argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: invocation.env,
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
