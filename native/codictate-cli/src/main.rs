//! `codictate`: the command line of the Codictate app, a thin client that hands every
//! command to the running app. The contract is docs/CLI.md; why it is built this way is
//! docs/adr/0009-command-line-talks-to-the-running-app.md.

mod app;
mod caller;
mod cli;
mod failure;
mod render;
mod session;
mod transport;

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::Path;

use clap::Parser;
use clap::error::ErrorKind;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::app::AppInfo;
use crate::cli::{Cli, Kind, Plan};
use crate::failure::{CONTRACT_VERSION, Failure};
use crate::session::{Outcome, Output, UserEvent};

fn main() {
    let code = real_main(std::env::args_os().collect());
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}

fn real_main(argv: Vec<OsString>) -> i32 {
    let wants_json = argv.iter().skip(1).any(|a| a == "--json");
    let cli = match Cli::try_parse_from(&argv) {
        Ok(cli) => cli,
        Err(err) => return clap_error(err, wants_json),
    };

    if cli.version {
        println!("{}", version_line(app::discover().ok().as_ref()));
        return 0;
    }
    let Some(command) = cli.command else {
        // arg_required_else_help makes this unreachable; keep a usage exit regardless.
        return 2;
    };

    let json = match &command {
        cli::Command::Transcribe(a) => a.output.json,
        cli::Command::Dictate(a) => a.output.json,
        _ => wants_json,
    };
    let mut out = Output::new(json);
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(e) => {
            let failure = Failure::new(
                "internal",
                format!("cannot read the working directory: {e}"),
            );
            out.failure(&failure, None);
            return failure.exit;
        }
    };
    let plan = match cli::plan(command, &caller::parent(), &cwd) {
        Ok(plan) => plan,
        Err(failure) => {
            out.failure(&failure, None);
            return failure.exit;
        }
    };
    let located = app::discover().and_then(|app| Ok((app, app::data_dir()?)));
    let (app, data_dir) = match located {
        Ok(found) => found,
        Err(failure) => {
            out.failure(&failure, None);
            return failure.exit;
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            let failure = Failure::new("internal", format!("cannot start: {e}"));
            out.failure(&failure, None);
            return failure.exit;
        }
    };
    runtime.block_on(run(plan, &app, &data_dir, &mut out))
}

/// `codictate <version> (<identifier>, contract 1)`, from the app's version.json.
fn version_line(app: Option<&AppInfo>) -> String {
    match app {
        Some(app) => format!(
            "codictate {} ({}, contract {CONTRACT_VERSION})",
            app.version, app.identifier
        ),
        None => format!(
            "codictate {} (no app, contract {CONTRACT_VERSION})",
            env!("CARGO_PKG_VERSION")
        ),
    }
}

/// Help goes to stdout with exit 0. A usage error is one `codictate: ` line on stderr,
/// exit 2, and under `--json` a `usage` error event on stdout.
fn clap_error(err: clap::Error, wants_json: bool) -> i32 {
    match err.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            let _ = err.print();
            0
        }
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let _ = err.print();
            2
        }
        _ => {
            let failure = Failure::usage(usage_message(&err.render().to_string()));
            Output::new(wants_json).failure(&failure, None);
            failure.exit
        }
    }
}

/// The first line of clap's error, without its `error: ` prefix, pointing at `--help`.
fn usage_message(rendered: &str) -> String {
    let first = rendered.lines().next().unwrap_or("invalid arguments");
    let first = first.strip_prefix("error: ").unwrap_or(first);
    format!("{first} (see 'codictate --help')")
}

fn spawn_signal_listener(events: UnboundedSender<UserEvent>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut interrupt), Ok(mut terminate)) = (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
        ) else {
            return;
        };
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = interrupt.recv() => UserEvent::Interrupt,
                    _ = terminate.recv() => UserEvent::Terminate,
                };
                if events.send(event).is_err() {
                    break;
                }
            }
        });
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close};
        let (Ok(mut interrupt), Ok(mut brk), Ok(mut close)) =
            (ctrl_c(), ctrl_break(), ctrl_close())
        else {
            return;
        };
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = interrupt.recv() => UserEvent::Interrupt,
                    _ = brk.recv() => UserEvent::Terminate,
                    _ = close.recv() => UserEvent::Terminate,
                };
                if events.send(event).is_err() {
                    break;
                }
            }
        });
    }
}

