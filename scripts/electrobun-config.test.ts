import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { BINARY_MANIFEST } from "../src/shared/binary-manifest";
import { onnxRuntimeBuildCopy } from "./onnxruntime-bundle";

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

describe("the app bundle carries parakeet-cli and its licence", () => {
  test("electrobun.config.ts copies parakeet-cli from the binary manifest and bundles parakeet.cpp's MIT licence", async () => {
    const config = await loadConfig();
    const parakeetCli = BINARY_MANIFEST[process.platform === "win32" ? "windows" : "macos"]["parakeet-cli"]!;
    expect(config.build.copy[parakeetCli.source]).toBe(parakeetCli.destination);
    expect(config.build.copy["docs/licenses/parakeet-cpp"]).toBe("licenses/parakeet-cpp");
    const licence = await Bun.file(
      join(import.meta.dir, "..", "docs", "licenses", "parakeet-cpp", "LICENSE"),
    ).text();
    expect(licence).toContain("MIT License");
  });
});

/**
 * onnxruntime-node's `dist/binding.js` requires its binding at
 * `../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`, relative to the module that
 * runs. In the app that module is the bundled main process, `Resources/app/bun/index.js`,
 * so the binding must sit at `Resources/app/bin/napi-v6/...` (copy destinations are relative
 * to `Resources/app`).
 */
const ORT_PACKAGE = "node_modules/onnxruntime-node";

describe("the app bundle carries ONNX Runtime where the bundled main process requires it", () => {
  test("macOS copies the binding and the one library it links to bin/napi-v6/darwin/arm64", async () => {
    if (process.platform === "win32") return;
    const config = await loadConfig();
    expect(config.build.copy[`${ORT_PACKAGE}/bin/napi-v6/darwin/arm64/onnxruntime_binding.node`]).toBe(
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
    );
    expect(config.build.copy[`${ORT_PACKAGE}/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`]).toBe(
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
    );
    // The byte-identical versioned copy is 44.6 MB nothing links.
    expect(
      Object.keys(config.build.copy).filter((source) => source.startsWith(ORT_PACKAGE)),
    ).toHaveLength(2);
  });

  test("Windows copies the binding and onnxruntime.dll to bin/napi-v6/win32/x64, and no DirectML DLLs", () => {
    expect(onnxRuntimeBuildCopy("windows")).toEqual({
      [`${ORT_PACKAGE}/bin/napi-v6/win32/x64/onnxruntime_binding.node`]:
        "bin/napi-v6/win32/x64/onnxruntime_binding.node",
      [`${ORT_PACKAGE}/bin/napi-v6/win32/x64/onnxruntime.dll`]: "bin/napi-v6/win32/x64/onnxruntime.dll",
    });
    const shipped = Object.values(onnxRuntimeBuildCopy("windows")).join("\n").toLowerCase();
    for (const unused of ["directml.dll", "dxcompiler.dll", "dxil.dll"]) {
      expect(shipped).not.toContain(unused);
    }
  });

  test("onnxruntime-node still resolves its binding from bin/napi-v6 beside the requiring module's parent", async () => {
    const bindingJs = await Bun.file(join(import.meta.dir, "..", ORT_PACKAGE, "dist", "binding.js")).text();
    expect(bindingJs).toContain(
      "require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)",
    );
  });

  test("every ONNX Runtime copy source is in the installed package", () => {
    for (const platform of ["macos", "windows"] as const) {
      for (const source of Object.keys(onnxRuntimeBuildCopy(platform))) {
        expect(existsSync(join(import.meta.dir, "..", source))).toBe(true);
      }
    }
  });
});
