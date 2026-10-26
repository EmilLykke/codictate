//! Audio Ducking (GLOSSARY.md), Windows side. See `src/bun/utils/audio/audio-ducking.ts`.
//!
//!   duck <level 0-100> <speakers 0|1> <headphones 0|1> <delayMs> <stateFile> <excludePid>
//!   duck-restore <stateFile>
//!
//! Unlike macOS, Windows can lower other apps without lowering Codictate: every audio session
//! on the default output is lowered except the ones owned by `excludePid` (Codictate) and its
//! children (the chime player), and the system sounds. Sessions that appear after the start are
//! left alone. A session whose volume the user moves while it is lowered keeps the user's
//! volume. Windows remembers each app's volume, so a lowered session left behind by a killed
//! helper would stay lowered: the state file lets `duck-restore` put it back at the next launch.

use serde::{Deserialize, Serialize};
use std::process::ExitCode;

/// Within this of the volume we set, the user has not touched it.
const UNTOUCHED_TOLERANCE: f32 = 0.02;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutputKind {
    Speakers,
    Headphones,
}

/// `PKEY_AudioEndpoint_FormFactor` values from `EndpointFormFactor`.
const FORM_FACTOR_HEADPHONES: u32 = 3;
const FORM_FACTOR_HEADSET: u32 = 5;

pub(crate) fn output_kind(form_factor: Option<u32>, transport: &str) -> OutputKind {
    if matches!(
        form_factor,
        Some(FORM_FACTOR_HEADPHONES | FORM_FACTOR_HEADSET)
    ) || transport == "bluetooth"
        || transport == "usb"
    {
        OutputKind::Headphones
    } else {
        OutputKind::Speakers
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DuckedSession {
    /// Per app, stable across the app's restarts.
    identifier: String,
    /// Per running session.
    instance: String,
    saved: f32,
    ducked: f32,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DuckState {
    endpoint_id: String,
    sessions: Vec<DuckedSession>,
}

fn untouched(current: f32, ducked: f32) -> bool {
    (current - ducked).abs() <= UNTOUCHED_TOLERANCE
}

struct DuckArgs {
    level: u32,
    speakers: bool,
    headphones: bool,
    delay_ms: u64,
    state_path: String,
    exclude_pid: u32,
}

fn parse_duck_args(args: &[String]) -> Option<DuckArgs> {
    let flag = |value: &String| match value.as_str() {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    };
    let level = args.get(2)?.parse::<u32>().ok().filter(|v| *v <= 100)?;
    let delay_ms = args.get(5)?.parse::<u64>().ok().filter(|v| *v <= 10_000)?;
    Some(DuckArgs {
        level,
        speakers: flag(args.get(3)?)?,
        headphones: flag(args.get(4)?)?,
        delay_ms,
        state_path: args.get(6)?.clone(),
        exclude_pid: args.get(7)?.parse().ok()?,
    })
}

const USAGE: &str = "CodictateWindowsHelper duck <level 0-100> <speakers 0|1> <headphones 0|1> <delayMs> <stateFile> <excludePid>";

pub fn handle_duck(args: &[String]) -> ExitCode {
    let Some(args) = parse_duck_args(args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match platform::duck(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper duck failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_duck_restore(args: &[String]) -> ExitCode {
    let Some(state_path) = args.get(2) else {
        eprintln!("CodictateWindowsHelper duck-restore <stateFile>");
        return ExitCode::from(2);
    };
    let Ok(text) = std::fs::read_to_string(state_path) else {
        return ExitCode::SUCCESS;
    };
    let result = match serde_json::from_str::<DuckState>(&text) {
        Ok(state) => platform::restore_from_state(&state),
        Err(err) => Err(format!("unreadable {state_path}: {err}")),
    };
    let _ = std::fs::remove_file(state_path);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper duck-restore failed: {err}");
            ExitCode::from(1)
        }
    }
}

/// Resolves on a `stop` line or the end of stdin, whichever comes first.
fn spawn_stdin_stop() -> crossbeam_channel::Receiver<()> {
    use std::io::BufRead;
    let (tx, rx) = crossbeam_channel::bounded::<()>(1);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) if !line.trim().eq_ignore_ascii_case("stop") => continue,
                _ => break,
            }
        }
        let _ = tx.send(());
    });
    rx
}

