# The `codictate` command line

The contract of Codictate's command line: the commands, their output, their exit codes, and the wire protocol between the `codictate` client and the running app. Both sides are tested against this document. Why it is built this way: `docs/adr/0009-command-line-talks-to-the-running-app.md`.

**Contract version: 1.** Renaming a command, flag, JSON field, error code or exit code, moving the client, or changing the wire protocol is a breaking change and bumps the version.

## Where the client lives

The client is a single Rust executable shipped inside the app, never a separate download.

| Platform | Path |
|---|---|
| macOS | `<App>.app/Contents/Resources/app/bin/codictate` |
| Windows | `<install>\Resources\app\bin\codictate.exe` |

`<install>` is `%LOCALAPPDATA%\app.codictate\stable\app` for stable (`app.codictate.canary\canary\app` for canary).

The client belongs to the app it ships in. It reads that app's `Resources/version.json` (`version`, `channel`, `identifier`) and only ever talks to that app, so stable, canary and dev never answer for each other.

- **On PATH, macOS:** Settings → Command Line → "Install command" symlinks `~/.local/bin/codictate` to the client. The client resolves symlinks to find its app.
- **On PATH, Windows:** the installer adds `<install>\Resources\app\bin` to the user's `Path`.
- **From another app:** find Codictate by bundle identifier (`app.codictate`, then `app.codictate.canary`) and run the client at the path above. GUI apps do not inherit the shell's PATH, so do not rely on it.

## The app is started when it is not running

Every command except `--help` and `--version` goes through the running app. When the app is not running, the client starts it **hidden** (no window, even during onboarding), waits up to 30 s for it to answer, and carries on. The app keeps running as the normal tray app afterwards. If it cannot be started or does not answer, the command exits `6`.

## Commands

```
codictate transcribe <file>... [--model <id>] [--language <id|auto>] [--translate | --no-translate]
                     [--format txt|srt|vtt|json] [-o <path>] [--json]
codictate dictate [--paste] [--raw] [--until enter|silence] [--max <seconds>]
                  [--model <id>] [--language <id|auto>] [--formatting-mode <id>] [--json]
codictate stop [--json]
codictate status [--json]
codictate models list [--all] [--json]
codictate models use <id> [--json]
codictate models download <id> [--json]
codictate models remove <id> [--json]
codictate languages list [--json]
codictate languages use <id|auto> [--json]
codictate --version
codictate --help | codictate <command> --help
```

### Which commands need Command-Line Control

A command that records the microphone or changes what Codictate is doing needs **Command-Line Control** turned on in Settings → Command Line. It is off until the user turns it on. When it is off, the command exits `7` and Codictate shows a notification naming the setting.

| Needs Command-Line Control | Never needs it |
|---|---|
| `dictate`, `stop`, `models use`, `models download`, `models remove`, `languages use` | `transcribe`, `status`, `models list`, `languages list`, `--help`, `--version` |

### `transcribe` - File Transcription

