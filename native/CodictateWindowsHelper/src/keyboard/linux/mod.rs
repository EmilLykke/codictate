//! Linux `keyboard-hook` (Preview Platform, Hyprland only).
//!
//! There is no keyboard hook: each Dictation Shortcut is registered as a
//! Hyprland bind whose Lua action dispatches `custom>>codictate:<token>:...`
//! events, which this process reads from `.socket2.sock` and turns into the
//! same key-event JSON lines the Windows hook emits. Paste goes through
//! Hyprland too (`send_key_state`), mirroring Omarchy's universal paste.

mod binds;
mod hyprland;
pub(crate) mod inject;
mod lua;

use self::binds::{HyprBind, Socket2Event};
use self::hyprland::Hyprland;
use super::protocol::{
    ClipboardSetMessage, DesktopBinding, DesktopBindingsMessage, KeyboardHookCommand,
    KeyboardStartedMessage, PasteResultMessage, PermissionsMessage, StatusMessage,
};
use crate::audio::default_input_available;
use crate::ipc::emit_json;
use arboard::{Clipboard, LinuxClipboardKind, SetExtLinux};
use crossbeam_channel::{Sender, unbounded};
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::collections::BTreeSet;
use std::io::{self, BufRead, BufReader, Read};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

/// Time for the clipboard owner (a thread of this process) to be announced to
/// the compositor before the paste keystroke asks the focused app to read it.
const CLIPBOARD_SETTLE_DELAY: Duration = Duration::from_millis(40);

enum Event {
    Command(KeyboardHookCommand),
    InvalidCommand(String),
    StdinClosed,
    Hyprland(Socket2Event),
    HyprlandEventsClosed(String),
    Shutdown,
}

struct Backend {
    hyprland: Hyprland,
    token: String,
}

struct KeyboardHook {
    backend: Option<Backend>,
    microphone: bool,
    clipboard: Option<Clipboard>,
    /// The rules of the last `configure`, as binds.
    binds: Vec<HyprBind>,
    /// Key strings currently registered in Hyprland by this process.
    registered_keys: Vec<String>,
    /// Rule indices whose down event was emitted and whose up was not.
    down: BTreeSet<usize>,
}

pub fn handle_keyboard_hook() -> ExitCode {
    let (tx, rx) = unbounded::<Event>();

    // Before any other thread exists, so SIGINT / SIGTERM always reach the
    // signal-hook pipe rather than killing the process with binds registered.
    match Signals::new([SIGINT, SIGTERM, SIGHUP]) {
        Ok(mut signals) => {
            let tx = tx.clone();
            thread::spawn(move || {
                if signals.forever().next().is_some() {
                    let _ = tx.send(Event::Shutdown);
                }
            });
        }
        Err(err) => eprintln!("CodictateWindowsHelper: signal handler setup failed: {err}"),
    }

    let backend = Hyprland::from_env()
        .filter(Hyprland::is_reachable)
        .map(|hyprland| Backend {
            hyprland,
            token: random_token(),
        });

    let mut hook = KeyboardHook {
        backend,
        microphone: default_input_available(),
        clipboard: None,
        binds: Vec::new(),
        registered_keys: Vec::new(),
        down: BTreeSet::new(),
    };

    if let Some(backend) = &hook.backend {
        spawn_event_reader(backend.hyprland.clone(), tx.clone());
    }
    spawn_stdin_reader(tx);

    let backend_name = if hook.backend.is_some() {
        "hyprland"
    } else {
        "unavailable"
    };
    if emit_json(&KeyboardStartedMessage::linux(
        hook.microphone,
        backend_name,
    ))
    .is_err()
    {
        return ExitCode::from(1);
    }

    // After `started`: without a reachable display server arboard can block on
    // its X11 fallback for seconds, and the Bun side waits for `started`.
    hook.clipboard = match Clipboard::new() {
        Ok(clipboard) => Some(clipboard),
        Err(err) => {
            eprintln!("CodictateWindowsHelper: clipboard unavailable: {err}");
            None
        }
    };

    while let Ok(event) = rx.recv() {
        match event {
            Event::Command(command) => hook.handle_command(command),
            Event::InvalidCommand(message) => {
                let _ = emit_json(&StatusMessage::error(message));
            }
            Event::Hyprland(event) => hook.handle_hyprland_event(event),
            Event::HyprlandEventsClosed(reason) => {
                eprintln!("CodictateWindowsHelper: Hyprland event socket closed: {reason}");
            }
            Event::StdinClosed | Event::Shutdown => break,
        }
    }

    hook.unregister();
    ExitCode::SUCCESS
}

