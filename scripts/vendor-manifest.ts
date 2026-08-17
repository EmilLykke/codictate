// Pinned Vendor Binary releases and the exact file lists Codictate ships from them.
//
// Both `scripts/pre-build.ts` (which downloads and verifies) and
// `electrobun.config.ts` (which copies into the app bundle) read these lists, so
// they cannot drift apart. `electrobun.config.ts` is evaluated before pre-build
// runs, which is why the lists are hardcoded here instead of discovered by
// scanning `vendors/` at build time.
//
// See docs/adr/0001-vendor-binary-sourcing.md for why these are prebuilt rather
// than source builds, and docs/adr/0002-asr-harness-abstraction.md for crispasr.

/** PrismML fork of llama.cpp. Only this fork's `llama-completion` loads Q2_0 ternary weights. */
export const LLAMA_VERSION = "prism-b8846-d104cf1";
export const LLAMA_RELEASE_BASE =
  `https://github.com/PrismML-Eng/llama.cpp/releases/download/${LLAMA_VERSION}`;

/** CrispASR, the second ASR Harness. Single prebuilt binary, also the only runtime for Cohere ASR weights. */
export const CRISPASR_VERSION = "v0.8.29";
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
  sha256: "2c9f5cc15b5d10f214abd7b72352221c938bb718c3aceea54e828293002b6244",
  stripPrefix: `llama-${LLAMA_VERSION}`,
};

/**
 * Windows llama ships as two overlaid archives: the cpu package carries
 * `llama-completion.exe` plus llama/ggml core DLLs, and the vulkan package
 * carries only `ggml-vulkan.dll` (the GPU backend ggml-base loads at runtime).
 */
export const LLAMA_WINDOWS_ARCHIVES: VendorArchive[] = [
  {
    asset: "llama-bin-win-cpu-x64.zip",
    sha256: "692383dcc8ddb2f29f657c16c3dfd79f4d09c656f9d8f82f8b1739b2f07db4f7",
  },
  {
    asset: "llama-bin-win-vulkan-x64.zip",
    sha256: "9a8ed12a1ede3e2b3721128d0786c58e32392322a6a39e944eb4b10562260bed",
  },
];

/**
 * The eight `@rpath` dylibs `llama-completion` links against, verified with
 * `otool -L`. In the archive these names are symlinks to versioned files; the
 * vendoring step resolves them so `vendors/llama/` holds plain files that
 * `post-build.ts` can codesign one by one.
 */
export const LLAMA_MACOS_DYLIBS = [
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
 * `ggml-base.dll` picks one `ggml-cpu-*.dll` at runtime based on the host CPU,
 * so every variant ships or older machines lose the CPU backend entirely.
 */
export const LLAMA_WINDOWS_DLLS = [
  "llama.dll",
  "llama-common.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-rpc.dll",
  "ggml-vulkan.dll",
  "libomp140.x86_64.dll",
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
  sha256: "1425b177a19ff763dcf057c13f4f5244b902e53dc72c3c8be037276a66faf941",
  stripPrefix: "crispasr-macos",
};

/** Vulkan variant, matching the Vulkan-on Windows build of whisper-cli. */
export const CRISPASR_WINDOWS_ARCHIVE: VendorArchive = {
  asset: "crispasr-windows-x86_64-vulkan.zip",
  sha256: "d43c17f8a6c351fd988578d992f1b7753a342af26a8eea1416d7cf58f9daab0f",
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
