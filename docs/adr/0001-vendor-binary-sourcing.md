# Vendor binaries come from upstream releases where they exist, source builds only where they do not

`scripts/pre-build.ts` originally built every Vendor Binary from source with cmake, costing contributors 3 to 5 minutes for `whisper-cli` and 5 to 10 minutes for `llama-completion` on a fresh clone or in CI, plus a cmake dependency on every dev machine. We now download published release binaries whenever upstream publishes one for the target platform, and keep a source build only where no release asset exists.

## Considered Options

- **Keep building everything from source.** Uniform, static, no asset-naming churn, but pays the full build cost on every fresh clone and CI run.
- **Build once in our own CI and publish to a Codictate-owned release.** Uniform and signable, but adds a release pipeline we would have to maintain per platform.
- **Download upstream release binaries (chosen).** Cheapest by far. Verified empirically: the pinned `prism-b8846-d104cf1` macOS arm64 tarball is 8.5 MB, contains `llama-completion` plus eight `@rpath` dylibs, and runs correctly straight out of its extracted directory with Metal active.

## Consequences

- `llama-completion` now arrives as a binary plus sibling dylibs rather than one static executable. This is safe for notarization because `post-build.ts` discovers signing targets via `isCodesignableMachO()` (Mach-O magic detection), not a hardcoded name list, so the dylibs are signed with the Developer ID automatically. The dylibs must stay in the same directory as the binary for `@rpath` resolution.
- Upstream ships **no macOS CLI build of whisper.cpp** (only Windows, Ubuntu, and an xcframework), so `whisper-cli` keeps its source build until it is retired in favour of `crispasr`. See `docs/adr/0002-asr-harness-abstraction.md`.
- Every downloaded binary is pinned to an exact release tag and verified by sha256. Prebuilt binaries arrive adhoc-signed and are re-signed locally.
- Binaries are fetched for both macOS and Windows in the same change, per the project's platform parity rule in `AGENTS.md`.
