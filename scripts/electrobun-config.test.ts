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
 * ekko-v1-tiny's licence files are the Mirror's, unchanged (#74, #105): bundled like Edda's,
 * at the same paths the Mirror holds them.
 */
describe("the app bundle carries ekko-v1-tiny's licence files", () => {
  const folder = join(import.meta.dir, "..", "docs", "licenses", "ekko-v1-tiny");

  test("electrobun.config.ts copies the ekko-v1-tiny licence folder", async () => {
    const config = await loadConfig();
    expect(config.build.copy["docs/licenses/ekko-v1-tiny"]).toBe("licenses/ekko-v1-tiny");
  });

  test("the folder holds the Mirror's NOTICE, MODEL_LICENSE.md and LICENSES, byte for byte", async () => {
    // sha256 of each file at Mirror commit d60b91ae714fdccf4ecd7a9f22a06b349c87ffc1, as
    // scripts/mirror-ekko.ts verified them against RyeAI/ekko-v1-tiny.
    const pinned: Record<string, string> = {
      NOTICE: "1d720ec5fac9815e9374778a39406cb23a775b44c7fb0185709461cc597affef",
      "MODEL_LICENSE.md": "3f0c10a453c459d4342fe0f079c98677fd733f9a49b5ad2084b5e2e159370c07",
      "LICENSES/CC-BY-4.0.txt": "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
      "LICENSES/CORAL-LICENSE": "ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd",
      "LICENSES/FTSPEECH-LICENSE.md": "39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a",
      "LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf": "4d2fb590aa9b30c47f2058bff17291df7fa2aa0c1bd775a20703da9bb267cfab",
    };
    for (const [path, sha256] of Object.entries(pinned)) {
      const bytes = await Bun.file(join(folder, path)).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sha256);
    }
  });

  test("NOTICE attributes ekko-v1-tiny to RyeAI under the NVIDIA Open Model License", async () => {
    const notice = await Bun.file(join(import.meta.dir, "..", "NOTICE")).text();
    const paragraph = notice.replace(/\s+/g, " ");
    expect(paragraph).toContain("ekko-v1-tiny by RyeAI");
    expect(paragraph).toContain("Licensed by NVIDIA Corporation under the NVIDIA Open Model License");
    expect(paragraph).toContain("nvidia/parakeet-rnnt-110m-da-dk");
    expect(paragraph).toContain("licenses/ekko-v1-tiny");
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
