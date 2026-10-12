---
status: superseded by ADR-0009
---

# Other apps transcribe through a `codictate` command that runs the app's own resolver on the app's own Bun

Codiclens wants a Transcribe action for audio and video files, and Danish is the case that matters: Apple's built-in transcriber has no Danish, while hviske beats every Whisper Speech Model on it. Codiclens should not know which Speech Model is good for what, so it asks Codictate, and Codictate answers with whatever the user selected. Codictate had no external interface at all (no URL scheme, no CLI, no server, no XPC). The decision is a **File Transcription** command line, shipped inside the app bundle at `Contents/Resources/app/bin/codictate`, with a written contract in `docs/TRANSCRIBE_CLI.md`.

## TypeScript on the bundled Bun, behind a shell launcher

The rule that matters most here is ADR-0005's: one resolver decides which Speech Model, Speech Engine, crispasr backend and Transcription Language run. That resolver, `buildDictationPlan`, and everything around it (the catalog, the Danish pin, the Speech Engine Adapters, the availability predicate) is TypeScript. So the command is TypeScript too, bundled by `scripts/post-build.ts` to `app/bun/codictate-cli.js`, and run by a four-line shell launcher on the Bun runtime Electrobun already ships at `Contents/MacOS/bun`.

The bundle sits beside the app's own `bun/index.js` on purpose. The binary lookup and the bundled Whisper weights resolve relative to `import.meta.dir`, so from that directory the CLI finds every Native Helper and every weight file exactly where the app does, with no second path rule to keep in sync.

The launcher passes `--config` (an empty `bunfig.toml` beside it), `--no-env-file` and `--no-install`. Without them Bun reads a `bunfig.toml` from the caller's working directory, and a `preload` entry there runs arbitrary code: measured, not assumed.

## What a File Transcription is, and is not

It builds a batch Dictation Plan from the persisted settings, through `persistedSpeechModelId` and `persistedTranscriptionLanguageId` (the readers `AppConfig` uses), with Translate to English and Live Transcription forced off and `--language` coerced for the Speech Model the way a settings write is. It runs the plan through `transcriptionRequestFromPlan` and `runTranscription`, the same path as a Batch Dictation, and prints the Raw Transcript. No Dictionary, no Formatting Mode, no brand table: those belong to a Dictation, and a transcript of a file is not one.

It reads and never writes. A selection whose weights are gone exits 4 and is not healed: healing is the app's job, at its next look, and a second writer to `main-config.json` from another process is a race with the app's own saves. This makes the CLI a second caller of `buildDictationPlan` next to `AppConfig.getDictationPlan()`; it is still the only resolver.

## Considered Options

- **A standalone `bun build --compile` executable.** One real Mach-O, no shell, and the obvious reading of "ship a binary". Rejected: it carries its own 61 MB copy of Bun next to the 62 MB one already in the bundle, built from whatever Bun the build host has rather than the one Electrobun pins, and inside it `import.meta.dir` is `/$bunfs/root`, so the binary lookup and the bundled-weights path would need a second rule.
- **A Swift CLI with its own model-to-engine mapping.** A small binary and natural AVFoundation access. Rejected: it duplicates the catalog, the hviske `cohere` pin and the Danish pin in a second language, which is the drift ADR-0005 removed.
- **A URL scheme or IPC into the running app.** Rejected: it needs the app running, cannot return a transcript synchronously to a caller, and couples a background transcription to the process that owns the user's Dictation.
- **Feeding the file straight to the engines.** crispasr reads WAV, MP3, FLAC and OGG on its own and needs ffmpeg for anything else; the Parakeet Native Helper reads no video container. A Native Helper, `CodictateMediaHelper`, decodes every input with AVFoundation to 16 kHz mono WAV instead, so both engines get the input shape a Dictation gives them and "is this file usable" has one answer.
- **Segment timestamps from crispasr.** Wanted for "jump to moment", and dropped from contract 1. whisper.cpp prints segment times only without `-nt`, and without `-nt` it decodes differently: Edda's transcript of a clean Danish sentence turned to noise. With `-nt` the reported segment starts are negative. A file must get the transcript a Dictation would get from the same Speech Model.

## Consequences

- **macOS only, against the platform parity rule in AGENTS.md.** Decided with the user: Codiclens is a macOS app and the first caller. A Windows command needs its own launcher (`bun.exe`), a Media Foundation decoder in the Rust helper, and a lookup story without bundle identifiers. `BINARY_MANIFEST` marks the Media Helper `null` on Windows and Linux so the gap is visible in code.
- **The Speech Engine Adapters take an optional `AbortSignal`.** A caller cancels by terminating the CLI, and without it the engine child would run to the end of a long file in the background, competing with the user's next Dictation. The Dictation path does not pass one.
- **The contract is versioned** (`contractVersion`, also in `--version`) and the bundle path is part of it. Moving `bin/codictate`, renaming a JSON field or renumbering an exit code is a breaking change for Codiclens.
- **A running Parakeet preparation is not coordinated.** The CLI cannot see the app's in-flight warmup, so a File Transcription during the app's first Parakeet compile is a second process loading the same weights. Rare (once per Mac), and recorded rather than solved.
