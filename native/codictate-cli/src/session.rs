//! One command over one connection: send the request, stream the events, send `stop` or
//! `cancel` when the user asks, end on the `result` or `error` (docs/CLI.md "Wire protocol").

use std::io::{IsTerminal, Write};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{Instant, sleep_until};

use crate::cli::Kind;
use crate::failure::{EXIT_SIGINT, EXIT_SIGTERM, Failure};
use crate::render;
use crate::transport::{Reader, Writer};

/// How long to wait for the app's final event after sending `cancel`.
const CANCEL_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserEvent {
    /// SIGINT / Ctrl-C
    Interrupt,
    /// SIGTERM; on Windows Ctrl-Break or closing the console
    Terminate,
    /// A line on stdin (`dictate --until enter`)
    Enter,
}

#[derive(Debug)]
pub enum Outcome {
    Result(Value),
    Failed(Failure),
}

/// What the client does with a user event at a point in the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reaction {
    Ignore,
    /// `dictate`: end the recording and transcribe it.
    Stop,
    /// Abandon the command, exiting with this code.
    Cancel(i32),
}

/// `dictate`: Enter or the first Ctrl-C stops; a second Ctrl-C or SIGTERM cancels.
/// Everything else: Ctrl-C and SIGTERM cancel, Enter means nothing.
pub fn react(kind: Kind, event: UserEvent, stop_sent: bool) -> Reaction {
    let dictate = matches!(kind, Kind::Dictate { .. });
    match event {
        UserEvent::Enter if dictate && !stop_sent => Reaction::Stop,
        UserEvent::Enter => Reaction::Ignore,
        UserEvent::Interrupt if dictate && !stop_sent => Reaction::Stop,
        UserEvent::Interrupt => Reaction::Cancel(EXIT_SIGINT),
        UserEvent::Terminate => Reaction::Cancel(EXIT_SIGTERM),
    }
}

pub const STOP_LINE: &str = "{\"type\":\"stop\"}\n";
pub const CANCEL_LINE: &str = "{\"type\":\"cancel\"}\n";

