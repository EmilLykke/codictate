use std::process::Command;

fn helper_command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_CodictateWindowsHelper"))
}

#[test]
fn help_smoke_test() {
    let output = helper_command().arg("--help").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("CodictateWindowsHelper"));
    assert!(stdout.contains("record <path> <deviceIndexOrEndpointId> <maxSeconds>"));
    assert!(stdout.contains("extract-audio <input> <output.wav>"));
}

#[test]
fn extract_audio_without_paths_is_a_usage_error() {
    let output = helper_command().arg("extract-audio").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.trim().starts_with("usage: "));
    assert_eq!(stderr.trim().lines().count(), 1);
}

#[test]
fn extract_audio_of_a_missing_file_is_unreadable_media() {
    let dir = std::env::temp_dir();
    let input = dir.join(format!("codictate-cli-missing-{}.mp4", std::process::id()));
    let wav = dir.join(format!("codictate-cli-missing-{}.wav", std::process::id()));
    let output = helper_command()
        .arg("extract-audio")
        .arg(&input)
        .arg(&wav)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert!(!wav.exists());
}

#[test]
fn list_devices_smoke_test_when_available() {
    let output = helper_command().arg("--list-devices").output().unwrap();
    if !output.status.success() {
        return;
    }

    let stdout = String::from_utf8(output.stdout).unwrap();
    let parsed = serde_json::from_str::<serde_json::Value>(stdout.trim()).unwrap();
    assert!(parsed.is_object());
}
