// Pinned Vendor Binary releases and the exact file lists Codictate ships from them.
//
// Both `scripts/pre-build.ts` (which downloads and verifies) and
// `electrobun.config.ts` (which copies into the app bundle) read these lists, so
// they cannot drift apart. `electrobun.config.ts` is evaluated before pre-build
// runs, which is why the lists are hardcoded here instead of discovered by
// scanning `vendors/` at build time.
//
// Every Vendor Binary here is a prebuilt archive verified by sha256; nothing is
// built from source. See docs/adr/0001-vendor-binary-sourcing.md for why, and
// docs/adr/0002-asr-harness-abstraction.md for crispasr being the only ASR Harness.

/**
 * Upstream llama.cpp. Publishes `llama-completion` for both target platforms, and
 * loads the Q4_K_M formatter weights Codictate actually ships. Codictate used the
 * PrismML fork for its Q2_0 ternary support; nothing shipping needs Q2_0, so this
 * is back on upstream. See docs/adr/0001-vendor-binary-sourcing.md.
 */
export const LLAMA_VERSION = "b11496";
export const LLAMA_RELEASE_BASE =
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;

/** CrispASR, the only ASR Harness. Single prebuilt binary, also the only runtime for Cohere ASR weights. */
export const CRISPASR_VERSION = "v0.8.41";
export const CRISPASR_RELEASE_BASE =
  `https://github.com/CrispStrobe/CrispASR/releases/download/${CRISPASR_VERSION}`;

export interface VendorArchive {
  /** Asset file name inside the pinned release. */
  asset: string;
  /** sha256 of the asset, as published by the GitHub release asset digest. */
  sha256: string;
  /** Path prefix inside the archive to strip, if the archive has a top-level directory. */
  stripPrefix?: string;
}

// -- llama-completion --------------------------------------------------------

export const LLAMA_MACOS_ARM64_ARCHIVE: VendorArchive = {
  asset: `llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz`,
  sha256: "0eeb3bdef43d6b0ab28fb1b8aeacca8b2bb590cc76ca05c53ef0ac5e9850eebf",
  stripPrefix: `llama-${LLAMA_VERSION}`,
};

/**
 * The Vulkan archive is self-contained: it carries `llama-completion.exe`, the
 * Vulkan backend, and every llama/ggml DLL the exe's PE import table names. The
 * only externals are Windows system DLLs plus the MSVC runtime, which
 * `ensureWindowsVcRuntimeDlls()` already vendors.
 */
export const LLAMA_WINDOWS_ARCHIVE: VendorArchive = {
  asset: `llama-${LLAMA_VERSION}-bin-win-vulkan-x64.zip`,
  sha256: "f65e4f5b660e1d2690cbf01e8c3529473c4615b8f37dcabd71b5a669d47fde2b",
};

/**
 * The nine `@rpath` dylibs `llama-completion` links against, verified with
 * `otool -L`. In the archive these names are symlinks to versioned files; the
 * vendoring step resolves them so `vendors/llama/` holds plain files that
 * `post-build.ts` can codesign one by one.
 */
export const LLAMA_MACOS_DYLIBS = [
  "libllama-completion-impl.dylib",
  "libllama-common.0.dylib",
  "libllama.0.dylib",
  "libggml.0.dylib",
  "libggml-base.0.dylib",
  "libggml-cpu.0.dylib",
  "libggml-blas.0.dylib",
  "libggml-metal.0.dylib",
  "libggml-rpc.0.dylib",
];

/**
 * Import-table dependencies of `llama-completion.exe`, plus the backends
 * `ggml-base.dll` loads dynamically rather than importing: `ggml-vulkan.dll`,
 * `ggml-rpc.dll`, and one `ggml-cpu-*.dll` chosen at runtime from the host CPU.
 * Every CPU variant ships or older machines lose the CPU backend entirely.
 */
export const LLAMA_WINDOWS_DLLS = [
  "llama-completion-impl.dll",
  "llama.dll",
  "llama-common.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-rpc.dll",
  "ggml-vulkan.dll",
  "libomp.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
];

// -- crispasr ----------------------------------------------------------------

/**
 * crispasr ships its own `ggml.dll` / `ggml-base.dll` / `ggml-vulkan.dll`, which
 * collide by name with llama's. It therefore lands in its own subdirectory of
 * `native-helpers/` on both platforms rather than next to llama-completion.
 */
export const CRISPASR_BUNDLE_SUBDIR = "crispasr";

export const CRISPASR_MACOS_ARCHIVE: VendorArchive = {
  asset: "crispasr-macos.tar.gz",
  sha256: "e3c1f1be6493f6247dfc11d9209b8287e3955f5a4012c3c2c56465dad6282823",
  stripPrefix: "crispasr-macos",
};

/** Vulkan variant, matching the Vulkan-on Windows build of llama-completion. */
export const CRISPASR_WINDOWS_ARCHIVE: VendorArchive = {
  asset: "crispasr-windows-x86_64-vulkan.zip",
  sha256: "146a38edb97a83fbc1b526e7767d3e25ab03bf6f4118c41342eda09abe9af6a0",
  stripPrefix: "crispasr-windows-x86_64-vulkan",
};

/** The single `@rpath` dylib `crispasr` links against (C2PA content credentials). */
export const CRISPASR_MACOS_DYLIBS = ["libc2pa_c.dylib"];

export const CRISPASR_WINDOWS_DLLS = [
  "crispasr.dll",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml-vulkan.dll",
];
