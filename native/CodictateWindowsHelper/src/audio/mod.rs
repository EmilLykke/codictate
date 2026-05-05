mod capture;
mod com;
mod devices;
mod resample;
mod wav;

use crate::ipc::emit_json;
use serde::Serialize;
use std::process::ExitCode;

pub use devices::default_input_available;

#[derive(Serialize)]
struct MicrophoneAuthorizationMessage {
    microphone: bool,
}

pub fn handle_list_devices() -> ExitCode {
    match devices::list_input_device_map() {
        Ok(devices) => match emit_json(&devices) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("CodictateWindowsHelper --list-devices failed to write JSON: {err}");
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("CodictateWindowsHelper --list-devices failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_mic_authorization() -> ExitCode {
    let message = MicrophoneAuthorizationMessage {
        microphone: default_input_available(),
    };
    match emit_json(&message) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper --mic-authorization failed to write JSON: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_record(args: &[String]) -> ExitCode {
    if args.len() < 5 {
        eprintln!("CodictateWindowsHelper record <path> <deviceIndexOrEndpointId> <maxSeconds>");
        return ExitCode::from(1);
    }

    let path = &args[2];
    let device_ref = &args[3];
    let max_seconds = match args[4].parse::<u64>() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("Invalid maxSeconds: {err}");
            return ExitCode::from(1);
        }
    };

    match capture::record_to_wav(path, device_ref, max_seconds) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper record failed: {err}");
            ExitCode::from(1)
        }
    }
}
