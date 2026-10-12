//! Finding the app this client ships in, and starting it hidden (docs/CLI.md "Where the
//! client lives" and "Hidden launch").

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::failure::Failure;

/// Points the client at an app bundle (`<App>.app` on macOS, the install directory on
/// Windows) when it does not run from inside one: development builds and tests.
pub const APP_BUNDLE_ENV: &str = "CODICTATE_APP_BUNDLE";
/// Replaces `<data>` (where the socket and the hidden-launch marker live). Tests only.
pub const DATA_DIR_ENV: &str = "CODICTATE_DATA_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// `<App>.app/Contents/Resources/app/bin/codictate`
    MacOs,
    /// `<install>/Resources/app/bin/codictate.exe` (Electrobun's Windows and Linux tree)
    Install,
}

impl Layout {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Layout::MacOs
        } else {
            Layout::Install
        }
    }

    fn resources(self, bundle: &Path) -> PathBuf {
        match self {
            Layout::MacOs => bundle.join("Contents").join("Resources"),
            Layout::Install => bundle.join("Resources"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    /// `<App>.app` on macOS, `<install>` on Windows.
    pub bundle: PathBuf,
    pub version: String,
    pub channel: String,
    pub identifier: String,
}

fn name_is(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(expected))
}

/// The bundle an installed client sits in, from its own (symlink-resolved) path.
pub fn bundle_from_exe(exe: &Path, layout: Layout) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let app = bin.parent()?;
    let resources = app.parent()?;
    if !name_is(bin, "bin") || !name_is(app, "app") || !name_is(resources, "Resources") {
        return None;
    }
    match layout {
        Layout::MacOs => {
            let contents = resources.parent()?;
            let bundle = contents.parent()?;
            let is_app = bundle
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"));
            (name_is(contents, "Contents") && is_app).then(|| bundle.to_path_buf())
        }
        Layout::Install => resources.parent().map(Path::to_path_buf),
    }
}

pub fn version_json_path(bundle: &Path, layout: Layout) -> PathBuf {
    layout.resources(bundle).join("version.json")
}

/// `version`, `channel` and `identifier` from the bundle's `Resources/version.json`.
pub fn parse_version_json(bundle: PathBuf, text: &str) -> Result<AppInfo, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("version.json is not JSON: {e}"))?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("version.json has no {key}"))
    };
    Ok(AppInfo {
        bundle,
        version: field("version")?,
        channel: field("channel")?,
        identifier: field("identifier")?,
    })
}

/// Windows `canonicalize` returns `\\?\C:\...`; hand the plain form to other programs.
pub fn simplify_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            rest.to_string()
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    }
}

fn locate_bundle() -> Result<PathBuf, Failure> {
    if let Some(bundle) = std::env::var_os(APP_BUNDLE_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(bundle));
    }
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| Failure::app_unavailable(format!("cannot find this executable: {e}")))?;
    let exe = PathBuf::from(simplify_verbatim(&exe.to_string_lossy()));
    bundle_from_exe(&exe, Layout::current()).ok_or_else(|| {
        Failure::app_unavailable(format!(
            "{} is not inside a Codictate app, so there is no app to talk to (a development build needs {APP_BUNDLE_ENV})",
            exe.display()
        ))
    })
}

/// The app this client belongs to.
pub fn discover() -> Result<AppInfo, Failure> {
    let bundle = locate_bundle()?;
    let path = version_json_path(&bundle, Layout::current());
    let text = std::fs::read_to_string(&path)
        .map_err(|e| Failure::app_unavailable(format!("cannot read {}: {e}", path.display())))?;
    parse_version_json(bundle, &text)
        .map_err(|e| Failure::app_unavailable(format!("{}: {e}", path.display())))
}

/// `<data>`: `~/Library/Application Support/codictate` on macOS,
/// `%LOCALAPPDATA%\codictate` on Windows.
pub fn data_dir() -> Result<PathBuf, Failure> {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let env_dir = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| Failure::app_unavailable(format!("{name} is not set")))
    };
    if cfg!(target_os = "macos") {
        Ok(env_dir("HOME")?
            .join("Library")
            .join("Application Support")
            .join("codictate"))
    } else if cfg!(windows) {
        Ok(env_dir("LOCALAPPDATA")?.join("codictate"))
    } else {
        Ok(env_dir("HOME")?
            .join(".local")
            .join("share")
            .join("codictate"))
    }
}

