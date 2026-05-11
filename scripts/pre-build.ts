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

const WHISPER_VERSION = "1.8.4";
const WHISPER_DIR = join(VENDORS_DIR, "whisper");
const WINDOWS_DIR = join(VENDORS_DIR, "windows");
const WINDOWS_TRAY_ICON = join(WINDOWS_DIR, "TrayIcon.ico");
const WINDOWS_VC_RUNTIME_DIR = join(WINDOWS_DIR, "vc-runtime");
const WINDOWS_VC_RUNTIME_DLLS = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
];
const WHISPER_BINARY_NAME = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const WHISPER_BINARY = join(WHISPER_DIR, WHISPER_BINARY_NAME);
const WHISPER_BUILD_STAMP = join(WHISPER_DIR, "build-stamp.txt");
const WHISPER_BUILD_SIGNATURE = [
  `version=${WHISPER_VERSION}`,
  `platform=${process.platform}`,
  `examples=on`,
  `shared=off`,
  `native=${process.platform === "win32" ? "off" : "default"}`,
  `vulkan=${process.platform === "win32" ? "on" : "off"}`,
].join("\n");

// PrismML fork of llama.cpp (required for Q2_0 ternary quantization used by Ternary-Bonsai).
// Pinned to tag prism-b8846-d104cf1 — upstream fork at https://github.com/PrismML-Eng/llama.cpp
// Earlier tags (e.g. v0.0.2-prism) defined only Q1_0 ternary types; GGML_TYPE_Q2_0 = 42 arrived
// in this build tag and is required for the Ternary-Bonsai-1.7B-Q2_0 GGUF.
// Prism renamed `llama-cli` → `llama-completion`; only llama-completion can load ternary Q2_0 weights.
const LLAMA_VERSION = "prism-b8846-d104cf1";
const LLAMA_DIR = join(VENDORS_DIR, "llama");
const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-completion.exe" : "llama-completion";
const LLAMA_BINARY = join(LLAMA_DIR, LLAMA_BINARY_NAME);
const LLAMA_BUILD_STAMP = join(LLAMA_DIR, "build-stamp.txt");
const LLAMA_BUILD_SIGNATURE = [
  `version=${LLAMA_VERSION}`,
  `platform=${process.platform}`,
  `shared=off`,
  `native=${process.platform === "win32" ? "off" : "default"}`,
  `metal=${process.platform === "darwin" ? "on" : "off"}`,
  `vulkan=${process.platform === "win32" ? "on" : "off"}`,
].join("\n");

const PARAKEET_PKG = join(import.meta.dir, "..", "native", "CodictateParakeetHelper");
const PARAKEET_DIR = join(VENDORS_DIR, "parakeet");
const PARAKEET_BINARY = join(PARAKEET_DIR, "CodictateParakeetHelper");
const MAC_ICON_COMPOSER_EXPORT = join(
  import.meta.dir,
  "..",
  "src",
  "assets",
  "images",
  "MacAppIconFlat.svg",
);
const MAC_LEGACY_DOC_ICON = join(
  import.meta.dir,
  "..",
  "src",
  "assets",
  "images",
  "MacDocIcon.png",
);
const WINDOWS_APP_ICON = join(
  import.meta.dir,
  "..",
  "src",
  "assets",
  "images",
  "MacDocIcon.ico",
);
const MAC_ICONSET_DIR = join(import.meta.dir, "..", "icon.iconset");
const MAC_ICONSET_SIZES = [
  { size: 16, scale: 1 },
  { size: 16, scale: 2 },
  { size: 32, scale: 1 },
  { size: 32, scale: 2 },
  { size: 128, scale: 1 },
  { size: 128, scale: 2 },
  { size: 256, scale: 1 },
  { size: 256, scale: 2 },
  { size: 512, scale: 1 },
  { size: 512, scale: 2 },
];

const OBSERVER_PKG = join(import.meta.dir, "..", "native", "CodictateObserverHelper");
const OBSERVER_DIR = join(VENDORS_DIR, "observer");
const OBSERVER_BINARY = join(OBSERVER_DIR, "CodictateObserverHelper");
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

