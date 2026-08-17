# Contributing

## Getting started

Fork the repo, make your changes on a branch, and open a pull request. For substantial changes, open an issue first so we can align before you invest time.

After your first merged PR you'll be added to [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Setup

### macOS

**Requirements:** Bun v1.3+, Xcode Command Line Tools, Rust toolchain

```bash
bun install
bun run start          # or bun run dev:hmr for HMR
```

No cmake. Both Vendor Binaries, `crispasr` (speech) and `llama-completion`
(formatting), are downloaded prebuilt and sha256-verified, so they cost no build time.
The last source build was `whisper-cli`, and it went away when that binary was retired.
See [docs/adr/0001-vendor-binary-sourcing.md](docs/adr/0001-vendor-binary-sourcing.md)
and [docs/adr/0002-asr-harness-abstraction.md](docs/adr/0002-asr-harness-abstraction.md).

### Windows (x64)

**Requirements:** Bun v1.3+, Rust toolchain

No Vulkan SDK either: `crispasr` and `llama-completion` are downloaded prebuilt in their
Vulkan variants, so nothing has to be compiled against Vulkan locally.

```bash
bun install
bun run start:windows
```

### Vendoring one binary at a time

The vendoring step caches into `vendors/` (gitignored) and only runs once. To refresh a
single Vendor Binary without redoing the rest:

```bash
bun run scripts/pre-build.ts --llama-only
bun run scripts/pre-build.ts --crispasr-only
bun run scripts/pre-build.ts --parakeet-only   # macOS only
```

## Building

```bash
# macOS
bun run build:canary
bun run build:stable
```

Windows releases build through CI (`build-windows.yml`) - use `start:windows` for local dev. Unsigned builds work without any `.env` setup. For signed macOS builds, copy `.env.example` to `.env` - see [docs/MACOS_SIGNING_AND_NOTARIZATION.md](docs/MACOS_SIGNING_AND_NOTARIZATION.md).

## Tests and checks

```bash
bun run test          # the test suite (bun test, all *.test.ts)
bun run lint          # ESLint (lint:fix to autofix)
bun run tsc           # type-check both tsconfigs
```

Two suites are opt-in and carry a `.manual.ts` suffix, which keeps them out of `bun test` discovery:

```bash
bun run test:manual                                                  # both
bun test ./src/bun/utils/whisper/model-download-reachability.manual.ts  # live network
bun test ./benchmarks/stt/results-archive.manual.ts                    # Benchmark Run archive
```

The first fetches every model download URL from Hugging Face, so it needs a network and flakes without one. The second is pinned to the four committed Benchmark Runs, so archiving a fifth run breaks it by design. Run the first after changing a download URL or the Speech Model list, and the second when the results archive or its read path moves. The `./` prefix is required - without it `bun test` treats the argument as a name filter and runs nothing.

On a Windows host, `bun run check:native:windows-helper` runs `cargo fmt --check`, `cargo check`, `cargo clippy -D warnings` and `cargo test` for the Rust helper.

## CI

`ci.yml` runs the test suite, lint and type-checking on every push to `main` and every pull request, plus the Rust helper checks on a Windows runner. The opt-in suites above are not part of it.

Pushing a `v*` tag triggers `release.yml`, which builds macOS and Windows in parallel and publishes the GitHub Release. Use `build-macos.yml` / `build-windows.yml` for manual one-off builds.

## Pull requests

- Describe the user-facing change and how you tested it.
- Update docs when behavior, setup, or release flow changes.
- Don't mix refactors with unrelated fixes.

## We're looking for contributors

| Area | Notes |
|------|-------|
| **Windows ARM64** | No hardware available - untested |
| **Linux** | We plan to test this ourselves, but contributions are welcome |
| **Windows dev setup** | Additional platform testing and edge-case fixes |

If you can help with any of these, open an issue to coordinate before starting.

## License

By submitting a contribution, you agree your work will be licensed under the Apache License 2.0.