pub fn run_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("run")
}

/// `sun_path` is 104 bytes on macOS, NUL included. The app (`src/bun/command-line/endpoint.ts`)
/// applies the same limit, in UTF-8 bytes, so both sides pick one path.
pub const MAX_SOCKET_PATH_BYTES: usize = 103;

/// macOS: where the Unix domain socket the app listens on lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketPath {
    pub path: PathBuf,
    /// `/tmp/codictate-<uid>` when `<data>/run/<identifier>.sock` is too long for a socket.
    /// Anyone can create a name in /tmp, so it is checked before every connect.
    pub shared_dir: Option<PathBuf>,
}

/// `<data>/run/<identifier>.sock`, or `/tmp/codictate-<uid>/<identifier>.sock` when that is
/// longer than 103 bytes (docs/CLI.md "Transport").
#[cfg_attr(windows, allow(dead_code))]
pub fn socket_path(data_dir: &Path, identifier: &str, uid: u32) -> SocketPath {
    let name = format!("{identifier}.sock");
    let preferred = run_dir(data_dir).join(&name);
    if preferred.as_os_str().as_encoded_bytes().len() <= MAX_SOCKET_PATH_BYTES {
        return SocketPath {
            path: preferred,
            shared_dir: None,
        };
    }
    let dir = PathBuf::from(format!("/tmp/codictate-{uid}"));
    SocketPath {
        path: dir.join(name),
        shared_dir: Some(dir),
    }
}

/// Whether the shared socket directory may be used: `Ok(false)` when it does not exist yet
/// (the app creates it), `Ok(true)` when it is a real directory owned by `uid` with mode
/// exactly 0700, and the reason it is refused otherwise.
#[cfg(unix)]
pub fn check_shared_socket_dir(dir: &Path, uid: u32) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("cannot read {}: {e}", dir.display())),
    };
    let refuse = |why: String| {
        Err(format!(
            "refusing {}: {why} (it must be your own directory with mode 0700)",
            dir.display()
        ))
    };
    if !meta.is_dir() {
        return refuse("not a directory".to_string());
    }
    if meta.uid() != uid {
        return refuse(format!("owned by uid {}, not {uid}", meta.uid()));
    }
    let mode = meta.mode() & 0o7777;
    if mode != 0o700 {
        return refuse(format!("mode {mode:04o}, not 0700"));
    }
    Ok(true)
}

/// Windows: the named pipe the app listens on. `username` is `GetUserNameW`, as the app
/// reads it through `os.userInfo()`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_name(identifier: &str, username: &str) -> String {
    format!(r"\\.\pipe\{identifier}.{username}")
}

pub fn hidden_launch_marker(data_dir: &Path, identifier: &str) -> PathBuf {
    run_dir(data_dir).join(format!("{identifier}.hidden-launch"))
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Tells the app it is being started by the command line, so it opens no window.
pub fn write_hidden_launch_marker(data_dir: &Path, identifier: &str) -> std::io::Result<()> {
    create_private_dir(&run_dir(data_dir))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::fs::write(hidden_launch_marker(data_dir, identifier), now.to_string())
}

/// Starts the app: `open -g <App>.app` on macOS, `<install>\bin\launcher.exe` detached on
/// Windows. Returns once the start is requested; the caller polls for the socket.
pub fn launch(app: &AppInfo) -> Result<(), Failure> {
    platform::launch(app)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::{Command, Stdio};

    pub fn launch(app: &AppInfo) -> Result<(), Failure> {
        let output = Command::new("/usr/bin/open")
            .arg("-g")
            .arg(&app.bundle)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| Failure::app_unavailable(format!("cannot run open: {e}")))?;
        if output.status.success() {
            return Ok(());
        }
        Err(launch_failure(
            &app.bundle,
            &String::from_utf8_lossy(&output.stderr),
        ))
    }
}

