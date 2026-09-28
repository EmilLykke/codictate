// Downloads/builds binaries and models that are too large to commit to git.
// Everything is cached in vendors/ (gitignored) so it only runs once.
//
// - MicRecorder:       built from Swift via `bun run build:native` (Core Audio capture + device list)
// - llama-completion:  downloaded prebuilt from the pinned upstream llama.cpp release
// - crispasr:          downloaded prebuilt from the pinned CrispASR release (the ASR Harness)
// - CodictateParakeetHelper: Swift + FluidAudio + NeMo ITN (text-processing-rs static lib)
// - ggml-large-v3-turbo-q5_0.bin: Whisper multilingual model from Hugging Face
//
// Both Vendor Binaries are pinned prebuilt archives on every supported host (macOS
// arm64, Windows x64, Linux x64); nothing is built from source and there is no
// fallback build. Rationale: docs/adr/0001-vendor-binary-sourcing.md
//
// Dev setup: Xcode + swift for the macOS helpers; cargo for the Parakeet ITN lib.

import { join } from "path";
import { existsSync, mkdirSync, chmodSync, copyFileSync, rmSync, readFileSync, writeFileSync, realpathSync } from "fs";
import {
  LLAMA_VERSION,
  LLAMA_RELEASE_BASE,
  LLAMA_MACOS_ARM64_ARCHIVE,
  LLAMA_WINDOWS_ARCHIVE,
  LLAMA_LINUX_X64_ARCHIVE,
  LLAMA_MACOS_DYLIBS,
  LLAMA_WINDOWS_DLLS,
  LLAMA_LINUX_SHARED_LIBS,
  CRISPASR_VERSION,
  CRISPASR_RELEASE_BASE,
  CRISPASR_MACOS_ARCHIVE,
  CRISPASR_WINDOWS_ARCHIVE,
  CRISPASR_LINUX_X64_ARCHIVE,
  CRISPASR_MACOS_DYLIBS,
  CRISPASR_WINDOWS_DLLS,
  CRISPASR_LINUX_SHARED_LIBS,
  type VendorArchive,
} from "./vendor-manifest";

const VENDORS_DIR = "./vendors";

// Holds the bundled Whisper Speech Model only. Nothing from whisper.cpp is built here any
// more: crispasr is the single ASR Harness and ships as a verified prebuilt archive.
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
/** A pinned prebuilt archive and the files Codictate ships out of it for one host. */
interface VendorTarget {
  archive: VendorArchive;
  /** Shared libraries shipped next to the binary, from `vendor-manifest.ts`. */
  libraries: string[];
}

const HOST = `${process.platform}-${process.arch}`;

/**
 * The prebuilt asset for this host, or a loud failure. There is no source build to
 * fall back to: a host without a pinned asset cannot vendor this binary at all.
 */
function hostVendorTarget(
  label: string,
  targets: Partial<Record<string, VendorTarget>>,
): VendorTarget {
  const target = targets[HOST];
  if (!target) {
    throw new Error(
      `[pre-build] No pinned ${label} asset for ${HOST}. Supported hosts: ${Object.keys(targets).join(", ")}. See docs/adr/0001-vendor-binary-sourcing.md.`,
    );
  }
  return target;
}

