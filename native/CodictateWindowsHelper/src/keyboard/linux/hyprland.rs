//! Hyprland IPC over its two UNIX sockets in
//! `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/`.
//!
//! - `.socket.sock` is request/response, one request per connection. The
//!   request is `<flags>/<command> <args>` exactly as `hyprctl` writes it:
//!   `hyprctl eval '<lua>'` sends `/eval <lua>` and `hyprctl -j binds` sends
//!   `j/binds`. Hyprland answers `ok` or error text, then closes.
//! - `.socket2.sock` streams `EVENT>>DATA\n` lines.

use std::env;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct Hyprland {
    instance_dir: PathBuf,
}

impl Hyprland {
    /// The Hyprland instance this process runs under, if any.
    pub fn from_env() -> Option<Self> {
        let signature = env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
        let signature = signature.trim();
        if signature.is_empty() || signature.contains('/') {
            return None;
        }
        let runtime_dir = env::var_os("XDG_RUNTIME_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", current_uid())));
        Some(Self {
            instance_dir: runtime_dir.join("hypr").join(signature),
        })
    }

    /// Whether the request socket answers at all.
    pub fn is_reachable(&self) -> bool {
        self.request("j/version").is_ok()
    }

    /// One raw request on `.socket.sock`.
    pub fn request(&self, request: &str) -> io::Result<String> {
        if request.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Hyprland requests cannot contain NUL bytes",
            ));
        }
        let mut stream = UnixStream::connect(self.instance_dir.join(".socket.sock"))?;
        stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        stream.set_write_timeout(Some(REQUEST_TIMEOUT))?;
        // Hyprland reads the request in 1023-byte chunks until a short read,
        // so the whole request goes out in one write, and closing our write
        // half turns a request of an exact multiple of 1023 bytes into a short
        // read instead of a stall.
        stream.write_all(request.as_bytes())?;
        stream.shutdown(Shutdown::Write)?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply)
    }

    /// Runs a Lua chunk in Hyprland's config state. `Ok` only when Hyprland
    /// answered `ok`; anything else is the error or warning text it printed.
    pub fn eval(&self, lua: &str) -> Result<(), String> {
        let reply = self
            .request(&eval_request(lua))
            .map_err(|err| format!("Hyprland eval request failed: {err}"))?;
        eval_reply_result(&reply)
    }

    /// `hyprctl -j binds`.
    pub fn binds_json(&self) -> Result<String, String> {
        self.request("j/binds")
            .map_err(|err| format!("Hyprland binds request failed: {err}"))
    }

    /// A connection to the event socket.
    pub fn connect_events(&self) -> io::Result<UnixStream> {
        UnixStream::connect(self.instance_dir.join(".socket2.sock"))
    }
}

pub fn eval_request(lua: &str) -> String {
    format!("/eval {lua}")
}

pub fn eval_reply_result(reply: &str) -> Result<(), String> {
    let reply = reply.trim();
    if reply == "ok" {
        Ok(())
    } else if reply.is_empty() {
        Err("Hyprland eval returned an empty reply".to_string())
    } else {
        Err(reply.to_string())
    }
}

fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    // The process owns its /proc entry; avoids a libc dependency for getuid().
    std::fs::metadata("/proc/self")
        .map(|meta| meta.uid())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::thread;

    #[test]
    fn eval_request_matches_hyprctl_wire_format() {
        assert_eq!(eval_request("return 1"), "/eval return 1");
        assert_eq!(
            eval_request("do\n  x()\nend"),
            "/eval do\n  x()\nend",
            "multi-line chunks are sent verbatim"
        );
    }

    #[test]
    fn eval_reply_is_ok_only_for_ok() {
        assert_eq!(eval_reply_result("ok"), Ok(()));
        assert_eq!(eval_reply_result("ok\n"), Ok(()));
        assert!(eval_reply_result("").is_err());
        assert_eq!(
            eval_reply_result("error: [string \"x\"]:1: boom"),
            Err("error: [string \"x\"]:1: boom".to_string())
        );
    }

    #[test]
    fn request_round_trips_through_a_fake_instance() {
        let dir = std::env::temp_dir().join(format!(
            "codictate-hypr-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let listener = UnixListener::bind(dir.join(".socket.sock")).unwrap();
        let server = thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut request = String::new();
            conn.read_to_string(&mut request).unwrap();
            conn.write_all(b"ok").unwrap();
            request
        });

        let hyprland = Hyprland {
            instance_dir: dir.clone(),
        };
        let lua = "x".repeat(1023 * 2);
        assert_eq!(hyprland.eval(&lua), Ok(()));
        assert_eq!(server.join().unwrap(), format!("/eval {lua}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn requests_with_nul_are_refused() {
        let hyprland = Hyprland {
            instance_dir: PathBuf::from("/nonexistent"),
        };
        assert!(hyprland.request("/eval \0").is_err());
    }
}
