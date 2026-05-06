use std::thread;
use std::time::Duration;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_BACK, VK_CONTROL,
    VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_SPACE,
};

fn keyboard_input(vk: u16, key_up: bool) -> INPUT {
    let flags = if key_up { KEYEVENTF_KEYUP } else { 0 };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_key(vk: u16, key_up: bool) -> bool {
    let input = keyboard_input(vk, key_up);

    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
}

fn send_key_sequence(events: &[(u16, bool)]) -> bool {
    if events.is_empty() {
        return true;
    }
    let inputs = events
        .iter()
        .map(|(vk, key_up)| keyboard_input(*vk, *key_up))
        .collect::<Vec<_>>();
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    sent == inputs.len() as u32
}

fn send_key_up_safely(vk: u16) -> bool {
    for attempt in 0..3 {
        if send_key(vk, true) {
            return true;
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(1));
        }
    }
    false
}

pub fn release_modifiers_for_text_injection() -> bool {
    let mut success = true;
    for vk in [
        VK_CONTROL,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_MENU,
        VK_LMENU,
        VK_RMENU,
        VK_LSHIFT,
        VK_RSHIFT,
    ] {
        success = send_key_up_safely(vk) && success;
    }
    success
}

fn send_key_press(vk: u16) -> bool {
    let key_down = send_key(vk, false);
    let key_up = send_key_up_safely(vk);
    key_down && key_up
}

pub fn send_ctrl_v() -> bool {
    if !release_modifiers_for_text_injection() {
        return false;
    }

    let sent = send_key_sequence(&[
        (VK_LCONTROL, false),
        (b'V' as u16, false),
        (b'V' as u16, true),
        (VK_LCONTROL, true),
    ]);
    let v_up = send_key_up_safely(b'V' as u16);
    let left_ctrl_up = send_key_up_safely(VK_LCONTROL);
    let right_ctrl_up = send_key_up_safely(VK_RCONTROL);
    let ctrl_up = send_key_up_safely(VK_CONTROL);

    sent && v_up && left_ctrl_up && right_ctrl_up && ctrl_up
}

pub fn send_space() -> bool {
    release_modifiers_for_text_injection() && send_key_press(VK_SPACE)
}

pub fn send_backspaces(count: usize) -> bool {
    for _ in 0..count {
        if !send_key_press(VK_BACK) {
            return false;
        }
    }
    true
}
