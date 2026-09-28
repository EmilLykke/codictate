# CodictateWindowsHelper

Single Rust helper binary for Codictate's Windows-native features, and for the
Linux Preview Platform (Hyprland only). One crate, `#[cfg]` backends; the
binary keeps its name on both platforms.

## Commands

- `--list-devices`: prints input devices as a JSON map of index to `{ index, name, id }` where `id` is the stable Windows Core Audio endpoint ID when available.
- `--mic-authorization`: reports whether a default input device is available.
- `record <path> <deviceIndexOrEndpointId> <maxSeconds>`: records mono `16 kHz` `16-bit PCM` WAV.
- `transcribe <wavPath> <parakeetModelDir>`: transcribes a WAV with ONNX Parakeet and prints `{ "kind": "final", "text": "..." }`.
- `stream <vad|live> <parakeetModelDir> [deviceIndexOrEndpointId]`: captures the selected microphone, transcribes with ONNX Parakeet, and injects text into the focused app.
- `keyboard-hook`: starts the low-level keyboard hook and paste IPC loop.
- `indicator`: starts the floating recording indicator Win32 window.

## Module Layout

- `main.rs`: CLI dispatch only.
- `audio/`: microphone discovery, Core Audio endpoint IDs, event-driven WASAPI endpoint capture, streaming resampling, and WAV writing.
- `keyboard/`: keyboard protocol, hook, shortcut swallowing, clipboard, and text injection.
- `indicator/`: indicator protocol, drawing, and UI-thread-owned Win32 window state.
- `asr/`: ONNX Parakeet batch and stream transcription, using DirectML when available with CPU fallback.
- `ipc.rs`: stdout JSON-line emission shared by helper modes.

## Linux backend

Linux has no keyboard hook, no indicator window and no `SendInput`. Everything
input-related goes through Hyprland's IPC sockets
(`$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/`):

- Requests on `.socket.sock` use `hyprctl`'s wire format: `/eval <lua>` for
  `hyprctl eval`, `j/binds` for `hyprctl -j binds`. One request per
  connection; Hyprland answers `ok` or error text.
- `keyboard-hook` registers each Dictation Shortcut with `hl.bind("ALT + code:65", fn)`
  (physical keycode, xkb = evdev + 8). The bind dispatches
  `custom>>codictate:<token>:down:<ruleIndex>`, then polls `hl.is_key_down(65)`
  on oneshot `hl.timer`s and dispatches `...:up:<ruleIndex>` once the key is up.
  The helper reads those from `.socket2.sock` and emits the usual key-event JSON.
  `<token>` is random per process. Binds are re-registered on `configreloaded`
  and removed with `hl.unbind("<keys>")` on stdin EOF, SIGINT, SIGTERM and SIGHUP.
- Never call methods on an `HL.Keybind` handle: in Hyprland 0.56.2 any method
  on an expired handle segfaults the compositor.
- `list_desktop_bindings` (Linux only) answers `{"type":"desktop_bindings","bindings":[{modmask,key,description}]}`
  from `j/binds`, without Codictate's own binds (description marker `[codictate:`);
  it is also emitted after every config reload.
- `paste_text` / `replace_text` set the Wayland clipboard (and PRIMARY) through
  `wlr-data-control`, then send BackSpaces and the paste chord with
  `hl.dsp.send_key_state`, like Omarchy's universal paste: SHIFT+Insert in a
  window tagged `terminal`, CTRL+V elsewhere.
- `keyboard-hook` starts with `"platform":"linux"` and
  `"shortcutBackend":"hyprland"`, or `"unavailable"` outside Hyprland. When
  unavailable it stays running and answers commands, but binds nothing.
- `--list-devices` lists PipeWire capture sources from `pactl -f json list sources`
  (monitors excluded): `name` is the description, `id` the source name.
  `record` accepts `default`, an index, or that id. The id is recorded through
  ALSA's `pulse` PCM with `PULSE_SOURCE`. `record` also stops cleanly on
  SIGINT / SIGTERM.
- ONNX Parakeet runs on CPU (`parakeet-rs` default features).

## Integration Contract

The Bun process spawns this same executable in different modes. Keep command names, stdout JSON-line payloads, and record arguments stable unless the TypeScript callers are updated in the same change.

On Windows, settings persist the Core Audio endpoint ID from `--list-devices`. The `record` and `stream` commands open that endpoint ID directly through WASAPI when an ID is provided, avoiding CPAL index drift. Numeric indices remain as a fallback for older callers and development use.

Build with:

```sh
bun run build:native:windows-helper
```

Validate with:

```sh
bun run check:native:windows-helper
```

On Linux, from this directory: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
