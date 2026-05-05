mod hook;
mod inject;
pub mod protocol;

use self::protocol::{
    ClipboardSetMessage, KeyboardHookCommand, KeyboardStartedMessage, PasteResultMessage,
    PermissionsMessage, StatusMessage,
};
use crate::audio::default_input_available;
use crate::ipc::emit_json;
use arboard::Clipboard;
use std::io::{self, BufRead};
use std::process::ExitCode;
use std::thread;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, HHOOK, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_QUIT,
};

fn emit_permissions(microphone: bool, accessibility: bool) -> io::Result<()> {
    emit_json(&PermissionsMessage::new(microphone, accessibility))
}

pub fn handle_keyboard_hook() -> ExitCode {
    let stdin = io::stdin();
    let mut clipboard = Clipboard::new().ok();
    let microphone = default_input_available();
    let accessibility = true;

    let shared = hook::initialize_hook_state();
    let hook_thread_id = unsafe { GetCurrentThreadId() };
    let command_state = shared;

    let command_thread = thread::spawn(move || {
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                let _ = unsafe { PostThreadMessageW(hook_thread_id, WM_QUIT, 0, 0) };
                return;
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let command = match serde_json::from_str::<KeyboardHookCommand>(trimmed) {
                Ok(command) => command,
                Err(err) => {
                    let _ = emit_json(&StatusMessage::error(format!(
                        "Invalid keyboard-hook command: {err}"
                    )));
                    continue;
                }
            };

            match command {
                KeyboardHookCommand::Configure { swallow } => {
                    hook::set_swallow_rules(&command_state, swallow);
                    let _ = emit_permissions(microphone, accessibility);
                }
                KeyboardHookCommand::CheckPermissions => {
                    let _ = emit_permissions(microphone, accessibility);
                }
                KeyboardHookCommand::SetClipboard { text } => {
                    let success = clipboard
                        .as_mut()
                        .and_then(|clipboard| clipboard.set_text(text).ok())
                        .is_some();
                    let _ = emit_json(&ClipboardSetMessage::new(success));
                }
                KeyboardHookCommand::PasteText { text } => {
                    let clipboard_ok = clipboard
                        .as_mut()
                        .and_then(|clipboard| clipboard.set_text(text).ok())
                        .is_some();
                    let success = clipboard_ok && inject::send_ctrl_v();
                    let message = if success {
                        "Pasted text into the focused app."
                    } else if clipboard_ok {
                        "Clipboard updated, but simulated Ctrl+V failed."
                    } else {
                        "Clipboard update failed."
                    };
                    let _ = emit_json(&PasteResultMessage::new(success, accessibility, message));
                }
                KeyboardHookCommand::ReplaceText { delete_text, text } => {
                    let clipboard_ok = clipboard
                        .as_mut()
                        .and_then(|clipboard| clipboard.set_text(text).ok())
                        .is_some();
                    let modifiers_released = inject::release_modifiers_for_text_injection();
                    let deleted =
                        modifiers_released && inject::send_backspaces(delete_text.chars().count());
                    let success = clipboard_ok && deleted && inject::send_ctrl_v();
                    let message = if success {
                        "Replaced text in the focused app."
                    } else {
                        "Windows replace_text could not complete."
                    };
                    let _ = emit_json(&PasteResultMessage::new(success, accessibility, message));
                }
                KeyboardHookCommand::RequestInputMonitoring => {
                    let _ = emit_json(&StatusMessage::permission_requested(
                        "Windows does not require a separate Input Monitoring permission.",
                    ));
                }
                KeyboardHookCommand::PromptAccessibility => {
                    let _ = emit_json(&StatusMessage::permission_requested(
                        "Windows keyboard hook and input injection are active without a separate accessibility prompt.",
                    ));
                }
                KeyboardHookCommand::RequestMicrophone => {
                    let _ = emit_json(&StatusMessage::permission_requested(
                        "Microphone permission is handled by the Windows recorder helper.",
                    ));
                }
            }
        }

        let _ = unsafe { PostThreadMessageW(hook_thread_id, WM_QUIT, 0, 0) };
    });

    if emit_json(&KeyboardStartedMessage::new(microphone, accessibility)).is_err() {
        return ExitCode::from(1);
    }

    let hook = unsafe {
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(hook::keyboard_proc),
            std::ptr::null_mut(),
            0,
        )
    };
    if hook.is_null() {
        let _ = emit_json(&StatusMessage::error(
            "SetWindowsHookExW(WH_KEYBOARD_LL) failed.",
        ));
        return ExitCode::from(1);
    }

    let mut message = windows_sys::Win32::UI::WindowsAndMessaging::MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    unsafe {
        UnhookWindowsHookEx(hook as HHOOK);
    }
    let _ = command_thread.join();
    ExitCode::SUCCESS
}
