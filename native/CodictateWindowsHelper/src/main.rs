use std::env;
use std::process::ExitCode;

mod asr;
mod audio;
mod indicator;
mod ipc;
mod keyboard;

fn print_help() {
    println!("CodictateWindowsHelper");
    println!();
    println!("Windows helper entrypoint for Codictate.");
    println!("Implemented:");
    println!("  --list-devices");
    println!("  --mic-authorization");
    println!("  indicator");
    println!("  keyboard-hook");
    println!("  record <path> <deviceIndexOrEndpointId> <maxSeconds>");
    println!("  transcribe <wavPath> <parakeetModelDir>");
    println!("  stream <vad|live> <parakeetModelDir>");
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
        Some("--list-devices") => audio::handle_list_devices(),
        Some("--mic-authorization") => audio::handle_mic_authorization(),
        Some("indicator") => indicator::handle_indicator(),
        Some("keyboard-hook") => keyboard::handle_keyboard_hook(),
        Some("record") => audio::handle_record(&args),
        Some("transcribe") => asr::handle_transcribe(&args),
        Some("stream") => asr::handle_stream(&args),
        Some(command) => {
            eprintln!("CodictateWindowsHelper: command '{command}' is not implemented yet.");
            ExitCode::from(1)
        }
    }
}
