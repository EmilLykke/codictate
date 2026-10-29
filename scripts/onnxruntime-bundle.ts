// ONNX Runtime in the app bundle: what electrobun.config.ts copies from onnxruntime-node and
// what scripts/post-build.ts checks and signs. The Punctuation Restorer runs ekko-pnc on it
// (src/bun/utils/punctuation/ekko-pnc-model.ts).
//
// onnxruntime-node is prebuilt (ADR-0001): its npm package carries the native files for every
// platform, pinned by package.json and bun.lock. Bun bundles its JavaScript into the main
// process; the native files are copied here.

import { existsSync } from "fs";
import { join } from "path";

export type OnnxRuntimePlatform = "macos" | "windows";

const PACKAGE_DIR = "node_modules/onnxruntime-node";

/**
 * Where the bundled main process looks for onnxruntime-node's native binding, relative to
 * `Resources/app` (the root every `build.copy` destination is relative to).
 *
 * onnxruntime-node's `dist/binding.js` loads it with
 * `require(\`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node\`)`.
 * Bun leaves that template require dynamic when it bundles the main process, so it resolves
 * relative to the bundle, `Resources/app/bun/index.js`, not to node_modules: the binding has
 * to be at `Resources/app/bin/napi-v6/<platform>/<arch>/`. A scratch build loaded it from
 * there and failed without it. The path segments are Node's `process.platform` and
 * `process.arch` spellings (`darwin`, `win32`), not Codictate's platform names. The runtime
 * library sits in the same folder because the binding finds it there: through
 * `@rpath = @loader_path` on macOS, and the DLL search of the binding's folder on Windows.
 */
export const ONNXRUNTIME_BINDING_DIRS: Record<OnnxRuntimePlatform, string> = {
  macos: "bin/napi-v6/darwin/arm64",
  windows: "bin/napi-v6/win32/x64",
};

/**
 * The files shipped from onnxruntime-node, per platform.
 *
 * - macOS: the binding and `libonnxruntime.1.dylib`, the only library it links. Not the
 *   byte-identical `libonnxruntime.1.30.0.dylib` beside it, which nothing loads.
 * - Windows: the binding and `onnxruntime.dll`. Not `DirectML.dll`, `dxcompiler.dll` or
 *   `dxil.dll` (36 MB): the Punctuation Restorer runs on the CPU execution provider only.
 */
export const ONNXRUNTIME_BUNDLE_FILES: Record<OnnxRuntimePlatform, readonly string[]> = {
  macos: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
  windows: ["onnxruntime_binding.node", "onnxruntime.dll"],
};

/** `build.copy` entries (repository source → app destination) for `platform`, whatever the host. */
export function onnxRuntimeBuildCopy(
  platform: OnnxRuntimePlatform,
): Record<string, string> {
  const dir = ONNXRUNTIME_BINDING_DIRS[platform];
  return Object.fromEntries(
    ONNXRUNTIME_BUNDLE_FILES[platform].map((file) => [
      `${PACKAGE_DIR}/${dir}/${file}`,
      `${dir}/${file}`,
    ]),
  );
}

/**
 * The ONNX Runtime files (relative to `appDir`, the bundle's `Resources/app`) that are not
 * there. Electrobun only logs a copy whose source is missing and carries on, so post-build
 * asks this and fails the build instead of shipping an app whose Punctuation Restorer
 * cannot load.
 */
export function missingOnnxRuntimeFiles(
  appDir: string,
  platform: OnnxRuntimePlatform,
): string[] {
  return Object.values(onnxRuntimeBuildCopy(platform)).filter(
    (destination) => !existsSync(join(appDir, destination)),
  );
}
