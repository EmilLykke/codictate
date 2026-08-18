# Codictate - Architecture

## What Codictate does

Codictate is a local-first dictation app. The user presses a global keyboard shortcut, speaks into their microphone, and the transcribed (and optionally formatted) text is pasted wherever the cursor is. Everything runs on-device - no cloud services, no accounts, no analytics.

Supported platforms: macOS (Apple Silicon, macOS 13+) and Windows (x64, Windows 10+).

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Electrobun (NOT Electron) |
| Main process runtime | Bun |
| Frontend | React 19, Vite, Tailwind CSS v4 |
| Animation | Motion (Framer Motion) |
| Data fetching | @tanstack/react-query |
| Speech-to-text | Whisper and Danish hviske (both via the `crispasr` ASR Harness) and Parakeet (FluidAudio/FluidInference via CodictateParakeetHelper) |
| Formatting | llama.cpp running Qwen2.5 3B / Qwen3 4B, or Apple Intelligence (macOS 26+) |
| Native helpers | Swift (macOS), Rust (Windows) |

## Quick reference

| Command | Purpose |
|---------|---------|
| `bun run start` | Dev mode (macOS) |
| `bun run dev:hmr` | Dev with HMR (macOS) |
| `bun run start:windows` | Dev mode (Windows) |
| `bun run lint:fix` | ESLint fix |
| `bun run tsc` | Type-check both tsconfigs |
| `bun run test` | Run the test suite |
| `bun run test:manual` | Run the two opt-in suites (network, Benchmark Run archive) |
| `bun run check:native:windows-helper` | Rust helper fmt / check / clippy / test (Windows host) |

## Tests and CI

`bun run test` is `bun test` with no arguments: it discovers every `*.test.ts` in the repo. Those are pure-function tests - no spawn, no filesystem, no webview - which is what lets them run on any platform.

Two suites are deliberately outside that run and carry a `.manual.ts` suffix so `bun test` never discovers them:

| Suite | Why it is opt-in |
|-------|------------------|
| `src/bun/utils/whisper/model-download-reachability.manual.ts` | Live `fetch` against Hugging Face and the hviske Mirror. Flakes offline or behind a proxy, and it imports no Codictate download code. Run it after changing a download URL or the Speech Model list. |
| `benchmarks/stt/results-archive.manual.ts` | Pinned to the four committed Benchmark Runs, including an exact `runCount`. A fifth archived run turns it red with nothing broken. Run it when the archive or the results read path moves, and update the pinned numbers in the same change. |

Run both with `bun run test:manual`, or one with `bun test ./benchmarks/stt/results-archive.manual.ts`. The leading `./` is required: without it `bun test` reads the argument as a name filter, matches nothing, and runs nothing.

`.github/workflows/ci.yml` runs `test`, `lint` and `tsc` on every push to `main` and every pull request, and runs `check:native:windows-helper` (which includes `cargo test` for the Rust matchers) on a Windows runner. The opt-in suites are not in CI by design.

New tests go in a `*.test.ts` beside the module they cover, and only pure functions belong in the default run. See `docs/ARCHITECTURE_REVIEW.md` candidate E for the interfaces still waiting for coverage.

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
    dictation-plan.ts           # Dictation Plan builder + shipped readiness (pure, no platform)
    settings-heal.ts            # Whole-object validation + the heal pass (pure, no platform)
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
  vendor-manifest.ts            # Pinned vendor releases + the file lists shipped from them
  mirror-hviske.ts              # Maintainer-run: mirror the hviske GGUF weights
  release.sh                    # Version bump + tag push

entitlements/                   # Per-helper macOS entitlements plists (codesigning)

docs/
  INSTALL.md                    # User install guide
  FORMATTING.md                 # Formatting feature docs
  RELEASING.md                  # Maintainer release guide
  RECORDING_INDICATOR.md        # Recording HUD architecture
  MACOS_SIGNING_AND_NOTARIZATION.md
  HVISKE_MIRROR.md              # The published Danish hviske Mirror
  AEROSPACE.md                  # AeroSpace window rule
  adr/                          # Architecture decision records

vendors/                        # Pre-built vendor binaries (crispasr, llama-completion, etc.)
```

## Key architecture details

### Electrobun - not Electron

Electrobun uses the OS native webview instead of bundling Chromium. Import patterns:
- Main process: `import { ... } from "electrobun/bun"`
- Browser/webview: `import { ... } from "electrobun/view"`
- Bundled views loaded via `views://` URLs
- Views must be registered in `electrobun.config.ts`

Never reach for Electron APIs or patterns.

### App lifecycle

`exitOnLastWindowClosed: false` — closing the last window does not quit. The app lives in the system tray, so tray and menu code stay live with no window open.

### Recording indicator

