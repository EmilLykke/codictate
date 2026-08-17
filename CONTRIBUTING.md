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

## CI

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
