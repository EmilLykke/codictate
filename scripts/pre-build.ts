// Downloads/builds binaries and models that are too large to commit to git.
// Everything is cached in vendors/ (gitignored) so it only runs once.
//
// - MicRecorder:       built from Swift via `bun run build:native` (Core Audio capture + device list)
// - whisper-cli:       built from source (whisper.cpp)
// - CodictateParakeetHelper: Swift + FluidAudio + NeMo ITN (text-processing-rs static lib)
// - ggml-large-v3-turbo-q5_0.bin: Whisper multilingual model from Hugging Face
//
// Dev setup: brew install cmake, Xcode + swift for the Parakeet helper.

import { availableParallelism } from "os";
import { join } from "path";
import { existsSync, mkdirSync, chmodSync, copyFileSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";

const VENDORS_DIR = "./vendors";

const WHISPER_VERSION = "1.8.3";
const WHISPER_DIR = join(VENDORS_DIR, "whisper");
const WINDOWS_DIR = join(VENDORS_DIR, "windows");
const WINDOWS_TRAY_ICON = join(WINDOWS_DIR, "TrayIcon.ico");
const WHISPER_BINARY_NAME = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const WHISPER_BINARY = join(WHISPER_DIR, WHISPER_BINARY_NAME);
const WHISPER_BUILD_STAMP = join(WHISPER_DIR, "build-stamp.txt");
const WHISPER_BUILD_SIGNATURE = [
  `version=${WHISPER_VERSION}`,
  `platform=${process.platform}`,
  `examples=on`,
  `shared=off`,
  `vulkan=${process.platform === "win32" ? "on" : "off"}`,
].join("\n");

const PARAKEET_PKG = join(import.meta.dir, "..", "native", "CodictateParakeetHelper");
const PARAKEET_DIR = join(VENDORS_DIR, "parakeet");
const PARAKEET_BINARY = join(PARAKEET_DIR, "CodictateParakeetHelper");

const FORMATTER_PKG = join(import.meta.dir, "..", "native", "CodictateFormatterHelper");
const FORMATTER_DIR = join(VENDORS_DIR, "formatter");

const OBSERVER_PKG = join(import.meta.dir, "..", "native", "CodictateObserverHelper");
const OBSERVER_DIR = join(VENDORS_DIR, "observer");
const OBSERVER_BINARY = join(OBSERVER_DIR, "CodictateObserverHelper");
const FORMATTER_BINARY = join(FORMATTER_DIR, "CodictateFormatterHelper");
const TEXT_PROCESSING_RS_DIR = join(import.meta.dir, "..", "vendors", "text-processing-rs");
const NEMO_STATIC_LIB = join(
  PARAKEET_PKG,
  "Vendor",
  "lib",
  "libtext_processing_rs.a",
);

function resolveCargoExecutable(): string {
  const which = Bun.spawnSync(["/usr/bin/which", "cargo"], { stdout: "pipe" });
  if (which.exitCode === 0) {
    const p = which.stdout.toString().trim();
    if (p) return p;
  }
  const home = process.env.HOME;
  const fallback = home ? join(home, ".cargo", "bin", "cargo") : "";
  if (fallback && existsSync(fallback)) return fallback;
  throw new Error(
    "[pre-build] cargo not found. Install Rust: https://rustup.rs",
  );
}

function commandExists(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  return Bun.spawnSync([checker, command], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

async function vendorWhisperBinaries() {
  if (
    existsSync(WHISPER_BINARY) &&
    existsSync(WHISPER_BUILD_STAMP) &&
    readFileSync(WHISPER_BUILD_STAMP, "utf8") === WHISPER_BUILD_SIGNATURE
  ) {
    console.log("[pre-build] whisper-cli already vendored, skipping");
    return;
  }

  const cmakeCheck = Bun.spawnSync(["cmake", "--version"], { stdout: "pipe" });
  if (cmakeCheck.exitCode !== 0) {
    throw new Error(
      process.platform === "win32"
        ? "[pre-build] cmake not found. Install it and ensure `cmake` is on PATH."
        : "[pre-build] cmake not found. Install it with: brew install cmake",
    );
  }

  if (process.platform === "win32" && !commandExists("glslc")) {
    throw new Error(
      "[pre-build] Vulkan GPU build requires the Vulkan SDK shader compiler (`glslc`). Install the LunarG Vulkan SDK and reopen your terminal so `glslc` is on PATH.",
    );
  }

  mkdirSync(WHISPER_DIR, { recursive: true });

  const sourceUrl = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_VERSION}.tar.gz`;
  const tarPath = join(WHISPER_DIR, "whisper-src.tar.gz");
  const srcDir = join(WHISPER_DIR, "whisper-src");
  const buildDir = join(WHISPER_DIR, "whisper-build");

  console.log(`[pre-build] Downloading whisper.cpp v${WHISPER_VERSION} source...`);
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error("[pre-build] Failed to download whisper.cpp source");
  }
  await Bun.write(tarPath, response);

  mkdirSync(srcDir, { recursive: true });
  Bun.spawnSync(["tar", "-xf", tarPath, "-C", srcDir, "--strip-components=1"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  rmSync(tarPath, { force: true });

  console.log("[pre-build] Configuring whisper-cli (static, no SDL2)...");
  const configure = Bun.spawnSync(
    [
      "cmake",
      "-S", srcDir,
      "-B", buildDir,
      ...(process.platform === "win32" ? ["-A", "x64"] : []),
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_EXAMPLES=ON",
      ...(process.platform === "win32" ? ["-DGGML_VULKAN=ON"] : []),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (configure.exitCode !== 0) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] cmake configure failed");
  }

  const jobs = String(Math.max(1, availableParallelism?.() ?? 4));

  console.log(
    `[pre-build] Building whisper-cli (${jobs} cores, ~3-5 min first time)...`,
  );
  const buildArgs = ["cmake", "--build", buildDir, "--config", "Release"];
  if (process.platform !== "win32") {
    buildArgs.push("--target", "whisper-cli", "-j", jobs);
  }
  const build = Bun.spawnSync(buildArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] whisper-cli build failed");
  }

  const cliPath = findFileRecursively(buildDir, WHISPER_BINARY_NAME);

  if (!cliPath) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] whisper-cli binary not found after build");
  }

  copyFileSync(cliPath, WHISPER_BINARY);
  if (process.platform !== "win32") {
    chmodSync(WHISPER_BINARY, 0o755);
  }
  writeFileSync(WHISPER_BUILD_STAMP, WHISPER_BUILD_SIGNATURE);
  console.log("[pre-build] whisper-cli built and vendored successfully");

  rmSync(srcDir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
}

function ensureWindowsTrayIcon() {
  if (process.platform !== "win32") return;
  const sourcePng = join(import.meta.dir, "..", "src", "assets", "images", "MacTrayIcon.png");
  if (!existsSync(sourcePng)) return;

  const png = readFileSync(sourcePng);
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("[pre-build] Invalid tray icon PNG");
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  mkdirSync(WINDOWS_DIR, { recursive: true });

  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(width >= 256 ? 0 : width, 6);
  header.writeUInt8(height >= 256 ? 0 : height, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);

  writeFileSync(WINDOWS_TRAY_ICON, Buffer.concat([header, png]));
}

function findFileRecursively(root: string, fileName: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }
  }
  return null;
}

function parakeetVendoredBinaryLooksExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  const ft = Bun.spawnSync(["file", "-b", path], { stdout: "pipe" });
  const desc = ft.stdout.toString();
  // `find` previously picked `…/CodictateParakeetHelper.dSYM/.../CodictateParakeetHelper`
  // (a dSYM companion) → ENOEXEC at runtime. Require a real Mach-O executable.
  return (
    desc.includes("Mach-O") &&
    desc.includes("executable") &&
    !desc.includes("dSYM")
  );
}

/** Build FluidInference/text-processing-rs (NeMo ITN FFI) and place the static lib where Swift links it. */
async function vendorNemoTextProcessingStaticLib() {
  const cargo = resolveCargoExecutable();
  const cargoVersion = Bun.spawnSync([cargo, "--version"], { stdout: "pipe" });
  if (cargoVersion.exitCode !== 0) {
    throw new Error("[pre-build] cargo exists but does not run — check Rust install");
  }

  mkdirSync(join(import.meta.dir, "..", "vendors"), { recursive: true });

  if (!existsSync(join(TEXT_PROCESSING_RS_DIR, "Cargo.toml"))) {
    console.log(
      "[pre-build] Cloning FluidInference/text-processing-rs (NeMo inverse text normalization)…",
    );
    const clone = Bun.spawnSync(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "https://github.com/FluidInference/text-processing-rs.git",
        TEXT_PROCESSING_RS_DIR,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (clone.exitCode !== 0) {
      throw new Error("[pre-build] git clone text-processing-rs failed");
    }
  }

  console.log(
    "[pre-build] Building text-processing-rs (host target, release, ffi) for Parakeet ITN…",
  );
  const cargoBuild = Bun.spawnSync(
    [cargo, "build", "--release", "--features", "ffi"],
    {
      cwd: TEXT_PROCESSING_RS_DIR,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (cargoBuild.exitCode !== 0) {
    throw new Error("[pre-build] cargo build text-processing-rs failed");
  }

  const builtLib = join(
    TEXT_PROCESSING_RS_DIR,
    "target",
    "release",
    "libtext_processing_rs.a",
  );
  if (!existsSync(builtLib)) {
    throw new Error(`[pre-build] Expected static lib at ${builtLib}`);
  }

  mkdirSync(join(PARAKEET_PKG, "Vendor", "lib"), { recursive: true });
  Bun.spawnSync(["cp", "-f", builtLib, NEMO_STATIC_LIB]);
  console.log("[pre-build] NeMo ITN static library ready for CodictateParakeetHelper link step");
}

async function vendorParakeetHelper() {
  if (
    existsSync(PARAKEET_BINARY) &&
    !parakeetVendoredBinaryLooksExecutable(PARAKEET_BINARY)
  ) {
    console.log(
      "[pre-build] Replacing invalid CodictateParakeetHelper (not a Mach-O executable — often a dSYM stub)",
    );
    Bun.spawnSync(["rm", "-f", PARAKEET_BINARY]);
  }

  const swiftCheck = Bun.spawnSync(["xcrun", "--find", "swift"], {
    stdout: "pipe",
  });
  if (swiftCheck.exitCode !== 0) {
    throw new Error(
      "[pre-build] Swift toolchain not found. Install Xcode and run: xcode-select --install",
    );
  }

  if (!existsSync(join(PARAKEET_PKG, "Package.swift"))) {
    throw new Error(
      `[pre-build] Missing ${PARAKEET_PKG}/Package.swift — cannot build Parakeet helper`,
    );
  }

  await vendorNemoTextProcessingStaticLib();

  console.log(
    "[pre-build] Building CodictateParakeetHelper (Swift + FluidAudio + NeMo ITN; first run resolves SPM and Rust FFI)...",
  );
  const build = Bun.spawnSync(["swift", "build", "-c", "release"], {
    cwd: PARAKEET_PKG,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) {
    throw new Error("[pre-build] swift build CodictateParakeetHelper failed");
  }

  const binPathRes = Bun.spawnSync(
    ["swift", "build", "-c", "release", "--show-bin-path"],
    { cwd: PARAKEET_PKG, stdout: "pipe" },
  );
  if (binPathRes.exitCode !== 0) {
    throw new Error("[pre-build] swift --show-bin-path failed");
  }
  const releaseDir = binPathRes.stdout.toString().trim();
  const built = join(releaseDir, "CodictateParakeetHelper");

  if (!existsSync(built)) {
    throw new Error(
      `[pre-build] CodictateParakeetHelper not at ${built} (swift build layout changed?)`,
    );
  }

  const verify = Bun.spawnSync(["file", "-b", built], { stdout: "pipe" });
  const verifyDesc = verify.stdout.toString();
  if (!verifyDesc.includes("Mach-O") || !verifyDesc.includes("executable")) {
    throw new Error(
      `[pre-build] Expected Mach-O executable at ${built}, got: ${verifyDesc.trim()}`,
    );
  }

  mkdirSync(PARAKEET_DIR, { recursive: true });
  Bun.spawnSync(["cp", built, PARAKEET_BINARY]);
  chmodSync(PARAKEET_BINARY, 0o755);
  console.log("[pre-build] CodictateParakeetHelper vendored successfully");
}

function formatterBinaryIsRealBuild(path: string): boolean {
  // Distinguish the real Swift binary from the tiny C stub by size.
  // The C stub is ~33 KB; the real Swift binary is ~63 KB+.
  // Threshold set at 50 KB to safely separate the two.
  if (!parakeetVendoredBinaryLooksExecutable(path)) return false;
  try {
    const stat = Bun.spawnSync(["stat", "-f%z", path], { stdout: "pipe" });
    const bytes = parseInt(stat.stdout.toString().trim(), 10);
    return bytes > 50_000;
  } catch {
    return false;
  }
}

async function vendorFormatterHelper() {
  if (existsSync(FORMATTER_BINARY) && formatterBinaryIsRealBuild(FORMATTER_BINARY)) {
    console.log("[pre-build] CodictateFormatterHelper already vendored, skipping");
    return;
  }

  mkdirSync(FORMATTER_DIR, { recursive: true });

  if (!existsSync(join(FORMATTER_PKG, "Package.swift"))) {
    throw new Error(
      `[pre-build] Missing ${FORMATTER_PKG}/Package.swift — cannot build formatter helper`,
    );
  }

  console.log("[pre-build] Building CodictateFormatterHelper (Swift + FoundationModels)…");
  const build = Bun.spawnSync(["swift", "build", "-c", "release"], {
    cwd: FORMATTER_PKG,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (build.exitCode === 0) {
    const binPathRes = Bun.spawnSync(
      ["swift", "build", "-c", "release", "--show-bin-path"],
      { cwd: FORMATTER_PKG, stdout: "pipe" },
    );
    const releaseDir = binPathRes.stdout.toString().trim();
    const built = join(releaseDir, "CodictateFormatterHelper");

    if (existsSync(built)) {
      Bun.spawnSync(["cp", built, FORMATTER_BINARY]);
      chmodSync(FORMATTER_BINARY, 0o755);
      console.log("[pre-build] CodictateFormatterHelper vendored successfully");
      return;
    }
  }

  // Build failed — compile a minimal C stub that exits 1 so the binary always exists
  // for electrobun's copy step. The TypeScript bridge falls back to raw text silently.
  console.warn(
    "[pre-build] CodictateFormatterHelper Swift build failed (requires macOS 26 SDK) — compiling stub; formatting will be disabled",
  );
  const stubSrc = `#include <stdio.h>\nint main(int argc, char **argv){fputs("[formatter] FoundationModels not available (requires macOS 26 SDK)\\n", stderr);return 1;}\n`;
  const stubPath = join(FORMATTER_DIR, "stub.c");
  await Bun.write(stubPath, stubSrc);
  const stubBuild = Bun.spawnSync(
    ["cc", "-o", FORMATTER_BINARY, stubPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  Bun.spawnSync(["rm", "-f", stubPath]);
  if (stubBuild.exitCode !== 0) {
    throw new Error("[pre-build] Failed to compile CodictateFormatterHelper stub");
  }
  chmodSync(FORMATTER_BINARY, 0o755);
  console.log("[pre-build] CodictateFormatterHelper stub compiled (formatting disabled)");
}

async function vendorObserverHelper() {
  if (existsSync(OBSERVER_BINARY)) {
    console.log("[pre-build] CodictateObserverHelper already vendored, skipping");
    return;
  }

  mkdirSync(OBSERVER_DIR, { recursive: true });

  if (!existsSync(join(OBSERVER_PKG, "Package.swift"))) {
    throw new Error(
      `[pre-build] Missing ${OBSERVER_PKG}/Package.swift — cannot build observer helper`,
    );
  }

  console.log("[pre-build] Building CodictateObserverHelper…");
  const build = Bun.spawnSync(["swift", "build", "-c", "release"], {
    cwd: OBSERVER_PKG,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (build.exitCode !== 0) {
    throw new Error("[pre-build] CodictateObserverHelper Swift build failed");
  }

  const binPathRes = Bun.spawnSync(
    ["swift", "build", "-c", "release", "--show-bin-path"],
    { cwd: OBSERVER_PKG, stdout: "pipe" },
  );
  const releaseDir = binPathRes.stdout.toString().trim();
  const built = join(releaseDir, "CodictateObserverHelper");

  if (!existsSync(built)) {
    throw new Error(
      `[pre-build] CodictateObserverHelper not at ${built} (swift build layout changed?)`,
    );
  }

  Bun.spawnSync(["cp", built, OBSERVER_BINARY]);
  chmodSync(OBSERVER_BINARY, 0o755);
  console.log("[pre-build] CodictateObserverHelper vendored successfully");
}

const MODEL_NAME = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_PATH = join(WHISPER_DIR, MODEL_NAME);

async function vendorWhisperModel() {
  if (existsSync(MODEL_PATH)) {
    console.log(`[pre-build] ${MODEL_NAME} already vendored, skipping`);
    return;
  }

  mkdirSync(WHISPER_DIR, { recursive: true });

  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;

  console.log(
    `[pre-build] Downloading ${MODEL_NAME} (~547 MB, this may take a moment)...`,
  );
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`[pre-build] Failed to download ${MODEL_NAME}`);
  }
  await Bun.write(MODEL_PATH, response);

  console.log(`[pre-build] ${MODEL_NAME} vendored successfully`);
}

if (process.platform === "win32") {
  ensureWindowsTrayIcon();
  await vendorWhisperBinaries();
  await vendorWhisperModel();
  console.log("[pre-build] Windows whisper dependencies ready");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.warn(
    "[pre-build] vendoring only supported on macOS for now, skipping",
  );
  process.exit(0);
}

if (process.argv.includes("--parakeet-only")) {
  await vendorParakeetHelper();
  console.log("[pre-build] Parakeet helper (+ NeMo ITN) ready");
  process.exit(0);
}

await vendorWhisperBinaries();
await vendorParakeetHelper();
await vendorFormatterHelper();
await vendorObserverHelper();
await vendorWhisperModel();

console.log("[pre-build] All dependencies ready");
