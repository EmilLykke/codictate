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

/// Outside Hyprland the Linux keyboard-hook stays up with no shortcut
/// backend, answers commands, and exits cleanly on stdin EOF.
#[cfg(not(windows))]
#[test]
fn linux_keyboard_hook_without_hyprland_reports_unavailable_backend() {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = helper_command()
        .arg("keyboard-hook")
        .env_remove("HYPRLAND_INSTANCE_SIGNATURE")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("DISPLAY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            b"{\"command\":\"list_desktop_bindings\"}\n{\"command\":\"check_permissions\"}\n",
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());

    let lines = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines[0]["status"], "started");
    assert_eq!(lines[0]["platform"], "linux");
    assert_eq!(lines[0]["shortcutBackend"], "unavailable");
    assert_eq!(
        lines[1],
        serde_json::json!({"type": "desktop_bindings", "bindings": []})
    );
    assert_eq!(lines[2]["type"], "permissions");
}
