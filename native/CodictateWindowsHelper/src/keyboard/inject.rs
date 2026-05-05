use std::thread;
use std::time::Duration;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_BACK, VK_CONTROL,
    VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT,
};

fn send_key(vk: u16, key_up: bool) -> bool {
    let flags = if key_up { KEYEVENTF_KEYUP } else { 0 };
    let input = INPUT {
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
    };

    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
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
    let modifiers_released = release_modifiers_for_text_injection();
    let ctrl_down = send_key(VK_LCONTROL, false);
    let v_down = send_key(b'V' as u16, false);
    let v_up = send_key_up_safely(b'V' as u16);
    let left_ctrl_up = send_key_up_safely(VK_LCONTROL);
    let right_ctrl_up = send_key_up_safely(VK_RCONTROL);
    let ctrl_up = send_key_up_safely(VK_CONTROL);

    modifiers_released && ctrl_down && v_down && v_up && left_ctrl_up && right_ctrl_up && ctrl_up
}

pub fn send_backspaces(count: usize) -> bool {
    for _ in 0..count {
        if !send_key_press(VK_BACK) {
            return false;
        }
    }
    true
}