async fn run(plan: Plan, app: &AppInfo, data_dir: &Path, out: &mut Output) -> i32 {
    let (sender, mut events): (UnboundedSender<UserEvent>, UnboundedReceiver<UserEvent>) =
        unbounded_channel();
    spawn_signal_listener(sender.clone());

    let reads_enter = matches!(plan.kind, Kind::Dictate { .. }) && std::io::stdin().is_terminal();
    let recording_hint = if reads_enter {
        "press Enter to stop"
    } else {
        "press Ctrl-C to stop"
    };
    let several = plan.jobs.len() > 1;
    let mut first_failure: Option<i32> = None;
    let mut printed_any = false;

    for job in &plan.jobs {
        let context = if several { job.label.as_deref() } else { None };
        let (reader, writer) = match transport::connect_or_launch(app, data_dir, &mut events).await
        {
            Ok(conn) => conn,
            Err(failure) => {
                out.failure(&failure, None);
                return failure.exit;
            }
        };
        if reads_enter {
            session::spawn_enter_reader(sender.clone());
        }
        let outcome = session::run(
            reader,
            writer,
            &job.request,
            plan.kind,
            recording_hint,
            out,
            &mut events,
        )
        .await;
        match outcome {
            Outcome::Result(result) => {
                out.clear_progress();
                if let Some(failure) = delivery_failure(&plan, &result) {
                    out.failure(&failure, context);
                    first_failure.get_or_insert(failure.exit);
                } else if plan.output_file.is_none() && !out.json {
                    if several {
                        out.stdout(&render::file_header(
                            job.label.as_deref().unwrap_or(""),
                            !printed_any,
                        ));
                    }
                    out.stdout(&render::result(plan.kind, &result));
                    printed_any = true;
                }
            }
            Outcome::Failed(failure) => {
                if failure.code == "cancelled" {
                    out.failure(&failure, None);
                    return failure.exit;
                }
                out.failure(&failure, context);
                first_failure.get_or_insert(failure.exit);
                if matches!(
                    failure.code.as_str(),
                    "app_unavailable" | "contract_mismatch"
                ) {
                    break;
                }
            }
        }
    }
    first_failure.unwrap_or(0)
}

/// What can still go wrong with a `transcribe` result: an app too old to know `--format`
/// (it would silently send plain text), or a `-o` file that cannot be written. Writes the
/// `-o` file; `None` when the result is delivered or is printed as usual.
fn delivery_failure(plan: &Plan, result: &Value) -> Option<Failure> {
    if plan.wants_formatted && result.get("formatted").and_then(Value::as_str).is_none() {
        return Some(Failure::new(
            "internal",
            "the running Codictate does not support --format. Quit and reopen Codictate, then try again.",
        ));
    }
    let path = plan.output_file.as_ref()?;
    std::fs::write(path, render::transcript(result))
        .err()
        .map(|e| Failure::output_unwritable(path, &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn version_line_names_the_app_and_contract() {
        let app = AppInfo {
            bundle: PathBuf::from("/Applications/Codictate.app"),
            version: "0.0.62".into(),
            channel: "stable".into(),
            identifier: "app.codictate".into(),
        };
        assert_eq!(
            version_line(Some(&app)),
            "codictate 0.0.62 (app.codictate, contract 1)"
        );
        assert!(version_line(None).ends_with("(no app, contract 1)"));
    }

    fn transcribe_plan(output_file: Option<PathBuf>, wants_formatted: bool) -> Plan {
        Plan {
            kind: Kind::Transcribe,
            json: false,
            jobs: Vec::new(),
            output_file,
            wants_formatted,
        }
    }

    #[test]
    fn output_writes_the_formatted_document_or_the_transcript() {
        let dir = std::env::temp_dir().join(format!("cdx-out-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memo.srt");
        let formatted =
            serde_json::json!({"type": "result", "text": "Hej.", "formatted": "1\nHej.\n\n"});
        assert_eq!(
            delivery_failure(&transcribe_plan(Some(path.clone()), true), &formatted),
            None
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1\nHej.\n\n");
        let plain = serde_json::json!({"type": "result", "text": "Hej."});
        assert_eq!(
            delivery_failure(&transcribe_plan(Some(path.clone()), false), &plain),
            None
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Hej.\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unwritable_output_is_output_unwritable_naming_the_path() {
        let path = PathBuf::from("/nonexistent-cdx-dir/memo.txt");
        let failure = delivery_failure(
            &transcribe_plan(Some(path), false),
            &serde_json::json!({"type": "result", "text": "x"}),
        )
        .unwrap();
        assert_eq!(failure.code, "output_unwritable");
        assert_eq!(failure.exit, 1);
        assert!(
            failure
                .message
                .starts_with("/nonexistent-cdx-dir/memo.txt: cannot write: "),
            "{}",
            failure.message
        );
    }

    #[test]
    fn a_format_the_app_did_not_render_is_never_printed_as_plain_text() {
        let plain = serde_json::json!({"type": "result", "text": "x"});
        let failure = delivery_failure(&transcribe_plan(None, true), &plain).unwrap();
        assert_eq!(failure.code, "internal");
        assert_eq!(
            delivery_failure(&transcribe_plan(None, false), &plain),
            None
        );
    }

    #[test]
    fn usage_errors_are_one_line() {
        let err = Cli::try_parse_from(["codictate", "status", "--nope"]).unwrap_err();
        let message = usage_message(&err.render().to_string());
        assert_eq!(
            message,
            "unexpected argument '--nope' found (see 'codictate --help')"
        );
        assert!(!message.contains('\n'));
    }
}
