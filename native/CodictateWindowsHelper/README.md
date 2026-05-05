# CodictateWindowsHelper

Single Rust helper binary for Codictate's Windows-native features.

## Commands

- `--list-devices`: prints input devices as a JSON map of index to `{ index, name, id }` where `id` is the stable Windows Core Audio endpoint ID when available.
- `--mic-authorization`: reports whether a default input device is available.
- `record <path> <deviceIndexOrEndpointId> <maxSeconds>`: records mono `16 kHz` `16-bit PCM` WAV.
- `transcribe <wavPath> <parakeetModelDir>`: transcribes a WAV with ONNX Parakeet and prints `{ "kind": "final", "text": "..." }`.
- `stream <vad|live> <parakeetModelDir>`: captures the default microphone, transcribes with ONNX Parakeet, and injects text into the focused app.
- `keyboard-hook`: starts the low-level keyboard hook and paste IPC loop.
- `indicator`: starts the floating recording indicator Win32 window.

## Module Layout

- `main.rs`: CLI dispatch only.
- `audio/`: microphone discovery, Core Audio endpoint IDs, event-driven WASAPI endpoint capture, streaming resampling, and WAV writing.
- `keyboard/`: keyboard protocol, hook, shortcut swallowing, clipboard, and text injection.
- `indicator/`: indicator protocol, drawing, and UI-thread-owned Win32 window state.
- `asr/`: ONNX Parakeet batch and stream transcription, using DirectML when available with CPU fallback.
- `ipc.rs`: stdout JSON-line emission shared by helper modes.

## Integration Contract

The Bun process spawns this same executable in different modes. Keep command names, stdout JSON-line payloads, and record arguments stable unless the TypeScript callers are updated in the same change.

On Windows, settings persist the Core Audio endpoint ID from `--list-devices`. The `record` command opens that endpoint ID directly through WASAPI when an ID is provided, avoiding CPAL index drift. Numeric indices remain as a fallback for older callers and development use.

Build with:

```sh
bun run build:native:windows-helper
```

Validate with:

```sh
bun run check:native:windows-helper
```
