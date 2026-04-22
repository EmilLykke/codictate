use arboard::Clipboard;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use serde::Deserialize;
use serde_json::json;
use std::env;
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, VK_BACK, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU,
    VK_RETURN, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_SPACE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT,
    MSG, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

static HOOK_STATE: OnceLock<Arc<Mutex<HookState>>> = OnceLock::new();
static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
struct SwallowRule {
    keycode: i32,
    option: bool,
    #[serde(default, rename = "leftOption")]
    left_option: Option<bool>,
    #[serde(default, rename = "rightOption")]
    right_option: Option<bool>,
    command: bool,
    control: bool,
    shift: bool,
    #[serde(rename = "fn")]
    function: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command")]
enum KeyboardHookCommand {
    #[serde(rename = "configure")]
    Configure { swallow: Vec<SwallowRule> },
    #[serde(rename = "set_clipboard")]
    SetClipboard { text: String },
    #[serde(rename = "paste_text")]
    PasteText { text: String },
    #[serde(rename = "replace_text")]
    ReplaceText {
        #[serde(rename = "deleteText")]
        delete_text: String,
        text: String,
    },
    #[serde(rename = "check_permissions")]
    CheckPermissions,
    #[serde(rename = "request_input_monitoring")]
    RequestInputMonitoring,
    #[serde(rename = "prompt_accessibility")]
    PromptAccessibility,
    #[serde(rename = "request_microphone")]
    RequestMicrophone,
}

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
struct HookState {
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

#[derive(Clone, Copy)]
struct EmittedKeyEvent {
    keycode: i32,
    option: bool,
    left_option: bool,
    right_option: bool,
    command: bool,
    control: bool,
    shift: bool,
    function: bool,
    key_down: bool,
    is_repeat: bool,
}

fn output_lock() -> &'static Mutex<()> {
    OUTPUT_LOCK.get_or_init(|| Mutex::new(()))
}

fn emit_json(value: serde_json::Value) -> io::Result<()> {
    let _guard = output_lock().lock().expect("output lock poisoned");
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn emit_permissions(microphone: bool, accessibility: bool) -> io::Result<()> {
    emit_json(json!({
        "type": "permissions",
        "inputMonitoring": true,
        "microphone": microphone,
        "accessibility": accessibility,
    }))
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

fn emit_key_event(event: EmittedKeyEvent) {
    let _ = emit_json(json!({
        "keycode": event.keycode,
        "option": event.option,
        "leftOption": event.left_option,
        "rightOption": event.right_option,
        "command": event.command,
        "control": event.control,
        "shift": event.shift,
        "fn": event.function,
        "keyDown": event.key_down,
        "isRepeat": event.is_repeat,
    }));
}

fn swallow_matches(rule: &SwallowRule, event: &EmittedKeyEvent) -> bool {
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

    if let Some(expected) = rule.left_option {
        if expected != event.left_option {
            return false;
        }
    }

    if let Some(expected) = rule.right_option {
        if expected != event.right_option {
            return false;
        }
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

fn event_matches_active_combo(combo: ActiveCombo, event: &EmittedKeyEvent) -> bool {
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

unsafe extern "system" fn keyboard_proc(
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

    let event = EmittedKeyEvent {
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

    if is_key_down {
        if let Some(ref rule) = rule_match {
            state.active_combo = active_combo_from_rule(&rule);
        }
    }

    let combo_match = state
        .active_combo
        .map(|combo| event_matches_active_combo(combo, &event))
        .unwrap_or(false);

    if let Some(combo) = state.active_combo {
        if !combo_still_held(combo, event_modifiers) {
            state.active_combo = None;
        }
    }

    let should_swallow = rule_match.is_some() || combo_match;

    emit_key_event(event);
    drop(state);

    if should_swallow {
        1
    } else {
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }
}

fn send_key(vk: u16, key_up: bool) -> bool {
    let flags = if key_up { KEYEVENTF_KEYUP } else { 0 };
    let mut input = INPUT {
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

    unsafe { SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32) == 1 }
}

fn send_key_press(vk: u16) -> bool {
    send_key(vk, false) && send_key(vk, true)
}

fn send_ctrl_v() -> bool {
    send_key(VK_CONTROL as u16, false)
        && send_key(b'V' as u16, false)
        && send_key(b'V' as u16, true)
        && send_key(VK_CONTROL as u16, true)
}

fn send_backspaces(count: usize) -> bool {
    for _ in 0..count {
        if !send_key_press(VK_BACK as u16) {
            return false;
        }
    }
    true
}

fn default_input_available() -> bool {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return false;
    };
    device.default_input_config().is_ok()
}

fn list_input_devices_json() -> Result<String, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| format!("input_devices failed: {err}"))?;

    let mut out = serde_json::Map::new();
    for (index, device) in devices.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Input device {index}"));
        out.insert(index.to_string(), serde_json::Value::String(name));
    }

    serde_json::to_string(&out).map_err(|err| format!("serialize failed: {err}"))
}

fn pick_record_config(device: &cpal::Device) -> Result<(StreamConfig, SampleFormat), String> {
    if let Ok(ranges) = device.supported_input_configs() {
        let mut selected: Option<(StreamConfig, SampleFormat)> = None;
        for range in ranges {
            let channels = range.channels();
            if channels == 0 {
                continue;
            }
            let min = range.min_sample_rate().0;
            let max = range.max_sample_rate().0;
            let desired = if min <= 48_000 && 48_000 <= max {
                48_000
            } else {
                max
            };
            selected = Some((
                StreamConfig {
                    channels,
                    sample_rate: SampleRate(desired),
                    buffer_size: cpal::BufferSize::Default,
                },
                range.sample_format(),
            ));
            if desired == 48_000 && channels == 1 {
                break;
            }
        }
        if let Some(config) = selected {
            return Ok(config);
        }
    }

    let fallback = device
        .default_input_config()
        .map_err(|err| format!("default_input_config failed: {err}"))?;
    Ok((fallback.config(), fallback.sample_format()))
}

fn finalize_writer(
    writer: Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<File>>>>>,
) -> Result<(), String> {
    let mut guard = writer.lock().map_err(|_| "writer lock poisoned".to_string())?;
    if let Some(writer) = guard.take() {
        writer.finalize().map_err(|err| format!("finalize failed: {err}"))?;
    }
    Ok(())
}

fn write_frames_f32(
    data: &[f32],
    channels: usize,
    writer: &Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<File>>>>>,
) {
    if channels == 0 {
        return;
    }
    let Ok(mut guard) = writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().copied().sum();
        let mono = (sum / channels as f32).clamp(-1.0, 1.0);
        let sample = (mono * i16::MAX as f32) as i16;
        let _ = writer.write_sample(sample);
    }
}

fn write_frames_i16(
    data: &[i16],
    channels: usize,
    writer: &Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<File>>>>>,
) {
    if channels == 0 {
        return;
    }
    let Ok(mut guard) = writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };
    for frame in data.chunks(channels) {
        let sum: i32 = frame.iter().map(|sample| *sample as i32).sum();
        let mono = (sum / channels as i32) as i16;
        let _ = writer.write_sample(mono);
    }
}

fn write_frames_u16(
    data: &[u16],
    channels: usize,
    writer: &Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<File>>>>>,
) {
    if channels == 0 {
        return;
    }
    let Ok(mut guard) = writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };
    for frame in data.chunks(channels) {
        let sum: i64 = frame
            .iter()
            .map(|sample| *sample as i64 - 32_768)
            .sum();
        let mono = (sum / channels as i64) as i16;
        let _ = writer.write_sample(mono);
    }
}

