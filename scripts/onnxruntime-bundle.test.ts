import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { missingOnnxRuntimeFiles } from "./onnxruntime-bundle";

const appDirs: string[] = [];

/** A fake `Resources/app` holding the given files. */
function appDirWith(files: string[]): string {
  const appDir = mkdtempSync(join(tmpdir(), "codictate-ort-bundle-"));
  appDirs.push(appDir);
  for (const file of files) {
    mkdirSync(join(appDir, file, ".."), { recursive: true });
    writeFileSync(join(appDir, file), "");
  }
  return appDir;
}

afterEach(() => {
  for (const dir of appDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("post-build's check that ONNX Runtime made it into the macOS bundle", () => {
  test("nothing is missing when the binding and its library are both there", () => {
    const appDir = appDirWith([
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
    ]);
    expect(missingOnnxRuntimeFiles(appDir, "macos")).toEqual([]);
  });

  test("names the library when only the binding was copied", () => {
    const appDir = appDirWith(["bin/napi-v6/darwin/arm64/onnxruntime_binding.node"]);
    expect(missingOnnxRuntimeFiles(appDir, "macos")).toEqual([
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
    ]);
  });

  test("names both when Electrobun copied neither", () => {
    expect(missingOnnxRuntimeFiles(appDirWith([]), "macos")).toEqual([
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
    ]);
  });
});