#[cfg(windows)]
mod platform {
    use super::{
        DuckArgs, DuckState, DuckedSession, OutputKind, output_kind, spawn_stdin_stop, untouched,
    };
    use crate::audio::com::{ComApartment, pwstr_to_string_and_free, to_wide};
    use crate::audio::devices::endpoint_transport;
    use std::collections::HashSet;
    use std::time::Duration;
    use windows::Win32::Foundation::{CloseHandle, S_OK};
    use windows::Win32::Media::Audio::{
        AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
        IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, PKEY_AudioEndpoint_FormFactor,
        eConsole, eRender,
    };
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToUInt32};
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, STGM_READ};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::core::{Interface, PCWSTR};

    struct LiveSession {
        volume: ISimpleAudioVolume,
        state: DuckedSession,
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|err| format!("CoCreateInstance(MMDeviceEnumerator) failed: {err}"))
    }

    fn form_factor(device: &IMMDevice) -> Option<u32> {
        let store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
        let mut value = unsafe { store.GetValue(&PKEY_AudioEndpoint_FormFactor) }.ok()?;
        let form_factor = unsafe { PropVariantToUInt32(&value) }.ok();
        let _ = unsafe { PropVariantClear(&mut value) };
        form_factor
    }

    /// `pid` and every process it started, as of now.
    fn process_tree(pid: u32) -> HashSet<u32> {
        let mut pids = HashSet::from([pid, std::process::id()]);
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return pids;
        };
        let mut parents = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(snapshot) };
        // Children of children too: a chime player may be a shell's child.
        loop {
            let before = pids.len();
            for (child, parent) in &parents {
                if pids.contains(parent) {
                    pids.insert(*child);
                }
            }
            if pids.len() == before {
                return pids;
            }
        }
    }

    /// Every live session on `device` that is not the system sounds, with its volume.
    fn sessions(
        device: &IMMDevice,
    ) -> Result<Vec<(IAudioSessionControl2, ISimpleAudioVolume)>, String> {
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|err| format!("Activate(IAudioSessionManager2) failed: {err}"))?;
        let list = unsafe { manager.GetSessionEnumerator() }
            .map_err(|err| format!("GetSessionEnumerator failed: {err}"))?;
        let count = unsafe { list.GetCount() }.map_err(|err| format!("GetCount failed: {err}"))?;
        let mut out = Vec::new();
        for index in 0..count {
            let Ok(control) = (unsafe { list.GetSession(index) }) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            if unsafe { control2.GetState() }.ok() == Some(AudioSessionStateExpired)
                || unsafe { control2.IsSystemSoundsSession() } == S_OK
            {
                continue;
            }
            let Ok(volume) = control.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            out.push((control2, volume));
        }
        Ok(out)
    }

    fn set_volume(volume: &ISimpleAudioVolume, value: f32) {
        let _ = unsafe { volume.SetMasterVolume(value.clamp(0.0, 1.0), std::ptr::null()) };
    }

    /// 40 ms for every session at once: too short to hear as a fade, long enough not to click.
    fn ramp(moves: &[(&ISimpleAudioVolume, f32, f32)]) {
        const STEPS: u32 = 8;
        for step in 1..=STEPS {
            let t = step as f32 / STEPS as f32;
            for (volume, from, to) in moves {
                set_volume(volume, from + (to - from) * t);
            }
            if step < STEPS {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    fn restore(live: &[LiveSession]) {
        let moves = live
            .iter()
            .filter_map(|session| {
                let current = unsafe { session.volume.GetMasterVolume() }.ok()?;
                untouched(current, session.state.ducked).then_some((
                    &session.volume,
                    current,
                    session.state.saved,
                ))
            })
            .collect::<Vec<_>>();
        ramp(&moves);
    }

    pub(super) fn duck(args: &DuckArgs) -> Result<(), String> {
        let stop = spawn_stdin_stop();
        // Stopped before the delay ran out: nothing was lowered.
        if stop
            .recv_timeout(Duration::from_millis(args.delay_ms))
            .is_ok()
        {
            return Ok(());
        }

        let _com = ComApartment::init()?;
        let device = unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|err| format!("no default output: {err}"))?;
        let kind = output_kind(form_factor(&device), endpoint_transport(&device));
        let enabled = match kind {
            OutputKind::Speakers => args.speakers,
            OutputKind::Headphones => args.headphones,
        };
        if !enabled {
            let _ = stop.recv();
            return Ok(());
        }

        let endpoint_id = pwstr_to_string_and_free(
            unsafe { device.GetId() }.map_err(|err| format!("GetId failed: {err}"))?,
        );
        let excluded = process_tree(args.exclude_pid);
        let target = args.level as f32 / 100.0;
        let mut live = Vec::new();
        for (control, volume) in sessions(&device)? {
            let Ok(pid) = (unsafe { control.GetProcessId() }) else {
                continue;
            };
            if excluded.contains(&pid) {
                continue;
            }
            let Ok(current) = (unsafe { volume.GetMasterVolume() }) else {
                continue;
            };
            if target + super::UNTOUCHED_TOLERANCE >= current {
                continue;
            }
            let (Ok(identifier), Ok(instance)) =
                (unsafe { control.GetSessionIdentifier() }, unsafe {
                    control.GetSessionInstanceIdentifier()
                })
            else {
                continue;
            };
            live.push(LiveSession {
                volume,
                state: DuckedSession {
                    identifier: pwstr_to_string_and_free(identifier),
                    instance: pwstr_to_string_and_free(instance),
                    saved: current,
                    ducked: target,
                },
            });
        }
        if live.is_empty() {
            let _ = stop.recv();
            return Ok(());
        }

        let state = DuckState {
            endpoint_id,
            sessions: live.iter().map(|session| session.state.clone()).collect(),
        };
        let json = serde_json::to_string(&state).map_err(|err| err.to_string())?;
        if let Some(dir) = std::path::Path::new(&args.state_path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&args.state_path, json)
            .map_err(|err| format!("cannot write {}: {err}", args.state_path))?;

        let moves = live
            .iter()
            .map(|session| (&session.volume, session.state.saved, target))
            .collect::<Vec<_>>();
        ramp(&moves);

        let _ = stop.recv();
        restore(&live);
        let _ = std::fs::remove_file(&args.state_path);
        Ok(())
    }

    /// After a killed helper: put back every session still at the volume it was lowered to.
    /// Matched by instance first, then by app, since the app may have restarted since.
    pub(super) fn restore_from_state(state: &DuckState) -> Result<(), String> {
        let _com = ComApartment::init()?;
        let id = to_wide(&state.endpoint_id);
        let Ok(device) = (unsafe { enumerator()?.GetDevice(PCWSTR(id.as_ptr())) }) else {
            return Ok(());
        };
        let mut live = Vec::new();
        for (control, volume) in sessions(&device)? {
            let (Ok(identifier), Ok(instance)) =
                (unsafe { control.GetSessionIdentifier() }, unsafe {
                    control.GetSessionInstanceIdentifier()
                })
            else {
                continue;
            };
            let identifier = pwstr_to_string_and_free(identifier);
            let instance = pwstr_to_string_and_free(instance);
            let saved = state
                .sessions
                .iter()
                .find(|session| session.instance == instance)
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| session.identifier == identifier)
                });
            if let Some(saved) = saved {
                live.push(LiveSession {
                    volume,
                    state: saved.clone(),
                });
            }
        }
        restore(&live);
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{DuckArgs, DuckState};

    pub(super) fn duck(_args: &DuckArgs) -> Result<(), String> {
        Err("Audio Ducking is only available on Windows in this helper".to_string())
    }

    pub(super) fn restore_from_state(_state: &DuckState) -> Result<(), String> {
        Err("Audio Ducking is only available on Windows in this helper".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn headphones_by_form_factor_or_bus() {
        assert_eq!(output_kind(Some(3), "built-in"), OutputKind::Headphones);
        assert_eq!(output_kind(Some(5), "other"), OutputKind::Headphones);
        assert_eq!(output_kind(Some(1), "bluetooth"), OutputKind::Headphones);
        assert_eq!(output_kind(None, "usb"), OutputKind::Headphones);
        assert_eq!(output_kind(Some(1), "built-in"), OutputKind::Speakers);
        assert_eq!(output_kind(Some(9), "other"), OutputKind::Speakers);
    }

    #[test]
    fn the_users_volume_wins() {
        assert!(untouched(0.0, 0.0));
        assert!(untouched(0.015, 0.0));
        assert!(!untouched(0.3, 0.0));
    }

    #[test]
    fn parses_the_duck_argv() {
        let parsed = parse_duck_args(&args(&[
            "helper",
            "duck",
            "20",
            "1",
            "0",
            "0",
            "C:\\state.json",
            "42",
        ]))
        .unwrap();
        assert_eq!(parsed.level, 20);
        assert!(parsed.speakers);
        assert!(!parsed.headphones);
        assert_eq!(parsed.delay_ms, 0);
        assert_eq!(parsed.state_path, "C:\\state.json");
        assert_eq!(parsed.exclude_pid, 42);
        assert!(
            parse_duck_args(&args(&["helper", "duck", "101", "1", "0", "0", "s", "1"])).is_none()
        );
        assert!(
            parse_duck_args(&args(&["helper", "duck", "20", "2", "0", "0", "s", "1"])).is_none()
        );
        assert!(parse_duck_args(&args(&["helper", "duck", "20", "1", "0"])).is_none());
    }

    #[test]
    fn state_round_trips_in_camel_case() {
        let state = DuckState {
            endpoint_id: "{0.0.0.00000000}.{abc}".to_string(),
            sessions: vec![DuckedSession {
                identifier: "app".to_string(),
                instance: "app|1".to_string(),
                saved: 0.8,
                ducked: 0.0,
            }],
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"endpointId\""));
        assert_eq!(serde_json::from_str::<DuckState>(&json).unwrap(), state);
    }
}