impl KeyboardHook {
    fn handle_command(&mut self, command: KeyboardHookCommand) {
        match command {
            KeyboardHookCommand::Configure { swallow } => {
                self.binds = binds::binds_for_rules(&swallow);
                self.register();
                self.emit_permissions();
            }
            KeyboardHookCommand::CheckPermissions => self.emit_permissions(),
            KeyboardHookCommand::ListDesktopBindings => self.emit_desktop_bindings(),
            KeyboardHookCommand::SetClipboard { text } => {
                let success = self.set_clipboard(&text, false);
                let _ = emit_json(&ClipboardSetMessage::new(success));
            }
            KeyboardHookCommand::PasteText { text } => {
                let (success, message) = self.paste(&text, 0);
                let _ = emit_json(&PasteResultMessage::new(success, true, message));
            }
            KeyboardHookCommand::ReplaceText { delete_text, text } => {
                let (success, message) = self.paste(&text, delete_text.chars().count());
                let message = if success {
                    "Replaced text in the focused app."
                } else {
                    message
                };
                let _ = emit_json(&PasteResultMessage::new(success, true, message));
            }
            KeyboardHookCommand::RequestInputMonitoring => {
                let _ = emit_json(&StatusMessage::permission_requested(
                    "Linux does not require a separate Input Monitoring permission: Dictation Shortcuts are Hyprland binds.",
                ));
            }
            KeyboardHookCommand::PromptAccessibility => {
                let _ = emit_json(&StatusMessage::permission_requested(
                    "Linux pastes through Hyprland without a separate accessibility prompt.",
                ));
            }
            KeyboardHookCommand::RequestMicrophone => {
                let _ = emit_json(&StatusMessage::permission_requested(
                    "Microphone access is handled by PipeWire for the Linux recorder helper.",
                ));
            }
        }
    }

    fn handle_hyprland_event(&mut self, event: Socket2Event) {
        match event {
            Socket2Event::Key {
                token,
                down,
                rule_index,
            } => {
                let Some(backend) = &self.backend else {
                    return;
                };
                if token != backend.token {
                    return;
                }
                let Some(bind) = self.binds.iter().find(|bind| bind.rule_index == rule_index)
                else {
                    return;
                };
                let changed = if down {
                    self.down.insert(rule_index)
                } else {
                    self.down.remove(&rule_index)
                };
                if changed {
                    let _ = emit_json(&bind.key_event(down));
                }
            }
            Socket2Event::ConfigReloaded => {
                // A reload drops every runtime bind, kills every Lua timer and
                // resets the Lua state, so nothing of ours survives in Hyprland.
                self.registered_keys.clear();
                self.register();
                self.emit_desktop_bindings();
            }
        }
    }

    /// Replaces this process's binds in Hyprland with `self.binds`.
    fn register(&mut self) {
        self.release_held_keys();
        let Some(backend) = &self.backend else {
            return;
        };
        if self.binds.is_empty() && self.registered_keys.is_empty() {
            return;
        }
        let lua = lua::register_chunk(
            &backend.token,
            &binds::bind_description(&backend.token),
            &self.registered_keys,
            &self.binds,
        );
        let result = backend.hyprland.eval(&lua);
        self.registered_keys = self.binds.iter().map(|bind| bind.keys.clone()).collect();
        if let Err(err) = result {
            let _ = emit_json(&StatusMessage::error(format!(
                "Hyprland Dictation Shortcut registration failed: {err}"
            )));
        }
    }

    /// Removes every bind this process registered.
    fn unregister(&mut self) {
        self.release_held_keys();
        let Some(backend) = &self.backend else {
            return;
        };
        if self.registered_keys.is_empty() {
            return;
        }
        let lua = lua::unregister_chunk(&backend.token, &self.registered_keys);
        match backend.hyprland.eval(&lua) {
            Ok(()) => self.registered_keys.clear(),
            Err(err) => {
                eprintln!("CodictateWindowsHelper: Hyprland unbind failed: {err}");
            }
        }
    }