/// Reads stdin lines on a thread and reports each as `Enter`. Only for a terminal.
pub fn spawn_enter_reader(events: UnboundedSender<UserEvent>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match std::io::BufRead::read_until(&mut stdin.lock(), b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if events.send(UserEvent::Enter).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Where everything is printed. Progress goes to stderr only in human mode on a terminal,
/// as one line rewritten in place (padding instead of ANSI, which older Windows consoles
/// do not interpret).
pub struct Output {
    pub json: bool,
    progress_enabled: bool,
    progress_width: usize,
}

impl Output {
    pub fn new(json: bool) -> Self {
        Self {
            json,
            progress_enabled: !json && std::io::stderr().is_terminal(),
            progress_width: 0,
        }
    }

    pub fn progress(&mut self, text: &str) {
        if !self.progress_enabled {
            return;
        }
        let width = text.chars().count();
        let pad = self.progress_width.saturating_sub(width);
        let mut err = std::io::stderr().lock();
        let _ = write!(err, "\r{text}{}", " ".repeat(pad));
        let _ = err.flush();
        self.progress_width = width;
    }

    pub fn clear_progress(&mut self) {
        if self.progress_width == 0 {
            return;
        }
        let mut err = std::io::stderr().lock();
        let _ = write!(err, "\r{}\r", " ".repeat(self.progress_width));
        let _ = err.flush();
        self.progress_width = 0;
    }

    /// Stdout text; write errors (a closed pipe) are ignored.
    pub fn stdout(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.clear_progress();
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    /// An event line received from the app, verbatim (`--json`).
    pub fn event_line(&mut self, line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    /// `codictate: <message>` on stderr, and under `--json` the `error` event on stdout
    /// unless the app's own was already printed.
    pub fn failure(&mut self, failure: &Failure, context: Option<&str>) {
        self.clear_progress();
        if self.json && !failure.from_app {
            self.event_line(&failure.to_event_line());
        }
        let mut err = std::io::stderr().lock();
        let _ = match context {
            Some(context) => writeln!(err, "codictate: {context}: {}", failure.message),
            None => writeln!(err, "codictate: {}", failure.message),
        };
        let _ = err.flush();
    }
}

/// Runs one request to its `result` or `error`.
pub async fn run(
    reader: Reader,
    mut writer: Writer,
    request: &Value,
    kind: Kind,
    recording_hint: &str,
    out: &mut Output,
    events: &mut UnboundedReceiver<UserEvent>,
) -> Outcome {
    let mut lines = BufReader::new(reader).lines();
    let request_line = format!("{request}\n");
    if let Err(e) = send(&mut writer, &request_line).await {
        return Outcome::Failed(Failure::app_unavailable(format!(
            "cannot send the command to Codictate: {e}"
        )));
    }

    let mut stop_sent = false;
    // Set once `cancel` is sent: the exit code, and when to stop waiting for the app.
    let mut cancelling: Option<(i32, Instant)> = None;
    loop {
        let grace_end = cancelling.map(|(_, end)| end);
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else {
                    return Outcome::Failed(match cancelling {
                        Some((exit, _)) => Failure::cancelled(exit),
                        None => Failure::app_unavailable(
                            "Codictate closed the connection without an answer",
                        ),
                    });
                };
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if !event.is_object() {
                    continue;
                }
                if out.json {
                    out.event_line(&line);
                }
                match event.get("type").and_then(Value::as_str) {
                    Some("result") | Some("error") if cancelling.is_some() => {
                        let (exit, _) = cancelling.unwrap_or((EXIT_SIGINT, Instant::now()));
                        let mut failure = Failure::cancelled(exit);
                        failure.from_app = event.get("type").and_then(Value::as_str) == Some("error");
                        return Outcome::Failed(failure);
                    }
                    Some("result") => return Outcome::Result(event),
                    Some("error") => return Outcome::Failed(Failure::from_event(&event)),
                    Some(_) if !out.json => {
                        if let Some(text) = render::progress(&event, recording_hint) {
                            out.progress(&text);
                        }
                    }
                    _ => {}
                }
            }
            Some(event) = events.recv() => {
                match react(kind, event, stop_sent) {
                    Reaction::Ignore => {}
                    Reaction::Stop => {
                        stop_sent = true;
                        let _ = send(&mut writer, STOP_LINE).await;
                    }
                    Reaction::Cancel(exit) => {
                        if cancelling.is_some() {
                            // Asked twice: stop waiting for the app.
                            return Outcome::Failed(Failure::cancelled(exit));
                        }
                        let _ = send(&mut writer, CANCEL_LINE).await;
                        cancelling = Some((exit, Instant::now() + CANCEL_GRACE));
                    }
                }
            }
            _ = sleep_until(grace_end.unwrap_or_else(Instant::now)), if grace_end.is_some() => {
                let (exit, _) = cancelling.unwrap_or((EXIT_SIGINT, Instant::now()));
                return Outcome::Failed(Failure::cancelled(exit));
            }
        }
    }
}

async fn send(writer: &mut Writer, line: &str) -> std::io::Result<()> {
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    const DICTATE: Kind = Kind::Dictate { paste: false };

    #[test]
    fn dictate_stops_on_enter_or_the_first_ctrl_c() {
        assert_eq!(react(DICTATE, UserEvent::Enter, false), Reaction::Stop);
        assert_eq!(react(DICTATE, UserEvent::Interrupt, false), Reaction::Stop);
    }

    #[test]
    fn dictate_cancels_on_the_second_ctrl_c_or_sigterm() {
        assert_eq!(
            react(DICTATE, UserEvent::Interrupt, true),
            Reaction::Cancel(130)
        );
        assert_eq!(
            react(DICTATE, UserEvent::Terminate, false),
            Reaction::Cancel(143)
        );
        assert_eq!(react(DICTATE, UserEvent::Enter, true), Reaction::Ignore);
    }

    #[test]
    fn other_commands_cancel_on_any_signal() {
        for kind in [Kind::Transcribe, Kind::ModelsDownload, Kind::Status] {
            assert_eq!(
                react(kind, UserEvent::Interrupt, false),
                Reaction::Cancel(130)
            );
            assert_eq!(
                react(kind, UserEvent::Terminate, false),
                Reaction::Cancel(143)
            );
            assert_eq!(react(kind, UserEvent::Enter, false), Reaction::Ignore);
        }
    }

    #[test]
    fn control_lines_are_the_documented_json() {
        let stop: Value = serde_json::from_str(STOP_LINE).unwrap();
        let cancel: Value = serde_json::from_str(CANCEL_LINE).unwrap();
        assert_eq!(stop, serde_json::json!({"type": "stop"}));
        assert_eq!(cancel, serde_json::json!({"type": "cancel"}));
        assert!(STOP_LINE.ends_with('\n') && CANCEL_LINE.ends_with('\n'));
    }
}
