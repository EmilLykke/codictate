//! `caller` in the request: the client's parent process, self-reported (docs/CLI.md
//! "Request"). Shown to the user, never used to grant anything.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub name: String,
    pub pid: u32,
}

const UNKNOWN: &str = "unknown";

/// The display name for an executable path: its file name, without `.exe`.
pub fn display_name(path_or_name: &str) -> Option<String> {
    let base = path_or_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path_or_name)
        .trim();
    let base = match base.len().checked_sub(4) {
        Some(cut) if base.is_char_boundary(cut) && base[cut..].eq_ignore_ascii_case(".exe") => {
            &base[..cut]
        }
        _ => base,
    };
    (!base.is_empty()).then(|| base.to_string())
}

pub fn parent() -> Caller {
    let (pid, name) = platform::parent();
    Caller {
        name: name
            .as_deref()
            .and_then(display_name)
            .unwrap_or_else(|| UNKNOWN.to_string()),
        pid,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, c_void};

    pub fn parent() -> (u32, Option<String>) {
        let pid = std::os::unix::process::parent_id();
        (pid, path(pid).or_else(|| short_name(pid)))
    }

    /// The full executable path; its file name is the whole process name, where
    /// `proc_name` truncates to 32 bytes.
    fn path(pid: u32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer is valid for `buf.len()` bytes and proc_pidpath writes at most
        // that many, NUL terminated.
        let len = unsafe {
            libc::proc_pidpath(
                pid as libc::c_int,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
            )
        };
        if len <= 0 {
            return None;
        }
        buf.truncate(len as usize);
        String::from_utf8(buf).ok()
    }

    fn short_name(pid: u32) -> Option<String> {
        let mut buf = [0u8; 64];
        // SAFETY: as above; proc_name NUL terminates within the buffer it is given.
        let len = unsafe {
            libc::proc_name(
                pid as libc::c_int,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
            )
        };
        if len <= 0 {
            return None;
        }
        CStr::from_bytes_until_nul(&buf)
            .ok()
            .and_then(|s| s.to_str().ok())
            .map(str::to_string)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    pub fn parent() -> (u32, Option<String>) {
        let pid = std::os::unix::process::parent_id();
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|s| s.trim().to_string());
        (pid, name)
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    struct Entry {
        pid: u32,
        parent: u32,
        exe: String,
    }

    fn processes() -> Vec<Entry> {
        let mut entries = Vec::new();
        // SAFETY: plain Toolhelp32 enumeration; the snapshot handle is closed below and
        // the entry struct is sized as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
                return entries;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
            while ok {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                entries.push(Entry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });
                ok = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        entries
    }

    pub fn parent() -> (u32, Option<String>) {
        let me = std::process::id();
        let all = processes();
        let Some(parent) = all.iter().find(|e| e.pid == me).map(|e| e.parent) else {
            return (0, None);
        };
        let name = all.iter().find(|e| e.pid == parent).map(|e| e.exe.clone());
        (parent, name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_the_file_name() {
        assert_eq!(
            display_name("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")
                .as_deref(),
            Some("Terminal")
        );
        assert_eq!(display_name("zsh").as_deref(), Some("zsh"));
        assert_eq!(
            display_name(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe").as_deref(),
            Some("powershell")
        );
        assert_eq!(display_name("Code.EXE").as_deref(), Some("Code"));
        assert_eq!(display_name("").as_deref(), None);
        assert_eq!(display_name("/").as_deref(), None);
    }

    #[test]
    fn the_parent_is_found() {
        let caller = parent();
        assert!(caller.pid > 0);
        assert!(!caller.name.is_empty());
    }
}
