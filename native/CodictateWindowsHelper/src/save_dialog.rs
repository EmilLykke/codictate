// `save-dialog --name <file name> --directory <folder> --extension <ext> [--title <title>]`:
// the system Save As dialog (IFileSaveDialog) for a Transcript Export.
//
// The Windows half of `CodictateMediaHelper save-dialog` (NSSavePanel, macOS): the same argv,
// output and exit codes, because src/bun/window-file-transcriptions/native.ts reads both. It
// prints exactly one JSON line on stdout: `{"path":"<chosen path>"}` when the user saves,
// `{"cancelled":true}` when they cancel. The dialog asks before replacing an existing file.
//
// Exit codes:
//   0  the user answered (saved or cancelled)
//   1  the dialog could not be shown
//   2  usage error

use crate::ipc;
use serde::Serialize;
use std::process::ExitCode;

const USAGE: &str = "usage: CodictateWindowsHelper save-dialog --name <file name> --directory <folder> --extension <ext> [--title <title>]";

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub struct SaveDialogRequest {
    pub name: String,
    pub directory: String,
    /// Without the dot: `srt`.
    pub extension: String,
    pub title: Option<String>,
}

/// The one line printed on stdout.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SaveDialogOutcome {
    Saved { path: String },
    Cancelled { cancelled: bool },
}

impl SaveDialogOutcome {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn cancelled() -> Self {
        SaveDialogOutcome::Cancelled { cancelled: true }
    }
}

pub fn handle_save_dialog(args: &[String]) -> ExitCode {
    let Some(request) = parse_args(args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match show(&request) {
        Ok(outcome) => match ipc::emit_json(&outcome) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("cannot write the answer: {err}");
                ExitCode::from(1)
            }
        },
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

/// `--flag value` pairs after the command, each flag at most once.
fn parse_args(args: &[String]) -> Option<SaveDialogRequest> {
    let (command, rest) = args.get(1..)?.split_first()?;
    if command != "save-dialog" || rest.len() % 2 != 0 {
        return None;
    }
    let (mut name, mut directory, mut extension, mut title) = (None, None, None, None);
    for pair in rest.chunks(2) {
        let slot = match pair[0].as_str() {
            "--name" => &mut name,
            "--directory" => &mut directory,
            "--extension" => &mut extension,
            "--title" => &mut title,
            _ => return None,
        };
        if slot.replace(pair[1].clone()).is_some() {
            return None;
        }
    }
    let name = name.filter(|value: &String| !value.is_empty())?;
    let directory = directory.filter(|value: &String| !value.is_empty())?;
    let extension = extension?;
    let extension = extension
        .strip_prefix('.')
        .unwrap_or(&extension)
        .to_string();
    if extension.is_empty() || !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(SaveDialogRequest {
        name,
        directory,
        extension,
        title,
    })
}

/// The file type list's one entry, e.g. `SRT file (*.srt)`.
#[cfg_attr(not(windows), allow(dead_code))]
fn filter_name(extension: &str) -> String {
    format!("{} file (*.{extension})", extension.to_ascii_uppercase())
}

#[cfg(windows)]
fn show(request: &SaveDialogRequest) -> Result<SaveDialogOutcome, String> {
    use crate::audio::com::{ComApartment, pwstr_to_string_and_free, to_wide};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IBindCtx};
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, FileSaveDialog,
        IFileSaveDialog, IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
    };
    use windows::core::PCWSTR;

    let fail = |what: &str, err: windows::core::Error| format!("{what}: {err}");

    // The dialog lives on this thread, so this thread is the single-threaded apartment it needs.
    let _com = ComApartment::init()?;
    let name = to_wide(&request.name);
    let directory = to_wide(&request.directory);
    let extension = to_wide(&request.extension);
    let filter_name = to_wide(&filter_name(&request.extension));
    let filter_spec = to_wide(&format!("*.{}", request.extension));
    let title = request.title.as_deref().map(to_wide);

    unsafe {
        // Sharp on a high-DPI screen rather than bitmap-stretched; the helper has no manifest.
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| fail("cannot open the save dialog", err))?;
        let options = dialog
            .GetOptions()
            .map_err(|err| fail("cannot open the save dialog", err))?;
        dialog
            .SetOptions(options | FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
            .map_err(|err| fail("cannot set the save dialog options", err))?;
        let filters = [COMDLG_FILTERSPEC {
            pszName: PCWSTR(filter_name.as_ptr()),
            pszSpec: PCWSTR(filter_spec.as_ptr()),
        }];
        dialog
            .SetFileTypes(&filters)
            .map_err(|err| fail("cannot set the file type", err))?;
        dialog
            .SetDefaultExtension(PCWSTR(extension.as_ptr()))
            .map_err(|err| fail("cannot set the file type", err))?;
        dialog
            .SetFileName(PCWSTR(name.as_ptr()))
            .map_err(|err| fail("cannot set the file name", err))?;
        if let Some(title) = &title {
            dialog
                .SetTitle(PCWSTR(title.as_ptr()))
                .map_err(|err| fail("cannot set the dialog title", err))?;
        }
        // A folder that is gone is not an error: the dialog opens where Windows last left it.
        if let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(
            PCWSTR(directory.as_ptr()),
            None::<&IBindCtx>,
        ) {
            let _ = dialog.SetFolder(&folder);
        }

        match dialog.Show(HWND::default()) {
            Ok(()) => {}
            Err(err) if err.code() == ERROR_CANCELLED.to_hresult() => {
                return Ok(SaveDialogOutcome::cancelled());
            }
            Err(err) => return Err(fail("the save dialog failed", err)),
        }
        let item = dialog
            .GetResult()
            .map_err(|err| fail("cannot read the chosen file", err))?;
        let path = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|err| fail("cannot read the chosen file", err))?;
        Ok(SaveDialogOutcome::Saved {
            path: pwstr_to_string_and_free(path),
        })
    }
}