Transcribes audio or video files with the Speech Model and Transcription Language from the File Transcription Settings (the ones set for File Transcriptions on Codictate's Transcribe page, the same ones a File Transcription started in the window uses), unless `--model` or `--language` overrides them. Translate to English is off unless `--translate` asks for it. Returns the Raw Transcript: no Dictionary, no Formatting Mode, nothing pasted. With hviske and Add punctuation on, the Raw Transcript comes back punctuated, exactly as on the Transcribe page, and so do its captions. Any format the platform can decode is accepted (AVFoundation on macOS, Media Foundation on Windows).

- `--model <id>` uses that Speech Model for this call only. It must be installed (exit `4` otherwise); nothing is downloaded implicitly. Settings do not change.
- With hviske and Add punctuation on, Danish punctuation needs its punctuation model installed; if it is gone, the call exits `4` with `model_not_installed` rather than return unpunctuated text.
- `--language <id|auto>` overrides the Transcription Language for this call only. It is coerced for the Speech Model exactly as a settings change would be (Parakeet is always `auto`; hviske and Edda are always `da`).
- `models use` and `languages use` change the Dictation's Speech Model and Transcription Language, not the File Transcription Settings.
- Several files run one after another. Each is its own File Transcription. A failure does not stop the rest (its error names the file as typed: `codictate: a.m4a: ...`); the exit code is the first failure's. Only an unreachable app or a contract mismatch stops the remaining files.
- File Transcriptions run one at a time, shared with those started in Codictate's window, so a call may wait in a queue. A Dictation never waits for one.
- Results from the command line are not kept in History.
- An empty transcript (silence) is success with empty text.

**Translate.** Without a flag, nothing is translated. `--translate` translates this call to English. `--no-translate` is the default spelled out, kept for compatibility. The two flags together are a usage error. The File Transcription Settings' Translate to English choice applies only in Codictate's window, never to the command line, and neither flag changes the settings. The result says whether the text was translated (`"translated"`). English-only and Turbo Whisper Speech Models cannot translate, and neither can Parakeet, hviske or Edda. Translating also needs a source language: a Transcription Language other than `auto`, unless one is set for translation in Codictate. Otherwise the call exits `2` with `cannot_translate`, and nothing is transcribed.

**Captions and JSON.** `--format` renders the result as a Transcript Export, the same document Save writes in Codictate's window:

- `txt`: the transcript and a newline, as without `--format`.
- `srt`, `vtt`: a Caption File. It needs a Timed Transcript, which not every Speech Model makes (Edda does not). With one that never does, the call exits `2` with `captions_unavailable` before anything is transcribed; if a run gives no usable timings, it ends with the same error.
- `json`: the transcript and what it was made with (file name, Speech Model, language, translated, audio length, Processing Time), plus the caption cues under `segments` when there is a Timed Transcript.

The document is printed instead of the transcript, and under `--json` it is in the result's `formatted` field.

**`-o, --output <path>`** writes the transcript (or the `--format` document) to that file, replacing it if it exists, and prints nothing on success. It takes one input file; with several it is a usage error. A path relative to the working directory is fine, since the client writes the file. If it cannot be written, the client prints `codictate: <path>: cannot write: <reason>` and exits `1` (`output_unwritable`); under `--json` the result line comes first, then that error.

Human output: the transcript on stdout, followed by a newline. With several files, each transcript is preceded by a `==> <file> <==` line, as `tail` does; a file that fails gets no header, only its error on stderr.

### `dictate` - a Dictation from the command line

Records from the microphone, with the recording indicator shown exactly as for the Dictation Shortcut, and runs a full Dictation: Punctuation Restoration (hviske with Add punctuation on), the Dictionary and the Formatting Mode are applied, and it is kept in History and Stats like any Dictation.

- Without `--paste`, the text is printed and nothing is pasted. A Live Transcription produces no text to print, so a Dictation that prints always runs as a Batch Dictation, whatever the Live Transcription setting.
- With `--paste`, the text is placed at the cursor as the Dictation Shortcut would place it, and the Live Transcription setting is honoured, unless `--model` names a Speech Model that cannot do Live Transcription: then that one Dictation is a Batch Dictation. When the Dictation is a Live Transcription, there is no text in the result (`"text":""`, `"live":true`), and `--until silence` is refused with exit `2`.
- `--raw` returns the Speech Engine's output as it is: no Punctuation Restoration, no Dictionary, no Formatting Mode. `rawText` in the result is always that output.
- `--formatting-mode <id>` uses that Formatting Mode for this Dictation instead of the one Codictate would pick.
- `--model`, `--language`: as for `transcribe`.
- **Ending it.** By default (`--until enter`) the Dictation ends on Enter or on the first Ctrl-C (SIGINT), and is then transcribed. A second Ctrl-C, or SIGTERM, cancels it (exit `130` / `143`) and nothing is transcribed. `--until silence` also ends it after a pause in speech. `--max <seconds>` ends it after that long; Codictate's own maximum recording duration always applies. `codictate stop` from another process ends it too. When stdin is not a terminal, Enter is not read.
- Only one Dictation runs at a time. If one is already running, from the Dictation Shortcut or the command line, `dictate` exits `8`.
- Needs microphone permission and finished onboarding; otherwise it exits `9`.

Human output: the text on stdout, followed by a newline. Nothing with `--paste`.

### `stop`

Ends whichever Dictation is running, from the Dictation Shortcut or the command line. Its text goes to whoever started it. Succeeds with `"stopped": false` when no Dictation is running. Human output: `Stopped the Dictation.` or `No Dictation was running.`

### `status`

What Codictate is doing and how it is set up. Human output is `key: value` lines: `app`, `contract`, `onboarding`, `microphone`, `command-line control`, `dictation`, `speech model`, `transcription language`, `file transcriptions`.

### `models`

- `models list` shows the curated Speech Models plus any installed one; `--all` shows every Speech Model.
- `models use <id>` selects a Speech Model, exactly as Settings does. It must be installed (exit `4`).
- `models download <id>` downloads one and streams progress. It does not select it.
- `models remove <id>` removes the weights. Codictate corrects its selection when the removed Speech Model was the selected one, as it does when weights are removed from Settings. A bundled Speech Model cannot be removed (exit `2`).

Human output: `list` is a table with the selected row marked `*`; `use`, `download` and `remove` print `Selected <id>`, `Downloaded <id>`, `Removed <id>`.

### `languages`

- `languages list` shows every Transcription Language and whether the selected Speech Model allows it.
- `languages use <id|auto>` selects one. It is refused with exit `2` when the selected Speech Model does not allow it.

## Output

- **Human (default).** The result on stdout, in the form each command above describes. Progress (queue position, elapsed time, download percentage) goes to stderr, and only when stderr is a terminal.
- **`--json`.** Every event the app sends is printed verbatim to stdout, one JSON object per line (NDJSON). The last line is always a `result` or an `error`. A command without progress prints exactly one line. A `transcribe` of several files prints each file's events in turn, with one `result` or `error` per file.
- **Errors** always go to stderr as one line starting `codictate: `. With `--json` the `error` event is on stdout too. A usage error the client finds itself (bad arguments) adds `(see 'codictate --help')` and, with `--json`, prints a `usage` error event; a `usage` error from the app (for example `dictate --raw --formatting-mode email`) is printed as the app sent it.
- If the app closes the connection without a `result` or `error`, the client exits `6`; with `--json` it prints its own `app_unavailable` error event, so the last line is always a `result` or an `error`.
- **Cancelling.** After sending `cancel`, the client waits up to 2 s for the app's final event; a second signal exits at once. On Windows, Ctrl-Break and closing the console count as SIGTERM.
- `--version` prints `codictate <version> (<identifier>, contract 1)` from the app's `version.json`, without contacting the app; outside an app bundle it prints `codictate <version> (no app, contract 1)`.

### Events

Every event has a `type`. Consumers must ignore event types and fields they do not know.

```jsonc
{"type":"queued","position":2}                                          // transcribe: waiting behind other File Transcriptions
{"type":"progress","stage":"decoding","elapsedSeconds":0.4,"audioSeconds":null}
{"type":"progress","stage":"transcribing","elapsedSeconds":12.0,"audioSeconds":3121.5}  // about once a second
{"type":"recording"}                                                    // dictate: the microphone is open
{"type":"transcribing"}                                                 // dictate: recording ended
{"type":"download","fraction":0.42}                                     // models download, at most ~4 a second
{"type":"result", ...}                                                  // per command, below
{"type":"error","code":"model_not_installed","message":"Speech Model large-v3-q5_0 is not installed"}
```

### Results

```jsonc
// transcribe (one per file)
{"type":"result","file":"/abs/path/memo.m4a","text":"…","language":"da","speechModelId":"hviske-v5-tiny-q5_0",
 "engine":"hviske","audioSeconds":61.2,"processingSeconds":4.8,"translated":false}

// transcribe --format srt: the same, plus the rendered document
{"type":"result","file":"/abs/path/memo.m4a","text":"Hej.","language":"da","speechModelId":"hviske-v5-tiny-q5_0",
 "engine":"hviske","audioSeconds":61.2,"processingSeconds":4.8,"translated":false,
 "formatted":"1\n00:00:00,000 --> 00:00:01,200\nHej.\n\n"}

// dictate
{"type":"result","text":"…","rawText":"…","formattingMode":"email","pasted":false,"live":false,
 "language":null,"speechModelId":"parakeet-tdt-0.6b-v3","engine":"parakeet","audioSeconds":8.4}

// stop
{"type":"result","stopped":true}

// status
{"type":"result","contractVersion":1,
 "app":{"version":"0.0.62","channel":"stable","identifier":"app.codictate"},
 "onboardingCompleted":true,"microphone":"granted","commandLineControl":false,
 "dictation":{"active":false,"startedBy":null},
 "speechModel":{"id":"large-v3-turbo-q5_0","label":"Large V3 Turbo","engine":"whisper","installed":true},
 "transcriptionLanguage":{"id":"auto","label":"Auto-detect"},
 "fileTranscriptions":{"running":0,"queued":0}}

// models list
{"type":"result","models":[{"id":"large-v3-turbo-q5_0","label":"Large V3 Turbo","engine":"whisper",
  "downloadSizeMB":574,"installed":true,"selected":true,"curated":true,"bundled":true}]}

// models use / download / remove
{"type":"result","speechModelId":"parakeet-tdt-0.6b-v3"}

// languages list
{"type":"result","languages":[{"id":"auto","label":"Auto-detect","selected":true,"allowed":true}]}

// languages use
{"type":"result","transcriptionLanguageId":"da"}
```

- `language` is the Transcription Language the run was fixed to, or `null` when the Speech Engine detected it.
- `engine` is `whisper`, `parakeet` or `hviske`.
- `audioSeconds` is the length of the audio, not of the run.
- `processingSeconds` is the Processing Time, rounded to 0.1 s: from when Codictate began reading the file to when the transcript was ready. Time spent waiting behind other File Transcriptions does not count.
- `translated` is whether `text` is Translate to English output. With it, `language` is the language that was translated from.
- `formatted` is present only when `--format` was given.
- `microphone` is `granted`, `denied`, `undetermined` or `unknown`.
- `dictation.startedBy` is `shortcut`, `command-line` or `null`.

## Errors and exit codes

| Exit | `error.code` | Meaning |
|---|---|---|
| 0 | | Success |
| 1 | `internal` | Something in Codictate failed |
| 1 | `output_unwritable` | The `-o` file could not be written (client only) |
| 2 | `usage`, `unknown_model`, `unknown_language`, `language_not_allowed`, `unknown_formatting_mode`, `model_bundled` | The command was wrong |
| 2 | `cannot_translate` | Translate to English cannot run with this Speech Model or Transcription Language |
| 2 | `captions_unavailable` | Captions were asked for, and there is no Timed Transcript to make them from |
| 3 | `input_unreadable`, `no_audio` | The file cannot be read, or has no audio track |
| 4 | `model_not_installed` | The Speech Model's weights are not installed, or Add punctuation is on and its punctuation model is not |
| 5 | `engine_failed` | The Speech Engine failed |
| 6 | `app_unavailable` | Codictate could not be started or did not answer (client only) |
| 7 | `command_line_control_off` | The command needs Command-Line Control |
| 8 | `busy` | A Dictation is already running |
| 9 | `not_ready` | Microphone permission or onboarding is missing |
| 10 | `download_failed` | A Speech Model download failed |
| 11 | `contract_mismatch` | The client and the app disagree on the contract version |
| 130 / 143 | `cancelled` | Cancelled by SIGINT / SIGTERM |

## Wire protocol

Between the client and the app. Callers use the command line, never the socket: the socket is an implementation detail of the client, documented so both sides can be tested against it.

**Transport.** One connection per command.

- macOS: a Unix domain socket at `~/Library/Application Support/codictate/run/<identifier>.sock`, in a directory only the user can read (`0700`). A Unix socket path is limited to 103 bytes; when that path is longer (a very long user name), both sides use `/tmp/codictate-<uid>/<identifier>.sock` instead, where `<uid>` is the numeric user id. Both sides refuse that directory unless it is owned by the user and has mode `0700`.
- Windows: a named pipe, `\\.\pipe\<identifier>.<username>`.

The app creates it at startup, and only one app per user and identifier may: on macOS the app first takes an exclusive lock on `<data>/run/<identifier>.lock` and holds it while it runs, and only the lock holder removes a socket file a crashed app left behind; on Windows the pipe name itself is the lock. A second instance that finds the lock or the endpoint taken asks the first to show its window (`app.show`) and quits, even when the first does not answer yet.

**Framing.** UTF-8 NDJSON in both directions: one JSON object per line, `\n` terminated.

**Request.** The client's first line:

```json
{"contractVersion":1,"command":"transcribe","args":{"file":"/abs/path/memo.m4a","speechModelId":null,"languageId":null,"translate":null,"format":null},"caller":{"name":"Terminal","pid":4211}}
```

`caller` is the client's parent process, self-reported. It is shown to the user (for example in the File Transcription queue) and never used to grant anything.

| `command` | `args` |
|---|---|
| `transcribe` | `{file, speechModelId?, languageId?, translate?: true\|false, format?: "txt"\|"srt"\|"vtt"\|"json"}`: one file; the client loops over several. `translate` absent, `null` or `false` means no translation; only `true` translates |
| `dictate` | `{output: "stdout"\|"cursor", raw, until: "enter"\|"silence", maxSeconds?, speechModelId?, languageId?, formattingModeId?}` |
| `stop` | `{}` |
| `status` | `{}` |
| `models.list` | `{all}` |
| `models.use` / `models.download` / `models.remove` | `{id}` |
| `languages.list` | `{}` |
| `languages.use` | `{id}` |
| `app.show` | `{}`: internal, used by a second app instance; not a command-line command |

The client resolves relative file paths to absolute ones before sending them. Unset optional `args` are sent as `null`, and the app reads an absent one as `null` too, so a client that predates `translate` and `format` still works; `maxSeconds` is a number of seconds and may be fractional. `caller.name` is `"unknown"` when the parent process cannot be read, and a Windows name drops its `.exe`.

**Development overrides** (client only, not in `--help`): `CODICTATE_APP_BUNDLE` points the client at an app bundle or install directory instead of the one it ships in; `CODICTATE_DATA_DIR` moves the socket and the hidden-launch marker, for tests.

**Control lines** from the client after the request:

- `{"type":"stop"}`: `dictate` only. End the recording and transcribe it.
- `{"type":"cancel"}`: abandon the command. Nothing is transcribed, pasted or saved.

Closing the connection before the `result` is a cancel.

**Responses.** The app sends the events above, ending with exactly one `result` or `error`, then closes the connection.

**Version check.** If `contractVersion` in the request is not the app's, the app answers `{"type":"error","code":"contract_mismatch",...}` and closes.

**Hidden launch.** Before starting the app, the client writes the current time in milliseconds to `<data>/run/<identifier>.hidden-launch`, where `<data>` is `~/Library/Application Support/codictate` on macOS and `%LOCALAPPDATA%\codictate` on Windows. An app that finds that file less than 60 s old at startup does not open its window, and removes the file 15 s later; a second instance started in the same race sees it too, so it only checks that the first is running and never asks it to show its window. The client starts the app with `open -g <App>.app` on macOS and `<install>\bin\launcher.exe`, detached, on Windows. It polls the socket every 100 ms for up to 30 s.
