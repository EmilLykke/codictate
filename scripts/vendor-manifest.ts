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
 * Upstream llama.cpp. Publishes `llama-completion` for every target platform, and
 * loads the Q4_K_M formatter weights Codictate actually ships. Codictate used the
 * PrismML fork for its Q2_0 ternary support; nothing shipping needs Q2_0, so this
 * is back on upstream. See docs/adr/0001-vendor-binary-sourcing.md.
 */
export const LLAMA_VERSION = "b10470";
export const LLAMA_RELEASE_BASE =
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;

/** CrispASR, the only ASR Harness. Single prebuilt binary, also the only runtime for Cohere ASR weights. */
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
  sha256: "75c29cd80a67a8388b8ed08ea4a87531269a737c18945bdf3c3db6d5858024a9",
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
  sha256: "2e89637b30e0e2f90d4ed486118e8642f60625b1dbebb9ba3a30bc4100306fc9",
};

/**
 * Ubuntu Vulkan build. Built on Ubuntu 22.04 (GCC 11), so it runs on any glibc
 * at least that new. Beyond glibc and libstdc++, it needs `libvulkan.so.1`,
 * `libgomp.so.1` and OpenSSL 3 (`libssl.so.3`, `libcrypto.so.3`) from the host;
 * the archive does not carry them.
 */
export const LLAMA_LINUX_X64_ARCHIVE: VendorArchive = {
  asset: `llama-${LLAMA_VERSION}-bin-ubuntu-vulkan-x64.tar.gz`,
  sha256: "21f765c89d87c9a7822cde1af199face8b927b099d28a853c53fb01604fcff6b",
  stripPrefix: `llama-${LLAMA_VERSION}`,
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

/**
 * `llama-completion`'s DT_NEEDED closure inside the archive (RUNPATH `$ORIGIN`,
 * verified with `readelf -d` and `ldd`), plus the backends `libggml.so.0` loads
 * with `dlopen` from the executable's directory rather than linking:
 * `libggml-vulkan.so`, `libggml-rpc.so`, and one `libggml-cpu-*.so` picked at
 * runtime from the host CPU. Every CPU variant ships, as on Windows. In the
 * archive the versioned names are symlinks; vendoring resolves them to files.
 */
export const LLAMA_LINUX_SHARED_LIBS = [
  "libllama-completion-impl.so",
  "libllama-common.so.0",
  "libllama.so.0",
  "libggml.so.0",
  "libggml-base.so.0",
  "libggml-rpc.so",
  "libggml-vulkan.so",
  "libggml-cpu-alderlake.so",
  "libggml-cpu-cannonlake.so",
  "libggml-cpu-cascadelake.so",
  "libggml-cpu-cooperlake.so",
  "libggml-cpu-haswell.so",
  "libggml-cpu-icelake.so",
  "libggml-cpu-ivybridge.so",
  "libggml-cpu-piledriver.so",
  "libggml-cpu-sandybridge.so",
  "libggml-cpu-sapphirerapids.so",
  "libggml-cpu-skylakex.so",
  "libggml-cpu-sse42.so",
  "libggml-cpu-x64.so",
  "libggml-cpu-zen4.so",
];

// -- crispasr ----------------------------------------------------------------

/**
 * crispasr ships its own `ggml.dll` / `ggml-base.dll` / `ggml-vulkan.dll`, which
 * collide by name with llama's. It therefore lands in its own subdirectory of
 * `native-helpers/` on every platform rather than next to llama-completion.
 */
export const CRISPASR_BUNDLE_SUBDIR = "crispasr";

export const CRISPASR_MACOS_ARCHIVE: VendorArchive = {
  asset: "crispasr-macos.tar.gz",
  sha256: "1425b177a19ff763dcf057c13f4f5244b902e53dc72c3c8be037276a66faf941",
  stripPrefix: "crispasr-macos",
};

/** Vulkan variant, matching the Vulkan-on Windows build of llama-completion. */
export const CRISPASR_WINDOWS_ARCHIVE: VendorArchive = {
  asset: "crispasr-windows-x86_64-vulkan.zip",
  sha256: "d43c17f8a6c351fd988578d992f1b7753a342af26a8eea1416d7cf58f9daab0f",
  stripPrefix: "crispasr-windows-x86_64-vulkan",
};

/**
 * Vulkan variant, matching the Vulkan build of llama-completion. ggml is linked
 * statically into `crispasr`, so the only shared libraries are the ones below;
 * `libvulkan.so.1`, libstdc++ and glibc come from the host.
 */
export const CRISPASR_LINUX_X64_ARCHIVE: VendorArchive = {
  asset: "crispasr-linux-x86_64-vulkan.tar.gz",
  sha256: "74906231768a8e96cf5e21a37bd983bd85aeab47c928d08391eb1ab753fd12b7",
  stripPrefix: "crispasr-linux-x86_64-vulkan",
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

/**
 * `crispasr`'s DT_NEEDED closure inside the archive, verified with `readelf -d`
 * and `ldd`: every file has RUNPATH `$ORIGIN`, so they sit next to the binary.
 * `libopenblas.so.0` pulls in `libgfortran.so.5`, which pulls in `libquadmath.so.0`.
 */
export const CRISPASR_LINUX_SHARED_LIBS = [
  "libc2pa_c.so",
  "libopenblas.so.0",
  "libgomp.so.1",
  "libgfortran.so.5",
  "libquadmath.so.0",
];