A native floating HUD showing dictation state (ready / recording / transcribing). On macOS it's a Swift AppKit `NSPanel` (`CodictateWindowHelper`); on Windows it's a Win32 layered window inside `CodictateWindowsHelper` (Rust). Both communicate with the main Bun process over stdin/stdout JSON lines.

See `docs/RECORDING_INDICATOR.md` for full details.

### Speech engines

- **Whisper**: the default engine. Runs under the single **ASR Harness**, `crispasr`, a prebuilt binary pinned and sha256-verified. `whisper-cli` is retired: it is gone from the harness list, the app bundle and the build, along with the `CODICTATE_ASR_HARNESS` override. There is no fallback harness, so an unresolvable `crispasr` binary fails dictation loudly. Harness stays internal and is never exposed to users. See `docs/adr/0002-asr-harness-abstraction.md`.
- **Parakeet**: runs via `CodictateParakeetHelper` on macOS and Windows; Linux has no helper yet (`getPlatformCapabilities().supportsStreamMode` in `src/bun/platform/runtime.ts` is the live answer). The engine ID in code is `whisperkit` but the actual engine is **FluidAudio** (FluidInference), not WhisperKit; compare against the exported `PARAKEET_ENGINE_ID` rather than re-typing the literal.
- **hviske**: Danish only, the mirrored `syvai/hviske-v5-tiny` GGUF weights. Runs on the same `crispasr` binary with `--backend cohere`, which is the only runtime that can read those weights. Ungated: no env var, no source-checkout requirement. All five Quantizations live in the browse modal ("Browse more models" in Settings) and none is curated, because a Danish-only model does not belong in the main list. Danish WER is measured now: the Benchmark Run `2026-08-18_08-17-28_hviske-vs-main-models` puts all five between 11.29 and 11.67 WER on FLEURS `da_dk`, which confirms syvai's identical-WER claim and beats every Whisper Speech Model ever measured on Danish, including Large V3 at 2.9 GB (12.67). `q5_0` is the recommended one in documentation, with `q4_k` for the smallest download; the old `f16` recommendation existed only to hedge the unverified claim and that reason is gone. Built for both platforms. The `cohere` backend is confirmed present in the shipped Windows binary (verified in the pinned `crispasr-windows-x86_64-vulkan.zip` for v0.8.29: `--backend` help lists `cohere`, and `CohereBackend` / `cohere_transcribe_ex` / `llm_build_cohere2_iswa` symbols are in `crispasr.exe` and `crispasr.dll`). What is still unverified is narrower: **no hviske Dictation has been run on Windows hardware**, so the end-to-end GGUF load, Vulkan device selection and output quality are unobserved. Do not upgrade that to a Windows support claim until someone runs it. See `docs/adr/0004-hviske-danish-ungated.md` and `docs/HVISKE_MIRROR.md`.

### Dictation resolution - no runtime fallbacks

A Dictation never adapts to an unrunnable state; the state is kept runnable instead. Do not add a fallback when a Speech Model, a Speech Engine capability or a Native Helper is unavailable - refuse the settings write, heal the config when availability changes, and do not offer the option in the UI.

