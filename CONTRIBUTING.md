# Contributing

## Getting started

Fork the repo, make your changes on a branch, and open a pull request. For substantial changes, open an issue first so we can align before you invest time.

After your first merged PR you'll be added to [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Setup

### macOS

**Requirements:** Bun v1.3+, Xcode Command Line Tools, cmake, Rust toolchain

```bash
brew install cmake sdl2
bun install
bun run start          # or bun run dev:hmr for HMR
```

cmake is needed only for `whisper-cli`, which is still built from source because
upstream whisper.cpp publishes no macOS CLI asset. `llama-completion` and `crispasr`
are downloaded prebuilt and sha256-verified, so they cost no build time. See
[docs/adr/0001-vendor-binary-sourcing.md](docs/adr/0001-vendor-binary-sourcing.md).

### Windows (x64)

**Requirements:** Bun v1.3+, cmake, Rust toolchain, [LunarG Vulkan SDK](https://vulkan.lunarg.com) (ensure `glslc` is on `PATH`)

Vulkan is required to build `whisper-cli` with GPU support. `llama-completion` and
`crispasr` are downloaded prebuilt in their Vulkan variants, so they need no local
Vulkan build.

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

Windows releases build through CI (`build-windows.yml`) — use `start:windows` for local dev. Unsigned builds work without any `.env` setup. For signed macOS builds, copy `.env.example` to `.env` — see [docs/MACOS_SIGNING_AND_NOTARIZATION.md](docs/MACOS_SIGNING_AND_NOTARIZATION.md).

## CI

Pushing a `v*` tag triggers `release.yml`, which builds macOS and Windows in parallel and publishes the GitHub Release. Use `build-macos.yml` / `build-windows.yml` for manual one-off builds.

## Pull requests

- Describe the user-facing change and how you tested it.
- Update docs when behavior, setup, or release flow changes.
- Don't mix refactors with unrelated fixes.

## We're looking for contributors

| Area | Notes |
|------|-------|
| **Windows ARM64** | No hardware available — untested |
| **Linux** | We plan to test this ourselves, but contributions are welcome |
| **Windows dev setup** | Additional platform testing and edge-case fixes |

If you can help with any of these, open an issue to coordinate before starting.

## License

By submitting a contribution, you agree your work will be licensed under the Apache License 2.0.