/// `open`'s complaint as one line: an error is one `codictate: ` line (docs/CLI.md
/// "Output"), and `open` can print its whole usage text.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn launch_failure(bundle: &Path, stderr: &str) -> Failure {
    let detail = stderr.lines().map(str::trim).find(|l| !l.is_empty());
    Failure::app_unavailable(match detail {
        Some(detail) => format!("cannot start {}: {detail}", bundle.display()),
        None => format!("cannot start {}", bundle.display()),
    })
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    use std::process::{Command, Stdio};

    #[cfg(windows)]
    const LAUNCHER: &str = "launcher.exe";
    #[cfg(not(windows))]
    const LAUNCHER: &str = "launcher";

    fn command(app: &AppInfo) -> Command {
        let bin = app.bundle.join("bin");
        let mut command = Command::new(bin.join(LAUNCHER));
        command
            .current_dir(&bin)
            .env_remove(APP_BUNDLE_ENV)
            .env_remove(DATA_DIR_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    pub fn launch(app: &AppInfo) -> Result<(), Failure> {
        use std::os::windows::process::CommandExt;
        // No console, its own process group (so the terminal's Ctrl-C does not reach the
        // app), and out of the terminal's job object when the job allows it, so the app
        // outlives the terminal window.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        let spawned = command(app)
            .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| command(app).creation_flags(flags).spawn());
        spawned.map(drop).map_err(|e| {
            Failure::app_unavailable(format!(
                "cannot start {}: {e}",
                app.bundle.join("bin").join(LAUNCHER).display()
            ))
        })
    }

    #[cfg(not(windows))]
    pub fn launch(app: &AppInfo) -> Result<(), Failure> {
        command(app).spawn().map(drop).map_err(|e| {
            Failure::app_unavailable(format!(
                "cannot start {}: {e}",
                app.bundle.join("bin").join(LAUNCHER).display()
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_mac_bundle_four_levels_above_bin() {
        let exe = Path::new("/Applications/Codictate.app/Contents/Resources/app/bin/codictate");
        assert_eq!(
            bundle_from_exe(exe, Layout::MacOs),
            Some(PathBuf::from("/Applications/Codictate.app"))
        );
        assert_eq!(
            version_json_path(Path::new("/Applications/Codictate.app"), Layout::MacOs),
            PathBuf::from("/Applications/Codictate.app/Contents/Resources/version.json")
        );
    }

    #[test]
    fn rejects_a_mac_path_outside_a_bundle() {
        for exe in [
            "/Users/me/codictate/native/codictate-cli/target/release/codictate",
            "/usr/local/bin/codictate",
            "/tmp/Codictate/Contents/Resources/app/bin/codictate",
            "/Applications/Codictate.app/Contents/Resources/bin/codictate",
            "codictate",
        ] {
            assert_eq!(
                bundle_from_exe(Path::new(exe), Layout::MacOs),
                None,
                "{exe}"
            );
        }
    }

    #[test]
    fn finds_the_windows_install_dir() {
        let exe = Path::new(
            "/Users/me/AppData/Local/app.codictate/stable/app/Resources/app/bin/codictate.exe",
        );
        assert_eq!(
            bundle_from_exe(exe, Layout::Install),
            Some(PathBuf::from(
                "/Users/me/AppData/Local/app.codictate/stable/app"
            ))
        );
        assert_eq!(
            version_json_path(Path::new("/install"), Layout::Install),
            PathBuf::from("/install/Resources/version.json")
        );
        assert_eq!(
            bundle_from_exe(Path::new("/target/release/codictate.exe"), Layout::Install),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn finds_the_windows_install_dir_with_backslashes() {
        let exe = Path::new(
            r"C:\Users\me\AppData\Local\app.codictate\stable\app\Resources\app\bin\codictate.exe",
        );
        assert_eq!(
            bundle_from_exe(exe, Layout::Install),
            Some(PathBuf::from(
                r"C:\Users\me\AppData\Local\app.codictate\stable\app"
            ))
        );
    }

    #[test]
    fn reads_version_json() {
        let info = parse_version_json(
            PathBuf::from("/A.app"),
            include_str!("../tests/fixtures/version.json"),
        )
        .unwrap();
        assert_eq!(info.version, "0.0.62");
        assert_eq!(info.channel, "stable");
        assert_eq!(info.identifier, "app.codictate");
        assert_eq!(info.bundle, PathBuf::from("/A.app"));
    }

    #[test]
    fn version_json_without_identifier_is_refused() {
        assert!(parse_version_json(PathBuf::new(), r#"{"version":"1","channel":"dev"}"#).is_err());
        assert!(parse_version_json(PathBuf::new(), "nope").is_err());
    }

    #[test]
    fn endpoints_follow_the_contract() {
        let data = Path::new("/Users/me/Library/Application Support/codictate");
        assert_eq!(
            socket_path(data, "app.codictate", 501),
            SocketPath {
                path: PathBuf::from(
                    "/Users/me/Library/Application Support/codictate/run/app.codictate.sock"
                ),
                shared_dir: None,
            }
        );
        assert_eq!(
            hidden_launch_marker(data, "app.codictate.canary"),
            PathBuf::from(
                "/Users/me/Library/Application Support/codictate/run/app.codictate.canary.hidden-launch"
            )
        );
        assert_eq!(
            pipe_name("app.codictate", "emil"),
            r"\\.\pipe\app.codictate.emil"
        );
    }

    // The app's endpoint test pins the same boundary.
    #[test]
    fn a_socket_path_past_103_bytes_moves_to_tmp() {
        let suffix = "/run/app.codictate.sock";
        let fits = format!("/U{}", "x".repeat(MAX_SOCKET_PATH_BYTES - suffix.len() - 2));
        let at_limit = socket_path(Path::new(&fits), "app.codictate", 501);
        assert_eq!(at_limit.path.as_os_str().len(), 103);
        assert_eq!(at_limit.shared_dir, None);

        let too_long = socket_path(Path::new(&format!("{fits}x")), "app.codictate", 501);
        assert_eq!(
            too_long,
            SocketPath {
                path: PathBuf::from("/tmp/codictate-501/app.codictate.sock"),
                shared_dir: Some(PathBuf::from("/tmp/codictate-501")),
            }
        );
        // The marker stays in <data>/run.
        assert_eq!(
            hidden_launch_marker(Path::new(&format!("{fits}x")), "app.codictate"),
            PathBuf::from(format!("{fits}x/run/app.codictate.hidden-launch"))
        );

        // Bytes, not characters: a two-byte letter tips the same length over.
        let accented = format!("{}é", &fits[..fits.len() - 1]);
        assert_eq!(accented.chars().count(), fits.chars().count());
        assert!(
            socket_path(Path::new(&accented), "app.codictate", 501)
                .shared_dir
                .is_some()
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_shared_socket_dir_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("codictate-cli-sockdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // SAFETY: getuid cannot fail.
        let uid = unsafe { libc::getuid() };
        let set_mode = |p: &Path, mode| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap()
        };

        assert_eq!(
            check_shared_socket_dir(&root.join("missing"), uid),
            Ok(false)
        );

        let dir = root.join("ours");
        std::fs::create_dir(&dir).unwrap();
        set_mode(&dir, 0o700);
        assert_eq!(check_shared_socket_dir(&dir, uid), Ok(true));

        let other_owner = check_shared_socket_dir(&dir, uid + 1).unwrap_err();
        assert!(
            other_owner.contains(&format!("owned by uid {uid}")),
            "{other_owner}"
        );

        set_mode(&dir, 0o755);
        let loose = check_shared_socket_dir(&dir, uid).unwrap_err();
        assert!(loose.contains("mode 0755, not 0700"), "{loose}");
        set_mode(&dir, 0o700);

        let link = root.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let symlink = check_shared_socket_dir(&link, uid).unwrap_err();
        assert!(symlink.contains("not a directory"), "{symlink}");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_launch_is_one_line() {
        let bundle = Path::new("/A.app");
        let failure = launch_failure(
            bundle,
            "\nopen: unrecognized option `--x'\nUsage: open [-e]\n",
        );
        assert_eq!(
            failure.message,
            "cannot start /A.app: open: unrecognized option `--x'"
        );
        assert_eq!(failure.exit, 6);
        assert_eq!(
            launch_failure(bundle, "  \n").message,
            "cannot start /A.app"
        );
    }

    #[test]
    fn verbatim_paths_are_simplified() {
        assert_eq!(simplify_verbatim(r"\\?\C:\a\b"), r"C:\a\b");
        assert_eq!(simplify_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(simplify_verbatim(r"\\?\GLOBALROOT\x"), r"\\?\GLOBALROOT\x");
        assert_eq!(simplify_verbatim("/usr/bin"), "/usr/bin");
    }

    #[test]
    fn the_marker_holds_the_time_in_milliseconds() {
        let dir = std::env::temp_dir().join(format!("codictate-cli-marker-{}", std::process::id()));
        write_hidden_launch_marker(&dir, "app.codictate.test").unwrap();
        let text =
            std::fs::read_to_string(hidden_launch_marker(&dir, "app.codictate.test")).unwrap();
        let millis: u128 = text.parse().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        assert!(now >= millis && now - millis < 60_000);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(run_dir(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