#[cfg(not(windows))]
fn show(_request: &SaveDialogRequest) -> Result<SaveDialogOutcome, String> {
    Err("the save dialog is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_answer_is_one_json_object_like_the_macos_helper() {
        let saved = SaveDialogOutcome::Saved {
            path: r"C:\Users\me\Talks\board call.srt".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&saved).unwrap(),
            r#"{"path":"C:\\Users\\me\\Talks\\board call.srt"}"#
        );
        assert_eq!(
            serde_json::to_string(&SaveDialogOutcome::cancelled()).unwrap(),
            r#"{"cancelled":true}"#
        );
    }

    #[test]
    fn parses_the_flags_in_any_order() {
        let parsed = parse_args(&args(&[
            "helper",
            "save-dialog",
            "--extension",
            ".srt",
            "--directory",
            r"C:\Users\me",
            "--name",
            "talk.srt",
            "--title",
            "Save Transcript",
        ]));
        assert_eq!(
            parsed,
            Some(SaveDialogRequest {
                name: "talk.srt".to_string(),
                directory: r"C:\Users\me".to_string(),
                extension: "srt".to_string(),
                title: Some("Save Transcript".to_string()),
            })
        );
        let untitled = parse_args(&args(&[
            "helper",
            "save-dialog",
            "--name",
            "a.txt",
            "--directory",
            "C:\\",
            "--extension",
            "txt",
        ]));
        assert_eq!(untitled.map(|request| request.title), Some(None));
    }

    #[test]
    fn anything_else_is_a_usage_error() {
        for bad in [
            args(&["helper", "save-dialog"]),
            args(&["helper", "save-dialog", "--name", "a.txt"]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "a.txt",
                "--directory",
                "C:\\",
            ]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "a.txt",
                "--directory",
                "C:\\",
                "--extension",
            ]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "",
                "--directory",
                "C:\\",
                "--extension",
                "txt",
            ]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "a.txt",
                "--directory",
                "C:\\",
                "--extension",
                "t*t",
            ]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "a.txt",
                "--name",
                "b.txt",
                "--directory",
                "C:\\",
                "--extension",
                "txt",
            ]),
            args(&[
                "helper",
                "save-dialog",
                "--name",
                "a.txt",
                "--directory",
                "C:\\",
                "--extension",
                "txt",
                "--bogus",
                "x",
            ]),
            args(&["helper", "extract-audio", "--name", "a.txt"]),
        ] {
            assert_eq!(parse_args(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_file_type_entry_names_the_extension() {
        assert_eq!(filter_name("srt"), "SRT file (*.srt)");
    }
}