- **One resolver.** `buildDictationPlan` in `src/shared/dictation-plan.ts` turns `(settings, availability snapshot)` into a **Dictation Plan** - a pure value, no `modelManager` and no `getPlatform`. Batch Dictation and Live Transcription are one union, discriminated by `mode`. `AppConfig.getDictationPlan()` is the only caller, once per press of the Dictation Shortcut, and the transcription path consumes the plan whole: `speech2text`, `startRecording` and `startParakeetStream` all take it and re-derive nothing. Never decide which Speech Model, Speech Engine, Transcription Language or crispasr backend runs anywhere else.
- **Runnable or blocked, nothing in between.** A blocked plan carries a reason from a closed union (`DictationBlockedReason`, eight members, each with a message in an exhaustive `Record` so a new failure mode cannot compile without one), starts no Dictation, and reaches four surfaces: an error chime, a tray error state, and the reason itself as a native notification when the main window is closed or an in-window banner when it is open. It also triggers the heal pass, so the next press works. There is no substitution and no silent drop. `assertParakeetStreamRuntimeReady` survives as the pre-spawn race check inside `startParakeetStream`, which now returns `{ status: 'blocked', plan }` instead of throwing an `Error` its caller discarded.
- **Enforced in three places.** `src/shared/settings-heal.ts` owns all three, as pure functions over `(settings, availability snapshot)`: `applyRunnableDictationPatch` validates the object a settings write would produce (a patch can be valid and its result invalid) and refuses a patch that asks for something unrunnable; `healDictationSettings` corrects the configuration on every availability change and at boot, because refusing to delete weights that happen to be selected is arguing with the user. `AppConfig` is the adapter: `updateTranscriptionSettings` for writes, `healRunnableSettings()` for `load()`, for a Speech Model download or delete, and for a blocked plan. The heal pass announces changes to the Speech Model selection, Translate to English and Live Transcription in `AppSettings.healAnnouncements`, and corrects everything else in silence.
- **Stats record what ran.** `engineId` and `languageId` come from the plan, not from live config read after the run - the user can change either mid-transcription.
- **Readiness is computed in the main process** and shipped in the settings payload. `getDictationReadiness(settings, availability)` in `dictation-plan.ts` answers "can Translate to English / Live Transcription run right now" as plain serialisable data - a closed reason union plus the finished sentence to show - and `AppConfig.getSettings()` puts it in `AppSettings.dictationReadiness`. The heal pass asks the same function, so the UI and the correction cannot disagree. The webview renders it and derives nothing from raw availability. Parakeet warmup is not a readiness *reason* - a cold Parakeet is slow on its first run, not unavailable - but `DictationReadiness.parakeetPreparing` ships the plain fact that a preparation is under way, so Settings states it without reaching for `modelAvailability` itself.
- **Parakeet prepares itself on selection.** `src/bun/utils/whisper/parakeet-warmup.ts` is the only place that decides when Parakeet's one-time on-device compile runs. The trigger is `AppConfig.observeRunnableDictationSettings`, which fires on every settle of the `(settings, availability)` pair, so selecting Parakeet from Settings, the tray or the app menu all start it, and so does a finished download of weights that are already selected. One preparation at a time, held in a single in-flight promise; a Dictation that lands inside that window waits on the promise rather than spawning a second helper against half-compiled weights. Do not add a fourth caller - reach it through the observer with `ensureParakeetWarm()`, and call `awaitParakeetWarmup()` before any new Parakeet spawn.
- **The selection is `speechModelId`.** One name for it in `AppSettings`, in `TranscriptionSettingsPatch`, on `AppConfig` and in `main-config.json`. `whisperModelId` is gone except as a legacy key `persistedSpeechModelId` still reads from, because the field never held a whisper-only id - hviske and Parakeet selections live there too, and the Speech Engine comes from the catalog entry.
- **Availability is a question, not a write.** `modelManager.isModelAvailable` stats the disk and changes nothing. The Parakeet legacy-folder migration and the stale Core ML cleanup live in `modelManager.reconcileInstalls()`, called at boot before the first availability read and again when a download finishes. Do not put a write back into the predicate: it is asked 2-4 times per Dictation Plan build, once per model inside every `getSettings()`, and from the pre-spawn check on the Dictation hot path.
- The benchmark is outside all of this: no settings, no availability healing, no fallback semantics. It reuses the ASR Harness command builder, not the plan. Outside the plan does not mean frozen - `benchmarks/stt/runner.ts` is fixed like any other module - but do not give it a Dictation Plan, a settings read or a fallback.

See `docs/adr/0005-no-runtime-fallbacks-for-dictation.md`.

### Formatting pipeline

Raw transcription can be reformatted before pasting (e.g. turning spoken words into a structured email):
- **llama.cpp backend**: runs Qwen2.5 3B (~2 GB) or Qwen3 4B (~2.5 GB) locally via `llama-completion`
- **Apple Intelligence backend**: macOS 26+ only, uses on-device Apple Intelligence

## Platform parity

macOS and Windows are kept at equal feature maturity. Build every feature for both platforms in the same change: native helper (Swift and Rust), vendor binary (pick the equivalent Windows release asset), settings, and key labels. "Windows part comes later" means the task is unfinished, not that it shipped.

Key labels follow the host platform: Windows shows Ctrl / Alt / Win / Shift, never ⌘ or ⌥. Pre-existing gaps (Fn shortcuts on Windows) are exceptions to close, not precedents to copy.

## Domain language

`CONTEXT.md` is the glossary for Codictate's domain terms (Dictation Shortcut, Speech Engine, ASR Harness, Formatting Mode, Vendor Binary, and so on). Use those terms in code and docs. Architectural decisions and their rejected alternatives live in `docs/adr/`.

## Frontend theme

Defined in `src/mainview/index.css`:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", ...  /* Body text: the host UI font */
--font-brand: "Iceberg", "Iceland", ...                          /* Branding / display only */
--color-codictate-page         /* Page background (black) */
--color-codictate-canvas       /* Canvas background */
--color-codictate-foreground   /* Text color (white) */
--color-codictate-paper        /* Semi-transparent surface */
```

Body text is the host platform's UI font at a **16px** base, so use ordinary sizes. The scale-everything-up rule that applied while Iceland was the body font is gone: Iceland and Iceberg survive only in `--font-brand`, for branding and display. Sizes chosen against the old 23px base will look oversized.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `EmilLykke/codictate`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Architecture review

`docs/ARCHITECTURE_REVIEW.md` (2026-08-17) records eight deepening opportunities, labelled A-H, with file:line evidence and a suggested order. Read it before proposing a refactor in the transcription path, the Dictation Shortcut Presets, `AppConfig`, or the benchmark - the friction is already mapped there.