    /// A Trigger Key that is down when its bind goes away would never report
    /// its release, so report it here.
    fn release_held_keys(&mut self) {
        for rule_index in std::mem::take(&mut self.down) {
            if let Some(bind) = self.binds.iter().find(|bind| bind.rule_index == rule_index) {
                let _ = emit_json(&bind.key_event(false));
            }
        }
    }

    fn emit_permissions(&self) {
        let _ = emit_json(&PermissionsMessage::new(self.microphone, true));
    }

    fn emit_desktop_bindings(&self) {
        let bindings = match self.desktop_bindings() {
            Ok(bindings) => bindings,
            Err(err) => {
                let _ = emit_json(&StatusMessage::error(err));
                Vec::new()
            }
        };
        let _ = emit_json(&DesktopBindingsMessage::new(bindings));
    }

    fn desktop_bindings(&self) -> Result<Vec<DesktopBinding>, String> {
        let Some(backend) = &self.backend else {
            return Ok(Vec::new());
        };
        binds::desktop_bindings_from_json(&backend.hyprland.binds_json()?)
    }

    fn set_clipboard(&mut self, text: &str, also_primary: bool) -> bool {
        let Some(clipboard) = self.clipboard.as_mut() else {
            return false;
        };
        let clipboard_ok = clipboard.set_text(text).is_ok();
        if clipboard_ok && also_primary {
            // Some terminals paste PRIMARY on SHIFT+Insert; best effort.
            let _ = clipboard
                .set()
                .clipboard(LinuxClipboardKind::Primary)
                .text(text);
        }
        clipboard_ok
    }

    fn paste(&mut self, text: &str, backspaces: usize) -> (bool, &'static str) {
        if !self.set_clipboard(text, true) {
            return (false, "Clipboard update failed.");
        }
        let Some(backend) = &self.backend else {
            return (
                false,
                "Clipboard updated, but Hyprland is not available to send the paste keystroke.",
            );
        };
        thread::sleep(CLIPBOARD_SETTLE_DELAY);
        match backend.hyprland.eval(&lua::paste_chunk(backspaces)) {
            Ok(()) => (true, "Pasted text into the focused app."),
            Err(err) => {
                eprintln!("CodictateWindowsHelper: Hyprland paste failed: {err}");
                (
                    false,
                    "Clipboard updated, but the Hyprland paste keystroke failed.",
                )
            }
        }
    }
}

fn spawn_stdin_reader(tx: Sender<Event>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let event = match serde_json::from_str::<KeyboardHookCommand>(trimmed) {
                Ok(command) => Event::Command(command),
                Err(err) => Event::InvalidCommand(format!("Invalid keyboard-hook command: {err}")),
            };
            if tx.send(event).is_err() {
                return;
            }
        }
        let _ = tx.send(Event::StdinClosed);
    });
}

fn spawn_event_reader(hyprland: Hyprland, tx: Sender<Event>) {
    thread::spawn(move || {
        let stream = match hyprland.connect_events() {
            Ok(stream) => stream,
            Err(err) => {
                let _ = tx.send(Event::HyprlandEventsClosed(err.to_string()));
                return;
            }
        };
        for line in BufReader::new(stream).lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    let _ = tx.send(Event::HyprlandEventsClosed(err.to_string()));
                    return;
                }
            };
            if let Some(event) = binds::parse_socket2_line(&line)
                && tx.send(Event::Hyprland(event)).is_err()
            {
                return;
            }
        }
        let _ = tx.send(Event::HyprlandEventsClosed("end of stream".to_string()));
    });
}

/// A per-process id, so events from binds a crashed helper left behind are
/// not mistaken for this process's.
fn random_token() -> String {
    let mut bytes = [0u8; 8];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes));
    if read.is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let mixed = nanos ^ (u128::from(std::process::id()) << 64);
        bytes.copy_from_slice(&mixed.to_le_bytes()[..8]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_sixteen_hex_chars_and_differ() {
        let first = random_token();
        let second = random_token();
        assert_eq!(first.len(), 16);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