fn record_to_wav(path: &str, device_index: usize, max_seconds: u64) -> Result<(), String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| format!("input_devices failed: {err}"))?
        .collect::<Vec<_>>();

    let Some(device) = devices.into_iter().nth(device_index) else {
        return Err("device index out of range".to_string());
    };

    let (config, sample_format) = pick_record_config(&device)?;
    let writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: config.sample_rate.0,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|err| format!("failed to create wav: {err}"))?;

    let writer = Arc::new(Mutex::new(Some(writer)));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let command_stop = stop_flag.clone();

    let stdin_thread = thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                command_stop.store(true, Ordering::SeqCst);
                return;
            };
            if line.trim().eq_ignore_ascii_case("stop") {
                command_stop.store(true, Ordering::SeqCst);
                return;
            }
        }
        command_stop.store(true, Ordering::SeqCst);
    });

    let err_fn = |err| {
        let _ = writeln!(io::stderr().lock(), "CodictateWindowsHelper record stream error: {err}");
    };

    let channels = config.channels as usize;
    let stream = match sample_format {
        SampleFormat::F32 => {
            let writer = writer.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| write_frames_f32(data, channels, &writer),
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let writer = writer.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| write_frames_i16(data, channels, &writer),
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let writer = writer.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| write_frames_u16(data, channels, &writer),
                err_fn,
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|err| format!("build_input_stream failed: {err}"))?;

    stream
        .play()
        .map_err(|err| format!("stream play failed: {err}"))?;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(max_seconds) {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    drop(stream);
    stop_flag.store(true, Ordering::SeqCst);
    let _ = stdin_thread.join();
    finalize_writer(writer)
}

fn handle_list_devices() -> ExitCode {
    match list_input_devices_json() {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("CodictateWindowsHelper --list-devices failed: {err}");
            ExitCode::from(1)
        }
    }
}

fn handle_mic_authorization() -> ExitCode {
    println!(
        "{}",
        json!({
            "microphone": default_input_available(),
        })
    );
    ExitCode::SUCCESS
}