function syncMacAppIconArtifacts() {
  if (process.platform !== "darwin") return;

  const sourceVector = existsSync(MAC_ICON_COMPOSER_EXPORT)
    ? MAC_ICON_COMPOSER_EXPORT
    : MAC_LEGACY_DOC_ICON;

  if (!existsSync(sourceVector)) {
    throw new Error("[pre-build] Missing macOS app icon source asset");
  }

  const tempSourcePng = join(import.meta.dir, "..", ".tmp", "mac-app-icon-source.png");
  mkdirSync(join(import.meta.dir, "..", ".tmp"), { recursive: true });
  const rasterize = Bun.spawnSync(
    ["sips", "-s", "format", "png", sourceVector, "--out", tempSourcePng],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (rasterize.exitCode !== 0 || !existsSync(tempSourcePng)) {
    throw new Error(`[pre-build] Failed rasterizing macOS app icon source: ${sourceVector}`);
  }

  const sourcePng = readFileSync(tempSourcePng);

  // Keep the legacy flat PNG in sync because Electrobun and the Windows packaging
  // path still refer to MacDocIcon.* while the canonical macOS source is a
  // borderless square icon that lets macOS apply its own outer treatment.
  if (
    (!existsSync(MAC_LEGACY_DOC_ICON) ||
      !readFileSync(MAC_LEGACY_DOC_ICON).equals(sourcePng))
  ) {
    writeFileSync(MAC_LEGACY_DOC_ICON, sourcePng);
    console.log("[pre-build] Synced macOS flat icon source -> MacDocIcon.png");
  }

  mkdirSync(MAC_ICONSET_DIR, { recursive: true });

  for (const { size, scale } of MAC_ICONSET_SIZES) {
    const px = size * scale;
    const label =
      scale === 1
        ? `icon_${size}x${size}.png`
        : `icon_${size}x${size}@2x.png`;
    const outPath = join(MAC_ICONSET_DIR, label);
    const result = Bun.spawnSync(
      ["sips", "-z", String(px), String(px), tempSourcePng, "--out", outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (result.exitCode !== 0) {
      throw new Error(`[pre-build] Failed generating ${label} from ${sourceVector}`);
    }
  }

  console.log("[pre-build] Refreshed icon.iconset from the canonical flat macOS icon source");
}

function syncWindowsAppIconFromIconset() {
  const iconEntries = [
    { file: join(MAC_ICONSET_DIR, "icon_16x16.png"), size: 16 },
    { file: join(MAC_ICONSET_DIR, "icon_32x32.png"), size: 32 },
    { file: join(MAC_ICONSET_DIR, "icon_128x128.png"), size: 128 },
    { file: join(MAC_ICONSET_DIR, "icon_256x256.png"), size: 256 },
  ].filter(({ file }) => existsSync(file));

  if (iconEntries.length === 0) {
    throw new Error("[pre-build] Missing icon.iconset PNGs for Windows app icon generation");
  }

  const images = iconEntries.map(({ file, size }) => ({
    size,
    png: readFileSync(file),
  }));
  const headerSize = 6 + images.length * 16;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  let dataOffset = headerSize;
  const chunks: Buffer[] = [];

  for (const [index, image] of images.entries()) {
    const entryOffset = 6 + index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.png.length, entryOffset + 8);
    directory.writeUInt32LE(dataOffset, entryOffset + 12);
    chunks.push(image.png);
    dataOffset += image.png.length;
  }

  writeFileSync(WINDOWS_APP_ICON, Buffer.concat([directory, ...chunks]));
  console.log("[pre-build] Regenerated MacDocIcon.ico from icon.iconset");
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
      ...(process.platform === "win32" ? ["-DGGML_NATIVE=OFF"] : []),
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

async function vendorLlamaBinaries() {
  if (
    existsSync(LLAMA_BINARY) &&
    existsSync(LLAMA_BUILD_STAMP) &&
    readFileSync(LLAMA_BUILD_STAMP, "utf8") === LLAMA_BUILD_SIGNATURE
  ) {
    console.log("[pre-build] llama-completion already vendored, skipping");
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

  mkdirSync(LLAMA_DIR, { recursive: true });

  const sourceUrl = `https://github.com/PrismML-Eng/llama.cpp/archive/refs/tags/${LLAMA_VERSION}.tar.gz`;
  const tarPath = join(LLAMA_DIR, "llama-src.tar.gz");
  const srcDir = join(LLAMA_DIR, "llama-src");
  const buildDir = join(LLAMA_DIR, "llama-build");

  console.log(`[pre-build] Downloading PrismML llama.cpp ${LLAMA_VERSION} source...`);
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`[pre-build] Failed to download llama.cpp source (HTTP ${response.status})`);
  }
  await Bun.write(tarPath, response);

  mkdirSync(srcDir, { recursive: true });
  Bun.spawnSync(["tar", "-xf", tarPath, "-C", srcDir, "--strip-components=1"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  rmSync(tarPath, { force: true });

  console.log("[pre-build] Configuring llama-completion (static, release)...");
  // llama-completion lives under tools/completion/. LLAMA_BUILD_TOOLS must be
  // ON so the whole tools/ subtree is included. LLAMA_CURL=OFF avoids a system
  // curl dependency. (The deprecated tools/cli/ also exists but refuses Q2_0.)
  const configureArgs: string[] = [
    "cmake",
    "-S", srcDir,
    "-B", buildDir,
    ...(process.platform === "win32" ? ["-A", "x64"] : []),
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    ...(process.platform === "win32" ? ["-DGGML_NATIVE=OFF"] : []),
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_TOOLS=ON",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_BUILD_COMMON=ON",
    "-DLLAMA_CURL=OFF",
    // Block cpp-httplib from auto-linking the system OpenSSL (Homebrew on macOS).
    // Otherwise the resulting binary depends on /opt/homebrew/opt/openssl@3/...
    // which fails to load inside the packaged .app (Team ID mismatch).
    "-DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=TRUE",
  ];
  if (process.platform === "darwin") {
    configureArgs.push("-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON");
  } else if (process.platform === "win32") {
    configureArgs.push("-DGGML_VULKAN=ON");
  }

  const configure = Bun.spawnSync(configureArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (configure.exitCode !== 0) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] cmake configure (llama.cpp) failed");
  }

  const jobs = String(Math.max(1, availableParallelism?.() ?? 4));

  console.log(
    `[pre-build] Building llama-completion (${jobs} cores, ~5-10 min first time)...`,
  );
  const buildArgs = ["cmake", "--build", buildDir, "--config", "Release"];
  if (process.platform !== "win32") {
    buildArgs.push("--target", "llama-completion", "-j", jobs);
  } else {
    buildArgs.push("--target", "llama-completion");
  }
  const build = Bun.spawnSync(buildArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] llama-completion build failed");
  }

  const cliPath = findFileRecursively(buildDir, LLAMA_BINARY_NAME);
  if (!cliPath) {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error("[pre-build] llama-completion binary not found after build");
  }

  copyFileSync(cliPath, LLAMA_BINARY);
  if (process.platform !== "win32") {
    chmodSync(LLAMA_BINARY, 0o755);
  }
  writeFileSync(LLAMA_BUILD_STAMP, LLAMA_BUILD_SIGNATURE);
  console.log("[pre-build] llama-completion built and vendored successfully");

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

function ensureWindowsVcRuntimeDlls() {
  if (process.platform !== "win32") return;

  const windir = process.env.WINDIR ?? process.env.SystemRoot;
  const redistDir = process.env.VCToolsRedistDir;
  mkdirSync(WINDOWS_VC_RUNTIME_DIR, { recursive: true });

  for (const dll of WINDOWS_VC_RUNTIME_DLLS) {
    const candidates = [
      ...(windir ? [join(windir, "System32", dll)] : []),
      ...(redistDir
        ? [
            join(redistDir, "x64", "Microsoft.VC143.CRT", dll),
            join(redistDir, "x64", "Microsoft.VC142.CRT", dll),
          ]
        : []),
    ];
    const source = candidates.find((candidate) => existsSync(candidate));
    if (!source) {
      throw new Error(
        `[pre-build] Missing ${dll}. Install Microsoft Visual C++ Redistributable or Visual Studio Build Tools.`,
      );
    }
    copyFileSync(source, join(WINDOWS_VC_RUNTIME_DIR, dll));
  }

  console.log("[pre-build] Windows VC runtime DLLs vendored successfully");
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
    `[pre-build] Downloading ${MODEL_NAME} (~547 MB)...`,
  );

  const result = Bun.spawnSync(
    [
      "curl",
      "--location",
      "--fail",
      "--retry", "3",
      "--retry-delay", "5",
      "--connect-timeout", "30",
      "--max-time", "600",
      "--progress-bar",
      "--output", MODEL_PATH,
      url,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  if (result.exitCode !== 0) {
    if (existsSync(MODEL_PATH)) rmSync(MODEL_PATH, { force: true });
    throw new Error(`[pre-build] Failed to download ${MODEL_NAME}`);
  }

  console.log(`[pre-build] ${MODEL_NAME} vendored successfully`);
}

if (process.platform === "win32") {
  ensureWindowsTrayIcon();
  ensureWindowsVcRuntimeDlls();
  syncWindowsAppIconFromIconset();
  await vendorWhisperBinaries();
  await vendorLlamaBinaries();
  await vendorWhisperModel();
  console.log("[pre-build] Windows dependencies ready");
  process.exit(0);
}

if (process.platform === "linux") {
  await vendorWhisperBinaries();
  await vendorLlamaBinaries();
  await vendorWhisperModel();
  console.log("[pre-build] Linux dependencies ready");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.warn(
    "[pre-build] unsupported platform, skipping",
  );
  process.exit(0);
}

syncMacAppIconArtifacts();
syncWindowsAppIconFromIconset();

if (process.argv.includes("--parakeet-only")) {
  await vendorParakeetHelper();
  console.log("[pre-build] Parakeet helper (+ NeMo ITN) ready");
  process.exit(0);
}

if (process.argv.includes("--llama-only")) {
  await vendorLlamaBinaries();
  console.log("[pre-build] llama-completion ready");
  process.exit(0);
}

await vendorWhisperBinaries();
await vendorLlamaBinaries();
await vendorParakeetHelper();
await vendorObserverHelper();
await vendorWhisperModel();

console.log("[pre-build] All dependencies ready");
