<div align="center">
  <img src="logo.png" width="120" alt="Codictate" />

  # Codictate

  **Local-first dictation for macOS and Windows. Hit your shortcut, speak, and your words appear wherever your cursor is — no cloud, no account.**
</div>

**Website:** [codictate.app](https://codictate.app) · [Releases](https://github.com/EmilLykke/codictate/releases) · [Changelog](CHANGELOG.md)

## Features

| Feature | macOS | Windows |
|---------|:-----:|:-------:|
| Local Whisper transcription | ✓ | ✓ |
| Global shortcut dictation | ✓ | ✓ |
| Formatting — Qwen2.5 3B / Qwen3 4B (llama.cpp) | ✓ | ✓ |
| Formatting — Apple Intelligence (macOS 26+) | ✓ | — |
| Floating recording indicator | ✓ | ✓ |
| Stream mode | ✓ | — |
| No account, no analytics | ✓ | ✓ |

## Download

Grab the latest build from [**Releases**](https://github.com/EmilLykke/codictate/releases).

| Channel | Use when |
|---------|----------|
| **Stable** | Recommended for most users |
| **Canary** | Latest changes, updated more often |

## Installation

### macOS (Homebrew)

```bash
brew install emillykke/tap/codictate
```

### macOS (manual)

1. Download the `.dmg` and drag **Codictate** to Applications
2. Open Codictate and grant the requested permissions (Input Monitoring, Accessibility, Microphone)

Full step-by-step with screenshots: **[docs/INSTALL.md](docs/INSTALL.md)**

Using **AeroSpace**? See **[docs/AEROSPACE.md](docs/AEROSPACE.md)** for an optional window rule snippet.

### Windows

Download and run the `*-Setup.exe` installer from Releases. It installs per-user and can be removed from Windows **Settings → Apps → Installed apps**.

### Requirements

| Platform | Requirement |
|----------|-------------|
| macOS | 13 or later, Apple Silicon (M1+) |
| Windows | 10 or later, x64 |

## Formatting

Codictate can reformat raw transcriptions before pasting — e.g. turning spoken words into a properly structured email.

Two backends are available depending on your platform:

| Backend | Availability | Models |
|---------|-------------|--------|
| **llama.cpp (Qwen)** | macOS, Windows | Qwen2.5 3B (~2 GB) or Qwen3 4B (~2.5 GB), downloaded in-app |
| **Apple Intelligence** | macOS 26+, Apple Intelligence enabled | On-device, no download |

See **[docs/FORMATTING.md](docs/FORMATTING.md)** for details.

## Development

### Requirements

- [Bun](https://bun.sh) v1.3+
- [cmake](https://cmake.org) — builds `whisper-cli` and `llama-completion` (both platforms)
- Xcode Command Line Tools — Swift compilation (macOS only)
- Rust toolchain — macOS: NeMo ITN for `CodictateParakeetHelper`; Windows: `CodictateWindowsHelper`
- Vulkan SDK — GPU acceleration for whisper/llama on Windows (install [LunarG Vulkan SDK](https://vulkan.lunarg.com), ensure `glslc` is on PATH)

### Setup

```bash
bun install
bun run scripts/pre-build.ts   # downloads and builds vendor binaries + Whisper model (~547 MB)
```

### Running

```bash
# macOS
bun run start        # dev mode
bun run dev:hmr      # with HMR

# Windows
bun run start:windows
```

### Building locally

```bash
# macOS
bun run build:canary
bun run build:stable

# Windows
bun run build:native:windows-helper   # compile CodictateWindowsHelper (Rust)
# then build:canary / build:stable via CI, or run start:windows for dev
# CI also wraps Windows release builds with Inno Setup so they are uninstallable
bun run build:installer:windows       # after a local Windows Electrobun build, requires Inno Setup 6
```

Unsigned local builds work without any `.env` configuration. To sign locally, copy `.env.example` to `.env` and fill in Apple developer credentials. See **[docs/MACOS_SIGNING_AND_NOTARIZATION.md](docs/MACOS_SIGNING_AND_NOTARIZATION.md)**.

### macOS app icon workflow

For macOS, the packaged app icon should be a flat square asset without a baked-in rounded border or shadow, because macOS applies its own outer treatment. In this repo, `src/assets/images/MacAppIconFlat.svg` is the canonical source. The build rasterizes it into `src/assets/images/MacDocIcon.png` and regenerates `icon.iconset/` from that output because Electrobun still packages macOS icons through the legacy `.iconset` path.

## Releasing

```bash
bun run release:canary
bun run release:stable
bun run release        # both channels
```

This commits the version bump, pushes a git tag, and triggers the CI workflow which builds macOS and Windows in parallel and publishes the GitHub Release automatically.

See **[docs/RELEASING.md](docs/RELEASING.md)** for the full guide including first-time setup.

## Project structure

```
src/
  bun/                  # Main process (Bun/Electrobun)
  mainview/             # React frontend (Vite)
native/
  CodictateWindowHelper/    # macOS: recording HUD (AppKit NSPanel)
  CodictateParakeetHelper/  # macOS: Parakeet ASR helper
  CodictateObserverHelper/  # macOS: correction observer
  CodictateWindowsHelper/   # Windows: keyboard hook + mic recording + indicator (Rust, single binary)
scripts/
  pre-build.ts          # Vendor binary + model setup
  post-build.ts         # App bundle patching + codesign helpers
  release.sh            # Version bump + tag push
.github/workflows/
  release.yml           # Tag-triggered: builds both platforms, publishes release
  build-macos.yml       # Manual macOS build (no release)
  build-windows.yml     # Manual Windows build (no release)
docs/
  INSTALL.md                        # User install guide (with screenshots)
  FORMATTING.md                     # Formatting feature — both backends
  RELEASING.md                      # Maintainer release guide
  MACOS_SIGNING_AND_NOTARIZATION.md # Signing and notarization reference
  RECORDING_INDICATOR.md            # Recording HUD architecture
  AEROSPACE.md                      # AeroSpace window rule snippet
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
