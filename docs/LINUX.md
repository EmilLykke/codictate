# Codictate on Linux (Preview Platform)

Linux is a **Preview Platform** (see `CONTEXT.md`): Codictate runs there with openly declared gaps, and a feature it cannot run is not offered. The first and only tested target is **Omarchy** (Arch Linux, Hyprland on Wayland) on x64.

## Requirements

- **Hyprland.** The Dictation Shortcut and the paste go through Hyprland itself (`docs/adr/0008-linux-shortcuts-through-hyprland.md`). On any other desktop the app starts, but says the Dictation Shortcut cannot be registered.
- **XWayland.** Electrobun runs its webview through GTK's X11 backend.
- System libraries: `webkit2gtk-4.1`, `gtk3`, `libayatana-appindicator`, `libnotify`, `vulkan-icd-loader` (`libvulkan.so.1`), OpenSSL 3 and `libgomp`. All are present on Omarchy.
- PipeWire (or PulseAudio) with `pactl`, for the microphone list.
- glibc new enough for the Ubuntu 22.04-built Vulkan prebuilts of `crispasr` and `llama-completion`.

## What works

| Feature | Linux |
|---|---|
| Batch Dictation: Whisper and hviske (`crispasr`, Vulkan) | Yes |
| Parakeet (ONNX int8 on the CPU, in the Rust Native Helper) | Yes |
| Live Transcription (VAD and Live) | Yes; the last words are pasted when it stops |
| Hold and Tap, primary and second shortcut | Yes |
| Formatting through llama.cpp (Vulkan) | Yes |
| Tray, chimes, notifications | Yes |

## Declared gaps

- **Only key-combination Presets:** Alt+Space (default), Alt+Enter, Ctrl+Space, Ctrl+Enter. Modifier-only Presets (Right Alt, Ctrl+Alt, Ctrl+Super) are not offered: as Hyprland binds they would fire whenever Alt types æ/ø/å or a Super+Ctrl chord starts.
- **Shortcut Conflicts:** a Preset Hyprland already binds is shown as "In use by Hyprland" and cannot be picked. A saved shortcut that becomes conflicting is moved to a free one, with a note.
- **No recording indicator.** The tray icon and the chimes show the state.
- **No correction observer**, and formatting gets no focused-app context.
- **No CUDA.** Whisper, hviske and formatting use the GPU through Vulkan; Parakeet runs on the CPU.
- **Hyprland only**, and no auto-update: there is no Linux update feed.

## Where things live

- App data, Speech Models and config: `$XDG_DATA_HOME/codictate` (default `~/.local/share/codictate`).
- The Rust Native Helper is `native/CodictateWindowsHelper` (one crate for Windows and Linux; the name predates Linux). On Linux it provides `keyboard-hook` (Hyprland binds and paste), `record`, `--list-devices`, `transcribe` and `stream`.

## Developing

```sh
bun install
bun run start:linux          # builds the helper, vendors crispasr/llama, runs electrobun dev
bun run check:native:linux-helper
CODICTATE_CHANNEL=dev bunx electrobun build --env=dev   # build/dev-linux-x64/
```

The dev scripts set `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Without it, WebKitGTK's DMA-BUF renderer fails on the NVIDIA proprietary driver (`Failed to create GBM buffer`) and the window stays blank white. It has to be in the environment before the app starts: Electrobun's launcher initialises GTK and WebKit before any Codictate code runs, so the app cannot set it for itself. An installed build needs it in the `Exec` line of its `.desktop` entry.

If `hyprctl` or the app cannot find Hyprland from a shell outside the session, export `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `HYPRLAND_INSTANCE_SIGNATURE=$(ls -t $XDG_RUNTIME_DIR/hypr | head -1)`.

## Testing without a microphone

A virtual PipeWire microphone that plays a WAV file:

```sh
pactl load-module module-null-sink sink_name=cdx_vmic
pactl load-module module-remap-source master=cdx_vmic.monitor source_name=cdx_vmic_src
pactl set-default-source cdx_vmic_src
pw-play --target cdx_vmic speech.wav      # while a Dictation is recording
# afterwards: pactl unload-module module-remap-source; pactl unload-module module-null-sink
```

Hyprland skips ordinary binds while the session is locked, so a Dictation Shortcut can only fire, from a real or a virtual keyboard, on an unlocked screen.

**Never call a method on an `HL.Keybind` handle after its bind is gone.** Hyprland 0.56.2 does not guard expired handles, and `kb:remove()` on one crashes the compositor. The helper never keeps handles: it removes its binds with `hl.unbind("<mods> + code:<n>")`.
