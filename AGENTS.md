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
| Speech-to-text | Whisper (including the Danish Edda), Danish hviske (both via the `crispasr` ASR Harness) and Parakeet (FluidAudio/FluidInference via CodictateParakeetHelper) |
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
| `bun run test` | Run the hermetic test suite |
| `bun run test:manual` | Run the two opt-in suites (network, Benchmark Run archive) |
| `bun run check:native:windows-helper` | Rust helper fmt / check / clippy / test (Windows host) |
| `bun run build:native:cli` | Build the `codictate` command-line client (Rust, host target) |
| `bun run check:native:cli` | Client fmt / clippy / test |

## Tests and CI

`bun run test` is `bun test` with no arguments: it discovers every `*.test.ts` in the repo. Those are hermetic tests - no process spawn, network, user state or webview - which is what lets them run on any platform. Durable filesystem adapters may use committed fixtures and isolated temporary directories; they must clean up the latter.

Two suites are deliberately outside that run and carry a `.manual.ts` suffix so `bun test` never discovers them:

| Suite | Why it is opt-in |
|-------|------------------|
| `src/bun/utils/whisper/model-download-reachability.manual.ts` | Live `fetch` against Hugging Face and the hviske Mirror. Flakes offline or behind a proxy, and it imports no Codictate download code. Run it after changing a download URL or the Speech Model list. |
| `benchmarks/stt/results-archive.manual.ts` | Pinned to the seven committed Benchmark Runs, including an exact `runCount` and the Sample Cursors derived from them. An eighth archived run turns it red with nothing broken. Run it when the archive or the results read path moves, and update the pinned numbers in the same change. |
| `src/bun/file-transcription/file-transcription.manual.ts` | End-to-end File Transcription on this Mac, through the real queue in-process: spawns `say`, the Media Helper and real Speech Engines, one per installed engine kind. Needs `bun run build:native`. Not in `test:manual`; run it directly after changing File Transcription or the Speech Engine Adapters. |
| `src/bun/utils/whisper/engines/long-audio.manual.ts` | The long-audio check (ADR-0010): real crispasr on every installed curated Whisper Speech Model, Edda and hviske, over 60 s to 5 min English and Danish built from `benchmarks/datasets`, with pauses and, in the 90 s continuous clips, without. Asserts no utterance lost, short clips within one word of the old `-nt` argv, no foreign-script noise in Danish, sane times, and Translate to English; on the `timestamps` path also that the VAD loses no words the same argv without it hears, and that no transcript repeats the dictation prompt (ADR-0011); on `nt-vad` also that no cut loses words an uncut decode of the same utterance hears (gated on the clips with pauses, reported on the continuous ones), that no transcript repeats the prompt, and that a Danish clip with pauses keeps at least 2 sentence ends per 100 words (sentence ends and commas per 100 words are printed for every clip). A private real dictation, `benchmarks/datasets/local/edda-dictation-da-65s.wav`, runs for every Danish-capable model when it exists and is skipped silently when it does not. `CODICTATE_LONG_AUDIO_SLICE_SECONDS`, `CODICTATE_LONG_AUDIO_NT_BEAM=0` and `CODICTATE_LONG_AUDIO_NT_PROMPT=0` measure `nt-vad` at another cap, greedy, or without the prompt. Slow (minutes per Speech Model). Extra weights directories go in `CODICTATE_LONG_AUDIO_MODEL_DIRS`, and `CODICTATE_LONG_AUDIO_MODELS` picks the run, which may name any Whisper Speech Model, curated or not. Not in `test:manual`; run it before giving a Speech Model `whisperDecoding: 'timestamps'`, and after changing the crispasr argv or version. |
| `src/bun/command-line/client-server.manual.ts` | The real `codictate` client against the real app side (server, session, handlers, File Transcription queue, model operations) over fake engines and a fake recording module, every command, asserted against docs/CLI.md. Spawns the client and signals it, macOS only. Needs `bun run build:native:cli`. Not in `test:manual`; run it directly after changing the client, the app side or docs/CLI.md. |

Run both with `bun run test:manual`, or one with `bun test ./benchmarks/stt/results-archive.manual.ts`. The leading `./` is required: without it `bun test` reads the argument as a name filter, matches nothing, and runs nothing.

