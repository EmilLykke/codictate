# Codictate — Architecture

## What Codictate does

Codictate is a local-first dictation app. The user presses a global keyboard shortcut, speaks into their microphone, and the transcribed (and optionally formatted) text is pasted wherever the cursor is. Everything runs on-device — no cloud services, no accounts, no analytics.

Supported platforms: macOS (Apple Silicon, macOS 13+) and Windows (x64, Windows 10+).

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Electrobun (NOT Electron) |
| Main process runtime | Bun |
| Frontend | React 19, Vite, Tailwind CSS v4 |
| Animation | Motion (Framer Motion) |
| Data fetching | @tanstack/react-query |
| Speech-to-text | Whisper (whisper-cli via whisper.cpp) and Parakeet (FluidAudio/FluidInference via CodictateParakeetHelper) |
| Formatting | llama.cpp running Qwen2.5 3B / Qwen3 4B, or Apple Intelligence (macOS 26+) |
| Native helpers | Swift (macOS), Rust (Windows) |

## Project structure

```
src/
  bun/                          # Main process (Bun + Electrobun)
    index.ts                    # Entry point
    AppConfig/                  # Persistent app configuration
    platform/                   # Platform-specific code
      macos/                    #   macOS implementations
      windows/                  #   Windows implementations
      linux/                    #   Linux implementations (planned)
    setup-indicator-window.ts   # Recording indicator lifecycle
    setup-menu.ts               # App menu
    setup-recording.ts          # Dictation recording orchestration
    setup-tray.ts               # System tray
    setup-window.ts             # Main window
    utils/                      # Utilities (keyboard, audio, etc.)

  mainview/                     # React frontend (Vite-bundled)
    main.tsx                    # React entry
    App.tsx                     # Root component and routing
    index.css                   # Tailwind + theme tokens
    rpc.ts                      # Electrobun RPC bridge
    app-events.ts               # App-level event handling
    indicator/                  # Recording indicator webview
    components/
      Brand/                    # Branding (wordmark)
      Common/                   # Shared UI (Kbd, RecordingOrb, tooltips, etc.)
      Home/                     # Home screen
      Layout/                   # App layout shell
      MainContainer.tsx         # Main container component
      Onboarding/               # First-run onboarding
      Permissions/              # macOS permission prompts
      Settings/                 # Settings modal and sections

  shared/                       # Types and constants shared between bun and mainview
    types.ts                    # Core shared types
    platform.ts                 # Platform detection
    speech-models.ts            # Speech model definitions
    whisper-models.ts           # Whisper model configs
    formatting-modes.ts         # Formatting mode definitions
    dictation-shortcut.ts       # Shortcut config types
    shortcut-options.ts         # Available shortcut options
    recording-duration-presets.ts
    transcription-languages.ts
    windows-helper-protocol.ts  # IPC protocol for Windows helper

native/
  CodictateWindowHelper/        # macOS: recording HUD (AppKit NSPanel)
  CodictateParakeetHelper/      # macOS: Parakeet ASR (FluidAudio engine)
  CodictateObserverHelper/      # macOS: correction observer
  CodictateWindowsHelper/       # Windows: keyboard hook + mic + indicator (Rust)

scripts/
  pre-build.ts                  # Downloads vendor binaries + Whisper model
  post-build.ts                 # App bundle patching + codesign
  release.sh                    # Version bump + tag push

docs/
  INSTALL.md                    # User install guide
  FORMATTING.md                 # Formatting feature docs
  RELEASING.md                  # Maintainer release guide
  RECORDING_INDICATOR.md        # Recording HUD architecture
  MACOS_SIGNING_AND_NOTARIZATION.md
  AEROSPACE.md                  # AeroSpace window rule

vendors/                        # Pre-built vendor binaries (whisper-cli, llama-completion, etc.)
```

## Key architecture details

### Electrobun — not Electron

Electrobun uses the OS native webview instead of bundling Chromium. Import patterns:
- Main process: `import { ... } from "electrobun/bun"`
- Browser/webview: `import { ... } from "electrobun/view"`
- Bundled views loaded via `views://` URLs
- Views must be registered in `electrobun.config.ts`

### Recording indicator

A native floating HUD showing dictation state (ready / recording / transcribing). On macOS it's a Swift AppKit `NSPanel` (`CodictateWindowHelper`); on Windows it's a Win32 layered window inside `CodictateWindowsHelper` (Rust). Both communicate with the main Bun process over stdin/stdout JSON lines.

See `docs/RECORDING_INDICATOR.md` for full details.

### Speech engines

- **Whisper**: runs via `whisper-cli` (built from whisper.cpp). The default engine.
- **Parakeet**: runs via `CodictateParakeetHelper` (macOS only). The engine ID in code is `whisperkit` but the actual engine is **FluidAudio** (FluidInference) — not WhisperKit.

### Formatting pipeline

Raw transcription can be reformatted before pasting (e.g. turning spoken words into a structured email):
- **llama.cpp backend**: runs Qwen2.5 3B (~2 GB) or Qwen3 4B (~2.5 GB) locally via `llama-completion`
- **Apple Intelligence backend**: macOS 26+ only, uses on-device Apple Intelligence

## Frontend theme

Defined in `src/mainview/index.css`:

```css
--font-sans: "Iceland"        /* Body text */
--font-brand: "Iceberg"       /* Branding / display */
--color-codictate-page         /* Page background (black) */
--color-codictate-canvas       /* Canvas background */
--color-codictate-foreground   /* Text color (white) */
--color-codictate-paper        /* Semi-transparent surface */
```

Both Iceland and Iceberg fonts are very small at standard sizes — always use larger font sizes than typical. The base body font-size is 23px.
