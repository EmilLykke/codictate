# The `codictate` command line is a thin client of the running app

ADR-0008 shipped a single command, File Transcription, as a standalone Bun script that read the settings and ran the Speech Engines in its own process, and it rejected IPC into the running app. That was the right call for one read-only question from one caller. It is the wrong one now: the command line is a public feature, for the user, their scripts and AI agents, not just Codiclens, and most of what it has to do is not read-only. It starts and stops a Dictation, which needs the microphone the app holds the permission for and the busy state the app owns. It downloads, removes and selects Speech Models and selects a Transcription Language, which are writes to state ADR-0008 already called a race when two processes make them. And Codictate's window gains its own File Transcription, which has to share one queue with the command line's.

The decision is that **every command goes through the running app**, over a local socket (a Unix domain socket on macOS, a named pipe on Windows), and the `codictate` executable is a thin client that parses arguments, launches the app hidden when it is not running, streams the answer and maps it to an exit code. This supersedes ADR-0008.

## Why one path, including the commands that could run without the app

`transcribe`, `status`, `models list` and `languages list` could stay standalone, as ADR-0008 built them. Splitting them off would mean two failure modes, two places that resolve a Dictation Plan, and a File Transcription the app's queue cannot see, so a command-line job could no longer be shown, cancelled or kept from competing with a Dictation. ADR-0008's three objections to IPC are each answered: the app is launched when it is not running, a socket returns the transcript to the caller synchronously, and the app schedules File Transcriptions so that a Dictation never waits on one.

## The client is Rust, one binary for both platforms

All the logic lives in the app, so the client is small: arguments, the socket, the output, the exit codes. It is one Rust executable for macOS and Windows.

- **Not TypeScript on the bundled Bun**, which ADR-0008 used. It would share the protocol types with the app for free, but it needs a launcher: a shell script on macOS, with the `bunfig.toml` preload hole ADR-0008 had to close by hand, and a `.cmd` shim on Windows, which prompts "Terminate batch job (Y/N)?" on Ctrl-C and mangles quoting. A public command on the user's PATH should be a real executable.
- **Not Swift on macOS and Rust on Windows.** Two clients of one contract drift.

The cost is that the protocol is written twice, in TypeScript in the app and in Rust in the client. `docs/CLI.md` is the contract both sides are tested against. The client and the app always ship in the same bundle, so they never disagree about the protocol version in practice; the version is still checked, and a mismatch is an error rather than a guess.

## Command-Line Control

Because the app holds the microphone permission, any local process that can run `codictate` could otherwise record the user. Starting a Dictation or changing what Codictate is doing from the command line requires **Command-Line Control**, a setting that is off until the user turns it on in Settings. When it is off, the command fails with its own exit code and Codictate shows a notification that opens the setting. There is no "Allow" button in that notification: a click-through prompt is what a malicious caller would want. File Transcription and reading state never touch the microphone and need no permission. The socket is private to the user who runs the app.

## Considered Options

- **Keep ADR-0008's standalone command and add IPC only for the new commands.** Rejected for the reasons above: two paths, and a queue that cannot see half its jobs.
- **A local HTTP server.** Rejected: any web page in the user's browser can reach `localhost`, and a socket file or named pipe restricted to the user cannot be.
- **A URL scheme.** Rejected: fire-and-forget, it cannot return a transcript.

## Consequences

- A command-line call launches Codictate when it is not running, and the app stays running as the normal tray app afterwards. The command line never opens a window, including during onboarding.
- File Transcription now works on Windows too, which needs a Media Foundation decoder in `CodictateWindowsHelper` alongside `CodictateMediaHelper` on macOS. ADR-0008's macOS-only exception is closed.
- ADR-0008's "the CLI never writes `main-config.json`" holds in a stronger form: only the app writes it, and the command line's writes go through `AppConfig` like a settings change from the window.
- File Transcription returns the same text from the command line as from the Transcribe page, because both are one queue: with hviske and Add punctuation on, that is the Raw Transcript after Punctuation Restoration, and its Timed Transcript is rebuilt on the punctuated words (falling back to unpunctuated text and timings together if the rebuild does not check out). `dictate --raw` is the exception that stays raw: it returns the Speech Engine's output before Punctuation Restoration, so scripts see exactly what the Speech Engine said.
- ADR-0008's "no timestamps" still holds, for the same reason. (Superseded by ADR-0010: `-nt` was losing speech past 30 s, and stock Whisper now decodes with timestamps.)
