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
// docs/adr/0002-asr-harness-abstraction.md for the two ASR Harnesses, crispasr and
// parakeet-cli.

/**
 * Upstream llama.cpp. Publishes `llama-completion` for both target platforms, and
 * loads the Q4_K_M formatter weights Codictate actually ships. Codictate used the
 * PrismML fork for its Q2_0 ternary support; nothing shipping needs Q2_0, so this
 * is back on upstream. See docs/adr/0001-vendor-binary-sourcing.md.
 */
export const LLAMA_VERSION = "b11496";
export const LLAMA_RELEASE_BASE =
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;

/** CrispASR, the default ASR Harness. Single prebuilt binary, also the only runtime for Cohere ASR weights. */
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

// -- parakeet-cli --------------------------------------------------------------

/**
 * parakeet.cpp, whose `parakeet-cli` is the ASR Harness of the ekko Speech Engine and of
 * nothing else (#76). MIT.
 */
export const PARAKEET_CPP_VERSION = "v0.6.1";
export const PARAKEET_CPP_RELEASE_BASE =
  `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_CPP_VERSION}`;

/**
 * The Metal build. The binary links only system frameworks (`otool -L`: Accelerate,
 * Foundation, Metal, MetalKit, libc++, libSystem), so it ships alone and post-build signs it
 * with hardened runtime and no entitlements file.
 */
export const PARAKEET_CLI_MACOS_ARCHIVE: VendorArchive = {
  asset: `parakeet-${PARAKEET_CPP_VERSION}-bin-macos-metal-arm64.tar.gz`,
  sha256: "bc97b5e6253e928d1127f48f08242324317495ef8708e31db1e09b9537d1bb74",
  stripPrefix: `parakeet-${PARAKEET_CPP_VERSION}-bin-macos-metal-arm64`,
};

/**
 * The CPU build, not Vulkan: proven on the Windows CI runner, 34 MB smaller, and no
 * GPU-driver failure mode (#76). `parakeet-cli.exe` ships alone: its imports are Windows
 * system DLLs and the MSVC runtime (MSVCP140, VCRUNTIME140, VCRUNTIME140_1, VCOMP140).
 * No pinned archive ships `vcomp140.dll`, and the runtime DLLs pre-build copies land in
 * `native-helpers/`, not beside the exe, so it needs the VC++ Redistributable installed
 * (as crispasr does). Unverified on consumer Windows.
 */
export const PARAKEET_CLI_WINDOWS_ARCHIVE: VendorArchive = {
  asset: `parakeet-${PARAKEET_CPP_VERSION}-bin-win-cpu-x64.zip`,
  sha256: "d74b4e857f75f91ae215c5e91ec42bf15ec84ed3a369423c134dbd6422243ed8",
  stripPrefix: `parakeet-${PARAKEET_CPP_VERSION}-bin-win-cpu-x64`,
};

/**
 * The archive's MIT licence, vendored beside the binary. The app bundles the committed copy
 * of it, `docs/licenses/parakeet-cpp/LICENSE`.
 */
export const PARAKEET_CPP_LICENSE_FILE = "LICENSE";

// -- Silero VAD ----------------------------------------------------------------

export interface VendorFile {
  /** File name in `vendors/<dir>/` and in the bundle. */
  name: string;
  /** Pinned download URL (a Hugging Face `resolve/<commit sha>` path, never `main`). */
  url: string;
  sha256: string;
}

/**
 * The Silero VAD weights crispasr loads with `--vad -vm <path>` when a Whisper Speech Model
 * decodes with timestamps (ADR-0011). Shipped in the
 * bundle beside crispasr on both platforms so crispasr never downloads them at runtime.
 * 885098 bytes. MIT, see docs/licenses/silero-vad/LICENSE.
 */
export const SILERO_VAD: VendorFile = {
  name: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};

/** `vendors/` subdirectory the Silero VAD weights are vendored into. */
export const SILERO_VAD_VENDOR_DIR = "silero-vad";
