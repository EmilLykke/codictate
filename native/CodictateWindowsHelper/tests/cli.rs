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
