# Vendor binaries come from upstream releases where they exist, source builds only where they do not

`scripts/pre-build.ts` originally built every Vendor Binary from source with cmake, costing contributors 3 to 5 minutes for `whisper-cli` and 5 to 10 minutes for `llama-completion` on a fresh clone or in CI, plus a cmake dependency on every dev machine. We now download published release binaries whenever upstream publishes one for the target platform, and keep a source build only where no release asset exists.

## Considered Options

- **Keep building everything from source.** Uniform, static, no asset-naming churn, but pays the full build cost on every fresh clone and CI run.
- **Build once in our own CI and publish to a Codictate-owned release.** Uniform and signable, but adds a release pipeline we would have to maintain per platform.
- **Download upstream release binaries (chosen).** Cheapest by far. Verified empirically: the pinned `b10470` macOS arm64 tarball contains `llama-completion` plus the nine `@rpath` dylibs it links, and running it straight out of its extracted directory against the app's real formatter model (`Qwen2.5-3B-Instruct-Q4_K_M.gguf`) with the app's exact flag set exits 0 and returns correct constrained JSON.

## Which llama.cpp

`llama-completion` comes from **upstream `ggml-org/llama.cpp`**, not the PrismML fork Codictate used previously.

The fork was adopted for one reason: `GGML_TYPE_Q2_0` ternary weights, needed by `Ternary-Bonsai-1.7B-Q2_0`. That reason no longer applies. Nothing Codictate ships loads Q2_0 (both Formatting Backend models are Q4_K_M, see `src/bun/platform/runtime.ts`), and Ternary-Bonsai appears nowhere in the app. The fork's other distinguishing feature, renaming `llama-cli` to `llama-completion`, is also moot because upstream publishes `llama-completion` itself now.

Staying on the fork would have meant keeping a stale single-maintainer fork on the shipping formatting path, roughly 1600 builds behind upstream. It was also materially worse to package: the fork's Windows Vulkan asset is a stale `ggml-vulkan.dll` on its own, so Windows needed two overlaid archives and 21 hardcoded DLL names. Upstream's single `llama-b10470-bin-win-vulkan-x64.zip` is self-contained, verified by walking the PE import table of `llama-completion.exe` recursively: every non-system dependency is inside the archive, and the only externals are Windows system DLLs plus the MSVC runtime that `ensureWindowsVcRuntimeDlls()` already vendors.

Reintroducing a ternary-quantized formatter model would mean revisiting this decision, because upstream cannot load those weights.

## Consequences

- `llama-completion` now arrives as a binary plus sibling dylibs rather than one static executable. This is safe for notarization because `post-build.ts` discovers signing targets via `isCodesignableMachO()` (Mach-O magic detection), not a hardcoded name list, so the dylibs are signed with the Developer ID automatically. The dylibs must stay in the same directory as the binary for `@rpath` resolution.
- `crispasr` ships its own `ggml.dll`, `ggml-base.dll` and `ggml-vulkan.dll`, whose names collide with llama's. It therefore lands in a `native-helpers/crispasr/` subdirectory, and `listCodesignableNativeHelpers()` walks `native-helpers` recursively so nothing under `Resources/app/` is left unsigned.
- Vendor Binaries are shared-library based now, so the file lists live in `scripts/vendor-manifest.ts`. `electrobun.config.ts` is evaluated before the pre-build script runs, so it cannot discover them by scanning `vendors/` and both sides read the same pinned lists instead.
- Upstream ships **no macOS CLI build of whisper.cpp** (only Windows, Ubuntu, and an xcframework), so `whisper-cli` keeps its source build until it is retired in favour of `crispasr`. See `docs/adr/0002-asr-harness-abstraction.md`.
- Every downloaded binary is pinned to an exact release tag and verified by sha256. Prebuilt binaries arrive adhoc-signed and are re-signed locally.
- Binaries are fetched for both macOS and Windows in the same change, per the project's platform parity rule in `AGENTS.md`.
