# On Linux, the Dictation Shortcut and the paste go through Hyprland

On macOS and Windows the Native Helper hooks the keyboard itself: `KeyListener` installs a CGEventTap, `CodictateWindowsHelper` a `WH_KEYBOARD_LL` hook. Both see every key, report raw key events to the main process, swallow the keys of the Dictation Shortcut, and paste by posting a synthetic Cmd+V / Ctrl+V. A future reader will expect the Linux helper to do the same and will find that it does not: it asks the compositor to do both jobs.

Linux is a Preview Platform with Omarchy (Hyprland on Wayland) as its first target. Wayland deliberately gives an ordinary client no global view of the keyboard and no way to inject input into another client's surface, so every option below is a way around that, and each pays for it differently.

## Decision

The Linux Native Helper registers the Dictation Shortcut's key combinations as Hyprland binds at runtime, over Hyprland's own IPC socket (`hl.bind` through `eval`), without editing the user's config. A bind's action raises a Hyprland custom event, and the helper turns the event stream into the same key events the main process already consumes from macOS and Windows, so Hold, Tap, the second shortcut and every other part of the shortcut logic stay platform-blind. The release is detected inside Hyprland by polling whether the Trigger Key is still down, because a release bind does not fire when the user lets go of the Modifier first. The binds are registered again whenever Hyprland reloads its config, which drops runtime binds.

The paste goes through Hyprland too: the text is put on the Wayland clipboard, then Hyprland is asked to send Ctrl+V, or Shift+Insert when the focused window carries Omarchy's `terminal` tag. That is exactly what Omarchy's own universal paste (Super+V) does, for the reason it states: Hyprland sends precisely the Modifiers it is given even while the user is physically holding others, which is the normal state during a Hold Dictation.

## Considered Options

- **Read the keyboard devices directly (evdev).** Closest to macOS and Windows: raw key events, every Preset including modifier-only ones, any compositor. Rejected as the first backend because it needs the user in the `input` group (a one-time sudo and a re-login, and read access to every keystroke on the machine), and because it cannot swallow keys: Alt+Space would reach the focused app as well as start a Dictation. It remains the likely fallback for GNOME and KDE.
- **The desktop GlobalShortcuts portal.** No permissions, compositor-agnostic in principle. Rejected for now: `xdg-desktop-portal-hyprland` ignores the preferred trigger, so the user would have to bind it by hand, and it has been observed dropping the release signal that Hold depends on.
- **A virtual keyboard for the paste (`wtype`, `zwp_virtual_keyboard_v1`, uinput).** Rejected. A virtual keyboard's modifiers merge with the ones the user is physically holding at the seat, so Ctrl+V during a Hold on Alt+Space arrives as Ctrl+Alt+V. `wtype` also has open bugs with long and non-ASCII strings in Chromium-based apps, and uinput is layout-dependent and cannot type Unicode at all.
- **Type the text key by key instead of pasting.** Rejected for the same Unicode reasons; æ, ø and å are the first thing a Danish user dictates.

## Consequences

- The Linux build works on Hyprland only. On any other desktop the helper reports that it has no shortcut backend and Codictate says so, rather than offering a Dictation Shortcut that never fires.
- Modifier-only Presets (Right Alt, Ctrl+Alt, Ctrl+Super) are not offered on Linux. As Hyprland binds they would fire whenever the user types æ/ø/å through an Alt binding or starts any of Omarchy's Super+Ctrl chords.
- A Preset whose combination Hyprland already binds is a **Shortcut Conflict**: it is not offered, and a saved shortcut that becomes conflicting is healed to a free one with a note. The helper reports Hyprland's current binds so the main process can decide this, and reports them again after every reload.
- If the helper dies without cleaning up, its binds stay registered until Hyprland reloads, and the combination does nothing in the meantime. The next helper replaces them.
- Synthetic keyboards cannot be used to test the shortcut path end to end on every setup; see `docs/LINUX.md` for how the automated test drives it.