fn handle_record(args: &[String]) -> ExitCode {
    if args.len() < 5 {
        eprintln!("CodictateWindowsHelper record <path> <deviceIndex> <maxSeconds>");
        return ExitCode::from(1);
    }

    let path = &args[2];
    let device_index = match args[3].parse::<usize>() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("Invalid device index: {err}");
            return ExitCode::from(1);
        }
    };
    let max_seconds = match args[4].parse::<u64>() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("Invalid maxSeconds: {err}");
            return ExitCode::from(1);
        }
    };

    match record_to_wav(path, device_index, max_seconds) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper record failed: {err}");
            ExitCode::from(1)
        }
    }
}

fn handle_keyboard_hook() -> ExitCode {
    let stdin = io::stdin();
    let mut clipboard = Clipboard::new().ok();
    let microphone = false;
    let accessibility = true;

    let shared = Arc::new(Mutex::new(HookState {
        swallow_rules: Vec::new(),
        active_combo: None,
        pressed_keys: HashSet::new(),
    }));
    let _ = HOOK_STATE.set(shared.clone());

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
                    let _ = emit_json(json!({
                        "status": "error",
                        "message": format!("Invalid keyboard-hook command: {err}"),
                    }));
                    continue;
                }
            };

            match command {
                KeyboardHookCommand::Configure { swallow } => {
                    if let Ok(mut state) = command_state.lock() {
                        state.swallow_rules = swallow;
                    }
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
                    let _ = emit_json(json!({
                        "type": "clipboard_set",
                        "success": success,
                    }));
                }
                KeyboardHookCommand::PasteText { text } => {
                    let clipboard_ok = clipboard
                        .as_mut()
                        .and_then(|clipboard| clipboard.set_text(text).ok())
                        .is_some();
                    let success = clipboard_ok && send_ctrl_v();
                    let _ = emit_json(json!({
                        "type": "paste_result",
                        "success": success,
                        "accessibility": accessibility,
                        "message": if success {
                            "Pasted text into the focused app."
                        } else if clipboard_ok {
                            "Clipboard updated, but simulated Ctrl+V failed."
                        } else {
                            "Clipboard update failed."
                        },
                    }));
                }
                KeyboardHookCommand::ReplaceText { delete_text, text } => {
                    let clipboard_ok = clipboard
                        .as_mut()
                        .and_then(|clipboard| clipboard.set_text(text).ok())
                        .is_some();
                    let deleted = send_backspaces(delete_text.chars().count());
                    let success = clipboard_ok && deleted && send_ctrl_v();
                    let _ = emit_json(json!({
                        "type": "paste_result",
                        "success": success,
                        "accessibility": accessibility,
                        "message": if success {
                            "Replaced text in the focused app."
                        } else {
                            "Windows replace_text could not complete."
                        },
                    }));
                }
                KeyboardHookCommand::RequestInputMonitoring => {
                    let _ = emit_json(json!({
                        "status": "permission_requested",
                        "message": "Windows does not require a separate Input Monitoring permission.",
                    }));
                }
                KeyboardHookCommand::PromptAccessibility => {
                    let _ = emit_json(json!({
                        "status": "permission_requested",
                        "message": "Windows keyboard hook and input injection are active without a separate accessibility prompt.",
                    }));
                }
                KeyboardHookCommand::RequestMicrophone => {
                    let _ = emit_json(json!({
                        "status": "permission_requested",
                        "message": "Microphone permission is handled by the Windows recorder helper.",
                    }));
                }
            }
        }

        let _ = unsafe { PostThreadMessageW(hook_thread_id, WM_QUIT, 0, 0) };
    });

    if emit_json(json!({
        "status": "started",
        "platform": "windows",
        "inputMonitoring": true,
        "microphone": microphone,
        "accessibility": accessibility,
    }))
    .is_err()
    {
        return ExitCode::from(1);
    }

    let hook = unsafe {
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), std::ptr::null_mut(), 0)
    };
    if hook.is_null() {
        let _ = emit_json(json!({
            "status": "error",
            "message": "SetWindowsHookExW(WH_KEYBOARD_LL) failed.",
        }));
        return ExitCode::from(1);
    }

    let mut message = MSG::default();
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

fn print_help() {
    println!("CodictateWindowsHelper");
    println!();
    println!("Windows helper entrypoint for Codictate.");
    println!("Implemented:");
    println!("  --list-devices");
    println!("  --mic-authorization");
    println!("  keyboard-hook");
    println!("  record <path> <deviceIndex> <maxSeconds>");
    println!();
    println!("Planned next:");
    println!("  focused-app");
}

fn main() -> ExitCode {
    let args = env::args().collect::<Vec<_>>();

    match args.get(1).map(String::as_str) {
        None | Some("--help") | Some("help") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some("--list-devices") => handle_list_devices(),
        Some("--mic-authorization") => handle_mic_authorization(),
        Some("keyboard-hook") => handle_keyboard_hook(),
        Some("record") => handle_record(&args),
        Some(command) => {
            eprintln!(
                "CodictateWindowsHelper: command '{command}' is not implemented yet."
            );
            ExitCode::from(1)
        }
    }
}
