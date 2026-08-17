# Dictation Shortcuts stay a curated Preset list; no record-your-own capture

Users asked for Wispr Flow style shortcuts, in particular `Ctrl+Win` on Windows. A future reader will see a fixed `ShortcutId` union and assume free-form key capture was simply never attempted. It was considered and deliberately deferred: we add Presets instead.

## Considered Options

- **Free-form capture UI.** On macOS this is nearly free: `KeyListener.swift` already forwards every keycode plus all modifier flags, and swallow rules are already generic dictionaries. On Windows it is not: `native/CodictateWindowsHelper/src/keyboard/hook.rs` maps only Space, Enter, and the left/right Shift/Ctrl/Alt modifiers into mac keycodes, so arbitrary capture needs a full VK translation table. Shipping capture on macOS alone would violate platform parity, and the request originated on Windows.
- **Curated Presets (chosen).** Each Preset stays a hand-verified combination, so we never have to defend a user-chosen binding that collides with a system shortcut. Constraints borrowed from Wispr Flow: at most three keys, at least one modifier, and never mix left and right variants of the same modifier.

## Consequences

- A new Meta Shortcut Family exists, rendered as Win on Windows and Command on macOS. Windows key labels must never show Command or Option glyphs. `control-meta` and `control-meta-space` group under Meta rather than Control, because Meta is the key a user scans the picker for.
- Three Presets were added on both platforms: `control-meta` (`⌃ + ⌘` / `Ctrl + Win`), `control-meta-space`, and `control-option` (`⌃ + ⌥` / `Ctrl + Alt`). `control-meta` and `control-option` are modifier-only, so they fire when the second modifier of the pair goes down and their hold ends as soon as either one is released.
- The Windows helper gained `VK_LWIN`/`VK_RWIN` mapping (to the mac `command` / `rightCommand` keycodes, so one shortcut definition covers both platforms) and Win state in its modifier struct. This was required for `Ctrl+Win` regardless of the capture decision, since the Win key was previously invisible to the hook. `KeyEventMessage.command` was hardcoded `false` and now reports real Win state.
- Combo tracking in the Windows hook now records a *set* of required modifiers instead of a single one. The previous `ActiveComboModifier` enum could not express "Ctrl and Win", so a two-modifier combo would have stayed active after one of them was released.
- **Unverified:** whether swallowing Win key-down under Ctrl actually stops Windows opening the Start menu. That needs a real Windows machine; the logic is unit-tested but the OS behaviour is not confirmed.
- Adding a Preset means touching a fixed list in `src/shared/shortcut-options.ts`, `src/shared/types.ts`, and `src/bun/utils/keyboard/keyboard-events.ts`. If that list grows much past a dozen entries, revisit capture.
