//! Text-injection keystrokes on Linux, through Hyprland's `send_key_state`.
//!
//! Same function names as the Windows `SendInput` module so the ONNX Parakeet
//! stream path compiles unchanged on both platforms. Each call is one Lua eval;
//! the calls block until the keystrokes they scheduled have been sent, so
//! consecutive calls cannot interleave.

use super::hyprland::Hyprland;
use super::lua;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

fn hyprland() -> Option<&'static Hyprland> {
    static INSTANCE: OnceLock<Option<Hyprland>> = OnceLock::new();
    INSTANCE.get_or_init(Hyprland::from_env).as_ref()
}

fn eval(chunk: &str) -> bool {
    match hyprland() {
        Some(hyprland) => match hyprland.eval(chunk) {
            Ok(()) => true,
            Err(err) => {
                eprintln!("CodictateWindowsHelper: Hyprland keystroke failed: {err}");
                false
            }
        },
        None => false,
    }
}

/// Hyprland sends every keystroke with explicit mods, so physically held
/// Modifiers never merge into the chord and there is nothing to release.
pub fn release_modifiers_for_text_injection() -> bool {
    hyprland().is_some()
}

/// The universal paste keystroke (CTRL+V, or SHIFT+Insert in a terminal).
pub fn send_ctrl_v() -> bool {
    let sent = eval(&lua::paste_chunk(0));
    if sent {
        thread::sleep(Duration::from_millis(
            u64::from(lua::PASTE_KEY_UP_DELAY_MS) + 10,
        ));
    }
    sent
}

pub fn send_space() -> bool {
    eval(&lua::key_tap_chunk("space"))
}

pub fn send_backspaces(count: usize) -> bool {
    if count == 0 {
        return true;
    }
    let sent = eval(&lua::backspaces_chunk(count));
    let pending = lua::backspaces_duration_ms(count);
    if sent && pending > 0 {
        thread::sleep(Duration::from_millis(pending + 10));
    }
    sent
}