`.github/workflows/ci.yml` runs `test`, `lint` and `tsc` on every push to `main` and every pull request, and runs `check:native:windows-helper` (which includes `cargo test` for the Rust matchers) on a Windows runner. The opt-in suites are not in CI by design.

New tests go in a `*.test.ts` beside the module they cover. Default tests must be hermetic: pure functions are preferred; durable filesystem adapters may read committed fixtures and use isolated temporary fixtures that are removed after the suite. They may not spawn processes, access the network or webview, read user state, or mutate repository state.

## Project structure

```
src/
  bun/                          # Main process (Bun + Electrobun)
    index.ts                    # Entry point
    AppConfig/                  # Persistent app configuration
    command-line/               # The app side of the `codictate` command line: socket server, handlers (docs/CLI.md)
    command-line-install.ts     # Settings > Command Line: put `codictate` on PATH
    dictation/                  # The Batch Dictation pipeline (transcript -> Dictation Outcome), command-line Dictations
    file-transcription/         # The File Transcription queue, shared by the command line and the window
    window-file-transcriptions/ # The Transcribe page's side of the queue: file dialog, drop, results, History, Transcript Export
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
  CodictateMediaHelper/         # macOS: AVFoundation audio/video decode for File Transcription + the Save dialog (NSSavePanel)
  CodictateWindowsHelper/       # Windows: keyboard hook + mic + indicator + Media Foundation decode + the Save dialog (Rust)
  codictate-cli/                # macOS + Windows: the `codictate` command-line client (Rust)

scripts/
  pre-build.ts                  # Downloads vendor binaries + Whisper model
  post-build.ts                 # App bundle patching + codesign
  vendor-manifest.ts            # Pinned vendor releases + the file lists shipped from them
  mirror-hviske.ts              # Maintainer-run: mirror the hviske GGUF weights
  mirror-edda.ts                # Maintainer-run: convert and mirror the Edda GGML weights
  release.sh                    # Version bump + tag push

entitlements/                   # Per-helper macOS entitlements plists (codesigning)

docs/
  INSTALL.md                    # User install guide
  FORMATTING.md                 # Formatting feature docs
  RELEASING.md                  # Maintainer release guide
  RECORDING_INDICATOR.md        # Recording HUD architecture
  MACOS_SIGNING_AND_NOTARIZATION.md
  HVISKE_MIRROR.md              # The published Danish hviske Mirror
  EDDA_MIRROR.md                # The Danish Edda Mirror (Codictate's own GGML conversion)
  AEROSPACE.md                  # AeroSpace window rule
  CLI.md                        # Contract of the `codictate` command line: commands, JSON, exit codes, wire protocol
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
- **Edda**: Danish only, `danish-foundation-models/edda-v0.2` (a large-v3-turbo fine-tune) converted to GGML by `scripts/mirror-edda.ts` and served from a Mirror. It is a Whisper Speech Model (`engine: 'whisper_cpp'`) on the default crispasr backend, not its own engine; what differs is the Mirror URL (`huggingFaceRepoId`), a sha256 checked on download, and the Danish pin, which `pinnedTranscriptionLanguageId` applies to hviske and Edda alike. Three Quantizations (f16, q8_0, q5_0) live in the browse modal, none curated. See `docs/EDDA_MIRROR.md`.
- **Parakeet**: runs via `CodictateParakeetHelper` on macOS and Windows; Linux has no helper yet (`getPlatformCapabilities().supportsStreamMode` in `src/bun/platform/runtime.ts` is the live answer). The engine ID in code is `whisperkit` but the actual engine is **FluidAudio** (FluidInference), not WhisperKit; compare against the exported `PARAKEET_ENGINE_ID` rather than re-typing the literal.
- **hviske**: Danish only, the mirrored `syvai/hviske-v5-tiny` GGUF weights. Runs on the same `crispasr` binary with `--backend cohere`, which is the only runtime that can read those weights. Ungated: no env var, no source-checkout requirement. All five Quantizations live in the browse modal ("Browse more models" in Settings) and none is curated, because a Danish-only model does not belong in the main list. Danish WER is measured now: the Benchmark Run `2026-08-18_08-17-28_hviske-vs-main-models` puts all five between 11.29 and 11.67 WER on FLEURS `da_dk`, which confirms syvai's identical-WER claim and beats every Whisper Speech Model ever measured on Danish, including Large V3 at 2.9 GB (12.67). `q5_0` is the recommended one in documentation, with `q4_k` for the smallest download; the old `f16` recommendation existed only to hedge the unverified claim and that reason is gone. Built for both platforms. The `cohere` backend is confirmed present in the shipped Windows binary (verified in the pinned `crispasr-windows-x86_64-vulkan.zip`, first for v0.8.29 and again for v0.8.41: `--backend` help lists `cohere`, and `CohereBackend` / `cohere_transcribe_ex` / `llm_build_cohere2_iswa` symbols are in `crispasr.exe` and `crispasr.dll`). What is still unverified is narrower: **no hviske Dictation has been run on Windows hardware**, so the end-to-end GGUF load, Vulkan device selection and output quality are unobserved. Do not upgrade that to a Windows support claim until someone runs it. See `docs/adr/0004-hviske-danish-ungated.md` and `docs/HVISKE_MIRROR.md`.

### Dictation resolution - no runtime fallbacks

A Dictation never adapts to an unrunnable state; the state is kept runnable instead. Do not add a fallback when a Speech Model, a Speech Engine capability or a Native Helper is unavailable - refuse the settings write, heal the config when availability changes, and do not offer the option in the UI.

- **One resolver.** `buildDictationPlan` in `src/shared/dictation-plan.ts` turns `(settings, availability snapshot)` into a **Dictation Plan** - a pure value, no `modelManager` and no `getPlatform`. Batch Dictation and Live Transcription are one union, discriminated by `mode`. `AppConfig.getDictationPlan()` is the caller for the Dictation Shortcut, once per press; `AppConfig.getDictationPlanFor()` is the same resolver with per-call overrides (Speech Model, Transcription Language, force Batch) for a command-line Dictation, and never writes settings; File Transcription resolves through it too (see below). The transcription path consumes the plan whole: `runDictation`, `startRecording` and `startParakeetStream` all take it and re-derive nothing. Never decide which Speech Model, Speech Engine, Transcription Language or crispasr backend runs anywhere else.
- **Runnable or blocked, nothing in between.** A blocked plan carries a reason from a closed union (`DictationBlockedReason`, eight members, each with a message in an exhaustive `Record` so a new failure mode cannot compile without one), starts no Dictation, and reaches four surfaces: an error chime, a tray error state, and the reason itself as a native notification when the main window is closed or an in-window banner when it is open. It also triggers the heal pass, so the next press works. There is no substitution and no silent drop. `assertParakeetStreamRuntimeReady` survives as the pre-spawn race check inside `startParakeetStream`, which now returns `{ status: 'blocked', plan }` instead of throwing an `Error` its caller discarded.
- **Enforced in three places.** `src/shared/settings-heal.ts` owns all three, as pure functions over `(settings, availability snapshot)`: `applyRunnableDictationPatch` validates the object a settings write would produce (a patch can be valid and its result invalid) and refuses a patch that asks for something unrunnable; `healDictationSettings` corrects the configuration on every availability change and at boot, because refusing to delete weights that happen to be selected is arguing with the user. `AppConfig` is the adapter: `updateTranscriptionSettings` for writes, `healRunnableSettings()` for `load()`, for a Speech Model download or delete, and for a blocked plan. The heal pass announces changes to the Speech Model selection, Translate to English and Live Transcription in `AppSettings.healAnnouncements`, and corrects everything else in silence.
- **Stats record what ran.** `engineId` and `languageId` come from the plan, not from live config read after the run - the user can change either mid-transcription.
- **Readiness is computed in the main process** and shipped in the settings payload. `getDictationReadiness(settings, availability)` in `dictation-plan.ts` answers "can Translate to English / Live Transcription run right now" as plain serialisable data - a closed reason union plus the finished sentence to show - and `AppConfig.getSettings()` puts it in `AppSettings.dictationReadiness`. The heal pass asks the same function, so the UI and the correction cannot disagree. The webview renders it and derives nothing from raw availability. Parakeet warmup is not a readiness *reason* - a cold Parakeet is slow on its first run, not unavailable - but `DictationReadiness.parakeetPreparing` ships the plain fact that a preparation is under way, so Settings states it without reaching for `modelAvailability` itself.
- **Parakeet prepares itself on selection.** `src/bun/utils/whisper/parakeet-warmup.ts` is the only place that decides when Parakeet's one-time on-device compile runs. The trigger is `AppConfig.observeRunnableDictationSettings`, which fires on every settle of the `(settings, availability)` pair, so selecting Parakeet from Settings, the tray or the app menu all start it, and so does a finished download of weights that are already selected. One preparation at a time, held in a single in-flight promise; a Dictation that lands inside that window waits on the promise rather than spawning a second helper against half-compiled weights. Do not add a fourth caller - reach it through the observer with `ensureParakeetWarm()`, and call `awaitParakeetWarmup()` before any new Parakeet spawn.
- **The selection is `speechModelId`.** One name for it in `AppSettings`, in `TranscriptionSettingsPatch`, on `AppConfig` and in `main-config.json`. `whisperModelId` is gone except as a legacy key `persistedSpeechModelId` still reads from, because the field never held a whisper-only id - hviske and Parakeet selections live there too, and the Speech Engine comes from the catalog entry.
- **Availability is a question, not a write.** `modelManager.isModelAvailable` stats the disk and changes nothing. The Parakeet legacy-folder migration and the stale Core ML cleanup live in `modelManager.reconcileInstalls()`, called at boot before the first availability read and again when a download finishes. Do not put a write back into the predicate: it is asked 2-4 times per Dictation Plan build, once per model inside every `getSettings()`, and from the pre-spawn check on the Dictation hot path.
- The benchmark is outside all of this: no settings, no availability healing, no fallback semantics. It reuses the ASR Harness command builder, not the plan. Outside the plan does not mean frozen - `benchmarks/stt/runner.ts` is fixed like any other module - but do not give it a Dictation Plan, a settings read or a fallback.

See `docs/adr/0005-no-runtime-fallbacks-for-dictation.md`.

### Command line (`codictate`)

A public command line for users, scripts, AI agents and other apps (Codiclens first): File Transcription, Dictation, status, Speech Models and Transcription Languages. The contract (commands, JSON events, exit codes, wire protocol, where the client lives) is `docs/CLI.md`; changing any of it is a breaking change for callers outside this repo. Why it is built this way: `docs/adr/0009-command-line-talks-to-the-running-app.md` (supersedes ADR-0008).

- **Thin client, everything in the app.** `native/codictate-cli` is one Rust executable for macOS and Windows, bundled at `Resources/app/bin/codictate(.exe)` by `electrobun.config.ts` and signed by `scripts/post-build.ts`. It parses arguments, starts the app hidden when it is not running, talks to it over a Unix socket (macOS) or named pipe (Windows) and maps the answer to an exit code. It holds no Codictate logic: never give it a model table or a settings read.
- **The app side** is `src/bun/command-line/`: transport, one session per connection (exactly one `result` or `error`, a disconnect is a cancel), handlers with injected deps. Protocol types live in `src/shared/command-line-protocol.ts`, checked against the JSON examples in docs/CLI.md. Starting the socket server is also the single-instance claim (`single-instance.ts`: a `flock`ed `run/<identifier>.lock` on Unix, the pipe name on Windows); a second instance never runs past it, and a fresh `run/<identifier>.hidden-launch` marker boots the app without its window.
- **Command-Line Control** (Settings > Command Line, off by default) gates every command that records the microphone or changes state. File Transcription and reads are never gated.
- **File Transcription is one queue** (`src/bun/file-transcription/`), shared by the command line and the Transcribe page: one job at a time, decode and engine at lowered OS priority so a Dictation never waits, cancellable. Raw Transcript only: no Dictionary, Formatting Mode or brand table. Only window jobs are kept in History. Decoding is `CodictateMediaHelper` on macOS and `CodictateWindowsHelper extract-audio` on Windows, same argv and exit codes.
- **Transcript Export uses the system Save dialog.** Electrobun 1.18 has none, so it is the same media Native Helper's `save-dialog` subcommand (NSSavePanel on macOS, IFileSaveDialog on Windows; same argv and one JSON line, documented at the top of `native/CodictateMediaHelper/main.swift`). The dialog asks before replacing a file, so Codictate writes to the chosen path as it is. It is started by an RPC message, never awaited inside a request (#156).
- **A command-line Dictation is a Dictation.** It goes through the same recording path as the Dictation Shortcut (sounds, indicator, History, Stats); the outcome goes back to the command line unless it asked to paste. Printing forces a Batch Dictation, since a Live Transcription produces no outcome.
- **Timestamps, not `-nt`.** On the whisper backend `-nt` decodes in fixed 30 s windows and loses speech, so stock Whisper Speech Models run without it and Codictate reads the plain transcript and the Timed Transcript from the JSON file crispasr writes (`--no-prints -ojf -of <per-run temp dir>/transcript`, read from `transcript.json`), never from stdout: `-of -` does not reach a pipe on Windows or on the `--backend` paths. Never strip text out of printed output. Edda keeps `-nt` (it turns to noise without it), and so does any Whisper model that has not passed the long-audio check (large-v1, large-v2, large-v3, and the multilingual tiny and base, all listed in ADR-0010): that is the `nt-vad` path, and every Speech Model without `whisperDecoding` starts on it, so a new one is safe with no per-model work. With `-nt`, whisper.cpp skips the rest of a 30 s window after an early end-of-text, so Codictate cuts the recording itself (`src/bun/utils/whisper/engines/vad-slices.ts`: loudness scan, slices of 30 s or less ending at the longest pause, a pause over 1.5 s always ends a slice, 0.2 s padding, no overlap) and runs `--backend whisper -nt --vad-import <per-run dir>/slices.json -sns -bs 5` plus the same dictation `--prompt` as the timestamps path (below), with no `--vad`/`-vm`. A Speech Model whose long-audio check fails with the prompt opts out with `ntVadPrompt: false` in `speech-models.ts`. Speech Models are decoded the way their own card documents: for Edda that is no timestamps, 30 s windows, 5 beams and a prompt. Do not give that path a slice over 30 s (one Whisper window), and do not drop `-bs 5` (greedy loses an Edda utterance) or the prompt (without it Edda wrote no full stop in a 65 s dictation). Known and accepted: a cut inside a sentence, which only happens when the sentence gaps are under 98 ms, can drop a few words at the slice edge. See `docs/adr/0010-whisper-decodes-with-timestamps.md`. On trial: the timestamps path also passes `--vad -vm -vt 0.25` with the bundled Silero VAD weights (`vendors/silero-vad/`, binary id `silero-vad`; whisper.cpp's own VAD, no `--backend`; at 0.35 and above it clipped first words and dropped quiet speech, and the long-audio check now fails a model whose VAD loses words), `-bs 5` and a punctuated `--prompt` chosen by Transcription Language (Danish, English for `en`/auto/translate, none otherwise), because Whisper otherwise ends a sentence at every pause. With the VAD the token times are wrong (whisper.cpp #4046), so that path's Timed Transcript has segment times and no words. See `docs/adr/0011-whisper-decodes-with-vad-beam-and-prompt.md`.

### Formatting pipeline

Raw transcription can be reformatted before pasting (e.g. turning spoken words into a structured email):
- **llama.cpp backend**: runs Qwen2.5 3B (~2 GB) or Qwen3 4B (~2.5 GB) locally via `llama-completion`
- **Apple Intelligence backend**: macOS 26+ only, uses on-device Apple Intelligence

## Platform parity

macOS and Windows are kept at equal feature maturity. Build every feature for both platforms in the same change: native helper (Swift and Rust), vendor binary (pick the equivalent Windows release asset), settings, and key labels. "Windows part comes later" means the task is unfinished, not that it shipped.

Key labels follow the host platform: Windows shows Ctrl / Alt / Win / Shift, never ⌘ or ⌥. Pre-existing gaps (Fn shortcuts on Windows) are exceptions to close, not precedents to copy.

## Domain language

`GLOSSARY.md` is the glossary for Codictate's domain terms (Dictation Shortcut, Speech Engine, ASR Harness, Formatting Mode, Vendor Binary, and so on). Use those terms in code and docs. Architectural decisions and their rejected alternatives live in `docs/adr/`.

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

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
