import { describe, expect, test } from "bun:test";
import { join } from "path";
import { BINARY_MANIFEST } from "../src/shared/binary-manifest";

const CHANNEL_KEY = "process.env.CODICTATE_CHANNEL";

/** Loaded by path: electrobun.config.ts sits outside tsconfig.bun.json's composite file list. */
async function loadConfig(): Promise<{
  build: { bun: { define: Record<string, string> }; copy: Record<string, string> };
}> {
  const configPath = join(import.meta.dir, "..", "electrobun.config.ts");
  return (await import(configPath)).default;
}

describe("the app bundle knows its channel", () => {
  test("electrobun.config.ts inlines the channel it copied the Parakeet helper for", async () => {
    const config = await loadConfig();
    expect(config.build.bun.define[CHANNEL_KEY]).toBe(
      JSON.stringify(process.env.CODICTATE_CHANNEL ?? "dev"),
    );
    if (process.platform !== "win32") {
      const parakeet = BINARY_MANIFEST.macos.parakeet!;
      expect(config.build.copy[parakeet.source]).toBe(parakeet.destination);
    }
  });

  test("the define reaches binary-manifest.ts's channel read in a bundle", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/shared/binary-manifest.ts")],
      target: "bun",
      define: { [CHANNEL_KEY]: JSON.stringify("canary") },
    });
    expect(result.success).toBe(true);
    const bundled = await result.outputs[0]!.text();
    expect(bundled).not.toContain(CHANNEL_KEY);
    expect(bundled).toContain('buildChannelFrom("canary")');
  });
});
