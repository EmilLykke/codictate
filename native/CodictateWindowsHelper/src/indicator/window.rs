use super::draw::{
    INDICATOR_FRAME_MS, INDICATOR_TIMER_ID, IndicatorAnimation, draw_indicator_content, rgb,
};
use super::protocol::{
    IndicatorCommand, IndicatorStartedMessage, IndicatorStatus, MoveMessage, StatusMessage,
};
use crate::ipc::emit_json;
use std::io::{self, BufRead};
use std::process::ExitCode;
use std::sync::{Mutex, OnceLock};
use std::thread;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BLACK_BRUSH, BeginPaint, EndPaint, FillRect, GetStockObject, InvalidateRect, PAINTSTRUCT,
    UpdateWindow,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, GetWindowRect,
    HTCAPTION, HWND_TOPMOST, KillTimer, LWA_COLORKEY, MSG, PostMessageW, PostQuitMessage,
    RegisterClassW, SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SetLayeredWindowAttributes, SetTimer,
    SetWindowPos, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE, WM_DESTROY, WM_MOVE,
    WM_NCHITTEST, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

static INDICATOR_STATE: OnceLock<Mutex<IndicatorState>> = OnceLock::new();
static INDICATOR_ANIMATION: OnceLock<Mutex<IndicatorAnimation>> = OnceLock::new();

const WM_INDICATOR_COMMAND: u32 = WM_APP + 1;

#[derive(Clone, Copy)]
struct IndicatorFrame {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Default for IndicatorFrame {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 72,
            height: 72,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct IndicatorState {
    visible: bool,
    frame: IndicatorFrame,
    status: IndicatorStatus,
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn state_snapshot() -> IndicatorState {
    INDICATOR_STATE
        .get()
        .and_then(|state| state.lock().ok().map(|state| *state))
        .unwrap_or_default()
}

fn animation_frame() -> (f32, f32) {
    INDICATOR_ANIMATION
        .get()
        .and_then(|animation| animation.lock().ok().map(|animation| animation.frame()))
        .unwrap_or((0.0, 38.0 / 56.0))
}

unsafe extern "system" fn indicator_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            let mut rect = RECT::default();
            unsafe {
                GetClientRect(hwnd, &mut rect);
                FillRect(hdc, &rect, GetStockObject(BLACK_BRUSH) as _);
            }

            let status = state_snapshot().status;
            let (animation_time, current_scale) = animation_frame();
            draw_indicator_content(hdc, status, rect, animation_time, current_scale);
            unsafe { EndPaint(hwnd, &paint) };
            0
        }
        WM_TIMER => {
            if wparam == INDICATOR_TIMER_ID {
                let status = state_snapshot().status;
                if let Some(animation) = INDICATOR_ANIMATION.get()
                    && let Ok(mut animation) = animation.lock()
                {
                    animation.update(status);
                }
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_INDICATOR_COMMAND => {
            if wparam != 0 {
                let command = unsafe { Box::from_raw(wparam as *mut IndicatorCommand) };
                apply_indicator_command(hwnd, *command);
            }
            0
        }
        WM_NCHITTEST => HTCAPTION as LRESULT,
        WM_MOVE => {
            let visible = state_snapshot().visible;
            let mut rect = RECT::default();
            if visible && unsafe { GetWindowRect(hwnd, &mut rect) } != 0 {
                let _ = emit_json(&MoveMessage::new(rect.left, rect.top));
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_DESTROY => {
            unsafe { KillTimer(hwnd, INDICATOR_TIMER_ID) };
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn apply_indicator_state(hwnd: HWND, state: &IndicatorState) {
    unsafe {
        InvalidateRect(hwnd, std::ptr::null(), 1);
        if state.visible {
            if let Some(animation) = INDICATOR_ANIMATION.get()
                && let Ok(mut animation) = animation.lock()
            {
                animation.reset_tick();
            }
            SetTimer(hwnd, INDICATOR_TIMER_ID, INDICATOR_FRAME_MS, None);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                state.frame.x,
                state.frame.y,
                state.frame.width,
                state.frame.height,
                SWP_NOACTIVATE,
            );
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
        } else {
            KillTimer(hwnd, INDICATOR_TIMER_ID);
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn apply_indicator_command(hwnd: HWND, command: IndicatorCommand) {
    let should_close = matches!(command, IndicatorCommand::Quit);
    let mut snapshot = None;
    if let Some(state) = INDICATOR_STATE.get()
        && let Ok(mut state) = state.lock()
    {
        match command {
            IndicatorCommand::Show {
                x,
                y,
                width,
                height,
                status,
            } => {
                state.visible = true;
                state.frame = IndicatorFrame {
                    x,
                    y,
                    width: width.max(24),
                    height: height.max(24),
                };
                state.status = status;
            }
            IndicatorCommand::Hide => state.visible = false,
            IndicatorCommand::Status { status } => state.status = status,
            IndicatorCommand::Quit => state.visible = false,
        }
        snapshot = Some(*state);
    }

    if let Some(state) = snapshot {
        apply_indicator_state(hwnd, &state);
    }

    if should_close {
        let _ = unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
    }
}

fn post_indicator_command(hwnd: HWND, command: IndicatorCommand) -> bool {
    let raw = Box::into_raw(Box::new(command));
    let posted = unsafe { PostMessageW(hwnd, WM_INDICATOR_COMMAND, raw as WPARAM, 0) } != 0;
    if !posted {
        unsafe { drop(Box::from_raw(raw)) };
    }
    posted
}

fn spawn_indicator_command_thread(hwnd_value: isize) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let hwnd = hwnd_value as HWND;
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let command = match serde_json::from_str::<IndicatorCommand>(trimmed) {
                Ok(command) => command,
                Err(err) => {
                    let _ = emit_json(&StatusMessage::error(format!(
                        "Invalid indicator command: {err}"
                    )));
                    continue;
                }
            };

            let should_exit = matches!(command, IndicatorCommand::Quit);
            if !post_indicator_command(hwnd, command) || should_exit {
                return;
            }
        }

        let _ = post_indicator_command(hwnd, IndicatorCommand::Quit);
    })
}

pub fn handle_indicator() -> ExitCode {
    let _ = INDICATOR_STATE.set(Mutex::new(IndicatorState::default()));
    let _ = INDICATOR_ANIMATION.set(Mutex::new(IndicatorAnimation::default()));
    let class_name = to_wide("CodictateWindowsIndicator");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(indicator_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: unsafe { GetStockObject(BLACK_BRUSH) as _ },
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    unsafe { RegisterClassW(&wc) };

    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_POPUP,
            0,
            0,
            72,
            72,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null_mut(),
        )
    };

    if hwnd.is_null() {
        let _ = emit_json(&StatusMessage::error(
            "CreateWindowExW failed for Windows indicator.",
        ));
        return ExitCode::from(1);
    }

    unsafe {
        SetLayeredWindowAttributes(hwnd, rgb(0, 0, 0), 0, LWA_COLORKEY);
        ShowWindow(hwnd, SW_HIDE);
    }

    let command_thread = spawn_indicator_command_thread(hwnd as isize);

    let _ = emit_json(&IndicatorStartedMessage::new());

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

    let _ = command_thread.join();
    ExitCode::SUCCESS
}
