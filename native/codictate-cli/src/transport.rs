//! The connection to the app: a Unix domain socket on macOS, a named pipe on Windows
//! (docs/CLI.md "Transport").
//!
//! Both are opened through tokio so a `dictate` can write its `stop` control line while a
//! read is pending. On Windows that matters: a pipe handle opened for synchronous I/O
//! serialises every operation on it, so a `WriteFile` from a second thread would wait
//! behind the blocked `ReadFile` until the app sent something. tokio opens the client end
//! with `FILE_FLAG_OVERLAPPED`, where a read and a write are in flight independently.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{Instant, sleep};

use crate::app::{self, AppInfo};
use crate::failure::{EXIT_SIGINT, EXIT_SIGTERM, Failure};
use crate::session::UserEvent;

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum ConnectError {
    /// Nobody listens: the app is not running (or not yet).
    NotRunning,
    /// Windows: the app is running but every pipe instance is taken; retry without launching.
    #[cfg_attr(not(windows), allow(dead_code))]
    Busy,
    /// macOS: the shared socket directory is not the user's own private one.
    #[cfg_attr(windows, allow(dead_code))]
    Unsafe(String),
    Other(io::Error),
}

#[cfg(unix)]
pub struct Endpoint {
    socket: app::SocketPath,
    uid: u32,
}

#[cfg(windows)]
pub struct Endpoint(String);

impl Endpoint {
    pub fn for_app(app: &AppInfo, data_dir: &Path) -> Result<Self, Failure> {
        #[cfg(unix)]
        {
            // SAFETY: getuid cannot fail.
            let uid = unsafe { libc::getuid() };
            Ok(Endpoint {
                socket: app::socket_path(data_dir, &app.identifier, uid),
                uid,
            })
        }
        #[cfg(windows)]
        {
            let _ = data_dir;
            Ok(Endpoint(app::pipe_name(
                &app.identifier,
                &windows_username()?,
            )))
        }
    }

    pub fn describe(&self) -> String {
        #[cfg(unix)]
        {
            self.socket.path.display().to_string()
        }
        #[cfg(windows)]
        {
            self.0.clone()
        }
    }
}

#[cfg(unix)]
pub async fn try_connect(endpoint: &Endpoint) -> Result<(Reader, Writer), ConnectError> {
    if let Some(dir) = &endpoint.socket.shared_dir {
        match app::check_shared_socket_dir(dir, endpoint.uid) {
            Ok(true) => {}
            Ok(false) => return Err(ConnectError::NotRunning),
            Err(why) => return Err(ConnectError::Unsafe(why)),
        }
    }
    match tokio::net::UnixStream::connect(&endpoint.socket.path).await {
        Ok(stream) => {
            let (read, write) = stream.into_split();
            Ok((Box::new(read), Box::new(write)))
        }
        Err(e) => match e.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                Err(ConnectError::NotRunning)
            }
            _ => Err(ConnectError::Other(e)),
        },
    }
}

#[cfg(windows)]
pub async fn try_connect(endpoint: &Endpoint) -> Result<(Reader, Writer), ConnectError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    match ClientOptions::new().open(&endpoint.0) {
        Ok(client) => {
            let (read, write) = tokio::io::split(client);
            Ok((Box::new(read), Box::new(write)))
        }
        Err(e) => match e.raw_os_error() {
            Some(ERROR_FILE_NOT_FOUND) => Err(ConnectError::NotRunning),
            Some(ERROR_PIPE_BUSY) => Err(ConnectError::Busy),
            _ => Err(ConnectError::Other(e)),
        },
    }
}

#[cfg(windows)]
fn windows_username() -> Result<String, Failure> {
    use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;
    let mut buf = vec![0u16; 257];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer holds `len` UTF-16 units; GetUserNameW writes at most that many
    // including the terminating NUL and reports the count back in `len`.
    let ok = unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) };
    if ok == 0 || len == 0 {
        return Err(Failure::app_unavailable(format!(
            "cannot read the user name: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
}

fn interrupted(event: UserEvent) -> Option<Failure> {
    match event {
        UserEvent::Interrupt => Some(Failure::cancelled(EXIT_SIGINT)),
        UserEvent::Terminate => Some(Failure::cancelled(EXIT_SIGTERM)),
        UserEvent::Enter => None,
    }
}

/// Connects to the app, starting it hidden first when it is not running.
pub async fn connect_or_launch(
    app: &AppInfo,
    data_dir: &Path,
    events: &mut UnboundedReceiver<UserEvent>,
) -> Result<(Reader, Writer), Failure> {
    let endpoint = Endpoint::for_app(app, data_dir)?;
    match try_connect(&endpoint).await {
        Ok(conn) => return Ok(conn),
        Err(ConnectError::NotRunning) => {
            app::write_hidden_launch_marker(data_dir, &app.identifier).map_err(|e| {
                Failure::app_unavailable(format!(
                    "cannot write {}: {e}",
                    app::hidden_launch_marker(data_dir, &app.identifier).display()
                ))
            })?;
            app::launch(app)?;
        }
        Err(ConnectError::Busy) => {}
        Err(ConnectError::Unsafe(why)) => return Err(Failure::app_unavailable(why)),
        Err(ConnectError::Other(e)) => {
            return Err(Failure::app_unavailable(format!(
                "cannot connect to Codictate at {}: {e}",
                endpoint.describe()
            )));
        }
    }

    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        tokio::select! {
            Some(event) = events.recv() => {
                if let Some(failure) = interrupted(event) {
                    return Err(failure);
                }
            }
            _ = sleep(POLL_INTERVAL) => {
                match try_connect(&endpoint).await {
                    Ok(conn) => return Ok(conn),
                    Err(ConnectError::Unsafe(why)) => return Err(Failure::app_unavailable(why)),
                    Err(_) => {}
                }
                if Instant::now() >= deadline {
                    return Err(Failure::app_unavailable(format!(
                        "Codictate did not answer within {} s",
                        LAUNCH_TIMEOUT.as_secs()
                    )));
                }
            }
        }
    }
}