function buildStamp(version: string, archive: VendorArchive): string {
  return [
    `version=${version}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `asset=${archive.asset}`,
    `sha256=${archive.sha256}`,
  ].join("\n");
}

// Upstream llama.cpp (https://github.com/ggml-org/llama.cpp), pinned by build tag.
//
// Codictate previously used the PrismML fork for GGML_TYPE_Q2_0 ternary weights
// (Ternary-Bonsai-1.7B-Q2_0). Nothing shipping loads Q2_0, since both formatter models are
// Q4_K_M (src/bun/platform/runtime.ts), and upstream now publishes `llama-completion`
// itself, so there is no reason to stay on the fork. Reintroducing a ternary model would
// mean revisiting docs/adr/0001-vendor-binary-sourcing.md.
const LLAMA_DIR = join(VENDORS_DIR, "llama");
const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-completion.exe" : "llama-completion";
const LLAMA_TARGETS: Partial<Record<string, VendorTarget>> = {
  "darwin-arm64": { archive: LLAMA_MACOS_ARM64_ARCHIVE, libraries: LLAMA_MACOS_DYLIBS },
  "win32-x64": { archive: LLAMA_WINDOWS_ARCHIVE, libraries: LLAMA_WINDOWS_DLLS },
  "linux-x64": { archive: LLAMA_LINUX_X64_ARCHIVE, libraries: LLAMA_LINUX_SHARED_LIBS },
};

// crispasr, the only ASR Harness (docs/adr/0002-asr-harness-abstraction.md).
// Prebuilt only: there is no source build path.
const CRISPASR_DIR = join(VENDORS_DIR, "crispasr");
const CRISPASR_BINARY_NAME = process.platform === "win32" ? "crispasr.exe" : "crispasr";
const CRISPASR_TARGETS: Partial<Record<string, VendorTarget>> = {
  "darwin-arm64": { archive: CRISPASR_MACOS_ARCHIVE, libraries: CRISPASR_MACOS_DYLIBS },
  "win32-x64": { archive: CRISPASR_WINDOWS_ARCHIVE, libraries: CRISPASR_WINDOWS_DLLS },
  "linux-x64": { archive: CRISPASR_LINUX_X64_ARCHIVE, libraries: CRISPASR_LINUX_SHARED_LIBS },
};

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

/**
 * Download `url` to `destPath` and fail unless its sha256 matches `expectedSha256`.
 * Hashing happens in-process (Bun.CryptoHasher) so no shasum/certutil is needed.
 */
async function downloadAndVerify(
  url: string,
  destPath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  console.log(`[pre-build] Downloading ${label}...`);
  const result = Bun.spawnSync(
    [
      "curl",
      "--location",
      "--fail",
      "--retry", "3",
      "--retry-delay", "5",
      "--connect-timeout", "30",
      "--max-time", "900",
      "--progress-bar",
      "--output", destPath,
      url,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    rmSync(destPath, { force: true });
    throw new Error(`[pre-build] Failed to download ${label} from ${url}`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(destPath));
  const actual = hasher.digest("hex");
  if (actual !== expectedSha256) {
    rmSync(destPath, { force: true });
    throw new Error(
      `[pre-build] sha256 mismatch for ${label}\n  expected ${expectedSha256}\n  actual   ${actual}`,
    );
  }
  console.log(`[pre-build] ${label} sha256 verified`);
}

/**
 * Download a pinned release archive and unpack it into a fresh directory.
 * `tar -xf` handles both .tar.gz and .zip (bsdtar ships with macOS and Windows 10+;
 * the Linux assets are all .tar.gz, which GNU tar reads).
 */
async function fetchVendorArchive(
  releaseBase: string,
  archive: VendorArchive,
  workDir: string,
): Promise<string> {
  mkdirSync(workDir, { recursive: true });
  const archivePath = join(workDir, archive.asset);
  await downloadAndVerify(
    `${releaseBase}/${archive.asset}`,
    archivePath,
    archive.sha256,
    archive.asset,
  );

  const extractDir = join(workDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  const untar = Bun.spawnSync(["tar", "-xf", archivePath, "-C", extractDir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (untar.exitCode !== 0) {
    throw new Error(`[pre-build] Failed to unpack ${archive.asset}`);
  }
  rmSync(archivePath, { force: true });

  return archive.stripPrefix ? join(extractDir, archive.stripPrefix) : extractDir;
}

/**
 * Copy `names` from `sourceDir` into `destDir`, resolving symlinks so the result
 * is plain files. The release archives link e.g. libllama.0.dylib to a versioned
 * file; post-build.ts signs each entry it finds by name, so plain files keep the
 * signing pass from touching the same binary twice through two paths.
 */
function copyVendorFiles(
  sourceDir: string,
  destDir: string,
  names: string[],
  label: string,
): void {
  mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) {
      throw new Error(
        `[pre-build] ${label} archive is missing ${name}: the pinned release layout changed`,
      );
    }
    copyFileSync(realpathSync(source), join(destDir, name));
  }
}

/**
 * Fetch the pinned prebuilt `binaryName` plus the shared libraries it loads at runtime
 * into `destDir`, unless a stamp for the same asset is already there.
 */
async function vendorPrebuilt(options: {
  label: string;
  version: string;
  releaseBase: string;
  targets: Partial<Record<string, VendorTarget>>;
  destDir: string;
  binaryName: string;
}): Promise<void> {
  const { label, version, releaseBase, targets, destDir, binaryName } = options;
  const { archive, libraries } = hostVendorTarget(label, targets);
  const binary = join(destDir, binaryName);
  const stampPath = join(destDir, "build-stamp.txt");
  const stamp = buildStamp(version, archive);
  if (
    existsSync(binary) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8") === stamp
  ) {
    console.log(`[pre-build] ${label} already vendored, skipping`);
    return;
  }

  rmSync(destDir, { recursive: true, force: true });
  const workDir = join(VENDORS_DIR, `.${label}-download`);
  rmSync(workDir, { recursive: true, force: true });

  try {
    const sourceDir = await fetchVendorArchive(releaseBase, archive, workDir);
    copyVendorFiles(sourceDir, destDir, [binaryName, ...libraries], label);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  writeFileSync(stampPath, stamp);
  console.log(`[pre-build] ${label} ${version} vendored from the prebuilt release (${archive.asset})`);
}

async function vendorLlamaBinaries() {
  await vendorPrebuilt({
    label: "llama-completion",
    version: LLAMA_VERSION,
    releaseBase: LLAMA_RELEASE_BASE,
    targets: LLAMA_TARGETS,
    destDir: LLAMA_DIR,
    binaryName: LLAMA_BINARY_NAME,
  });
}

async function vendorCrispasrBinaries() {
  await vendorPrebuilt({
    label: "crispasr",
    version: CRISPASR_VERSION,
    releaseBase: CRISPASR_RELEASE_BASE,
    targets: CRISPASR_TARGETS,
    destDir: CRISPASR_DIR,
    binaryName: CRISPASR_BINARY_NAME,
  });
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

// Single-target flags are handled before the per-platform branches, because those
// branches exit. Vendoring one binary must work the same on macOS and Windows:
// `find-asr-harness.ts` points users at `--crispasr-only` on both.
if (process.argv.includes("--llama-only")) {
  await vendorLlamaBinaries();
  console.log("[pre-build] llama-completion ready");
  process.exit(0);
}

if (process.argv.includes("--crispasr-only")) {
  await vendorCrispasrBinaries();
  console.log("[pre-build] crispasr ready");
  process.exit(0);
}

if (process.argv.includes("--parakeet-only")) {
  if (process.platform !== "darwin") {
    console.error(
      "[pre-build] --parakeet-only is macOS only: CodictateParakeetHelper is a Swift package.",
    );
    process.exit(1);
  }
  await vendorParakeetHelper();
  console.log("[pre-build] Parakeet helper (+ NeMo ITN) ready");
  process.exit(0);
}

if (process.platform === "win32") {
  ensureWindowsTrayIcon();
  ensureWindowsVcRuntimeDlls();
  syncWindowsAppIconFromIconset();
  await vendorLlamaBinaries();
  await vendorCrispasrBinaries();
  await vendorWhisperModel();
  console.log("[pre-build] Windows dependencies ready");
  process.exit(0);
}

if (process.platform === "linux") {
  await vendorLlamaBinaries();
  await vendorCrispasrBinaries();
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

await vendorLlamaBinaries();
await vendorCrispasrBinaries();
await vendorParakeetHelper();
await vendorObserverHelper();
await vendorWhisperModel();

console.log("[pre-build] All dependencies ready");
