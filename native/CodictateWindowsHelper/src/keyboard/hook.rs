use super::protocol::{KeyEventMessage, SwallowRule};
use crate::ipc::emit_json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU, VK_RCONTROL,
    VK_RETURN, VK_RMENU, VK_RSHIFT, VK_SPACE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

static HOOK_STATE: OnceLock<Arc<Mutex<HookState>>> = OnceLock::new();

const LLKHF_INJECTED: u32 = 0x10;

#[derive(Clone, Copy, Default)]
struct ModifierState {
    left_alt: bool,
    right_alt: bool,
    left_ctrl: bool,
    right_ctrl: bool,
    left_shift: bool,
    right_shift: bool,
}

impl ModifierState {
    fn snapshot() -> Self {
        Self {
            left_alt: key_pressed(VK_LMENU),
            right_alt: key_pressed(VK_RMENU),
            left_ctrl: key_pressed(VK_LCONTROL),
            right_ctrl: key_pressed(VK_RCONTROL),
            left_shift: key_pressed(VK_LSHIFT),
            right_shift: key_pressed(VK_RSHIFT),
        }
    }

    fn option(self) -> bool {
        self.left_alt || self.right_alt
    }

    fn control(self) -> bool {
        self.left_ctrl || self.right_ctrl
    }

    fn shift(self) -> bool {
        self.left_shift || self.right_shift
    }
}

#[derive(Default)]
pub(crate) struct HookState {
    swallow_rules: Vec<SwallowRule>,
    active_combo: Option<ActiveCombo>,
    pressed_keys: HashSet<i32>,
}

#[derive(Clone, Copy)]
enum ActiveComboModifier {
    Alt,
    Control,
}

#[derive(Clone, Copy)]
struct ActiveCombo {
    trigger_keycode: i32,
    modifier: ActiveComboModifier,
}

#[derive(Clone, Copy)]
enum ModifierKey {
    LeftAlt,
    RightAlt,
    LeftCtrl,
    RightCtrl,
    LeftShift,
    RightShift,
}

fn key_pressed(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

fn vk_to_keycode(vk: u32) -> Option<(i32, Option<ModifierKey>)> {
    match vk {
        x if x == VK_SPACE as u32 => Some((49, None)),
        x if x == VK_RETURN as u32 => Some((36, None)),
        0x1B => Some((53, None)),
        0x08 => Some((51, None)),
        0x09 => Some((48, None)),
        0x70 => Some((122, None)),
        0x71 => Some((120, None)),
        x if x == VK_LSHIFT as u32 => Some((56, Some(ModifierKey::LeftShift))),
        x if x == VK_RSHIFT as u32 => Some((60, Some(ModifierKey::RightShift))),
        x if x == VK_LCONTROL as u32 => Some((59, Some(ModifierKey::LeftCtrl))),
        x if x == VK_RCONTROL as u32 => Some((62, Some(ModifierKey::RightCtrl))),
        x if x == VK_CONTROL as u32 => Some((59, Some(ModifierKey::LeftCtrl))),
        x if x == VK_LMENU as u32 => Some((58, Some(ModifierKey::LeftAlt))),
        x if x == VK_RMENU as u32 => Some((61, Some(ModifierKey::RightAlt))),
        x if x == VK_MENU as u32 => Some((58, Some(ModifierKey::LeftAlt))),
        _ => None,
    }
}

fn apply_modifier(modifiers: &mut ModifierState, modifier: ModifierKey, pressed: bool) {
    match modifier {
        ModifierKey::LeftAlt => modifiers.left_alt = pressed,
        ModifierKey::RightAlt => modifiers.right_alt = pressed,
        ModifierKey::LeftCtrl => modifiers.left_ctrl = pressed,
        ModifierKey::RightCtrl => modifiers.right_ctrl = pressed,
        ModifierKey::LeftShift => modifiers.left_shift = pressed,
        ModifierKey::RightShift => modifiers.right_shift = pressed,
    }
}

fn emit_key_event(event: KeyEventMessage) {
    let _ = emit_json(&event);
}

fn swallow_matches(rule: &SwallowRule, event: &KeyEventMessage) -> bool {
    if rule.keycode != event.keycode {
        return false;
    }

    if rule.option != event.option
        || rule.command != event.command
        || rule.control != event.control
        || rule.shift != event.shift
        || rule.function != event.function
    {
        return false;
    }

    if let Some(expected) = rule.left_option
        && expected != event.left_option
    {
        return false;
    }

    if let Some(expected) = rule.right_option
        && expected != event.right_option
    {
        return false;
    }

    true
}

fn active_combo_from_rule(rule: &SwallowRule) -> Option<ActiveCombo> {
    if rule.option {
        return Some(ActiveCombo {
            trigger_keycode: rule.keycode,
            modifier: ActiveComboModifier::Alt,
        });
    }
    if rule.control {
        return Some(ActiveCombo {
            trigger_keycode: rule.keycode,
            modifier: ActiveComboModifier::Control,
        });
    }
    None
}

fn event_matches_active_combo(combo: ActiveCombo, event: &KeyEventMessage) -> bool {
    if event.keycode == combo.trigger_keycode {
        return true;
    }

    match combo.modifier {
        ActiveComboModifier::Alt => event.keycode == 58 || event.keycode == 61,
        ActiveComboModifier::Control => event.keycode == 59 || event.keycode == 62,
    }
}

fn combo_still_held(combo: ActiveCombo, modifiers: ModifierState) -> bool {
    match combo.modifier {
        ActiveComboModifier::Alt => modifiers.option(),
        ActiveComboModifier::Control => modifiers.control(),
    }
}

pub(crate) fn initialize_hook_state() -> Arc<Mutex<HookState>> {
    let shared = Arc::new(Mutex::new(HookState::default()));
    let _ = HOOK_STATE.set(shared.clone());
    shared
}

pub(crate) fn set_swallow_rules(shared: &Arc<Mutex<HookState>>, swallow_rules: Vec<SwallowRule>) {
    if let Ok(mut state) = shared.lock() {
        state.swallow_rules = swallow_rules;
    }
}

pub(crate) unsafe extern "system" fn keyboard_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code != HC_ACTION as i32 {
        return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
    }

    let is_key_down = matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
    let is_key_up = matches!(wparam as u32, WM_KEYUP | WM_SYSKEYUP);
    if !is_key_down && !is_key_up {
        return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
    }

    let Some(shared) = HOOK_STATE.get() else {
        return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
    };

    let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
    if info.flags & LLKHF_INJECTED != 0 {
        return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
    }

    let Some((keycode, modifier_key)) = vk_to_keycode(info.vkCode) else {
        return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
    };

    let mut state = shared.lock().expect("hook state poisoned");
    let mut event_modifiers = ModifierState::snapshot();
    if let Some(modifier_key) = modifier_key {
        apply_modifier(&mut event_modifiers, modifier_key, is_key_down);
    }

    let was_pressed = state.pressed_keys.contains(&keycode);
    if is_key_down {
        state.pressed_keys.insert(keycode);
    } else {
        state.pressed_keys.remove(&keycode);
    }

    let event = KeyEventMessage {
        keycode,
        option: event_modifiers.option(),
        left_option: event_modifiers.left_alt,
        right_option: event_modifiers.right_alt,
        command: false,
        control: event_modifiers.control(),
        shift: event_modifiers.shift(),
        function: false,
        key_down: is_key_down,
        is_repeat: is_key_down && was_pressed,
    };

    let rule_match = state
        .swallow_rules
        .iter()
        .find(|rule| swallow_matches(rule, &event))
        .cloned();

    if is_key_down && let Some(ref rule) = rule_match {
        state.active_combo = active_combo_from_rule(rule);
    }

    let combo_match = state
        .active_combo
        .map(|combo| event_matches_active_combo(combo, &event))
        .unwrap_or(false);

    if let Some(combo) = state.active_combo
        && !combo_still_held(combo, event_modifiers)
    {
        state.active_combo = None;
    }

    let is_modifier_release = is_key_up && modifier_key.is_some();
    let should_swallow = !is_modifier_release && (rule_match.is_some() || combo_match);

    emit_key_event(event);
    drop(state);

    if should_swallow {
        1
    } else {
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }
}
