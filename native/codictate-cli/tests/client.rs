//! The built `codictate` against a fake app on a temporary Unix socket.
//! CODICTATE_APP_BUNDLE points the client at a fake bundle holding only version.json, and
//! CODICTATE_DATA_DIR moves the socket into the test's own directory.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};

const IDENTIFIER: &str = "app.codictate.test";

struct Fixture {
    root: PathBuf,
    bundle: PathBuf,
    data: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        // /tmp rather than temp_dir(): a Unix socket path must fit in 104 bytes on macOS.
        let root = PathBuf::from(format!("/tmp/cdx-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = if cfg!(target_os = "macos") {
            root.join("Fake.app")
        } else {
            root.join("install")
        };
        let resources = if cfg!(target_os = "macos") {
            bundle.join("Contents").join("Resources")
        } else {
            bundle.join("Resources")
        };
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(
            resources.join("version.json"),
            json!({"version": "0.0.62", "channel": "dev", "identifier": IDENTIFIER, "hash": "dev"})
                .to_string(),
        )
        .unwrap();
        let data = root.join("d");
        std::fs::create_dir_all(data.join("run")).unwrap();
        Fixture { root, bundle, data }
    }

    fn listen(&self) -> UnixListener {
        UnixListener::bind(self.data.join("run").join(format!("{IDENTIFIER}.sock"))).unwrap()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codictate"));
        command
            .args(args)
            .current_dir(&self.root)
            .env("CODICTATE_APP_BUNDLE", &self.bundle)
            .env("CODICTATE_DATA_DIR", &self.data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn spawn(&self, args: &[&str]) -> Child {
        self.command(args).spawn().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One accepted connection: the request, and the means to answer it.
struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Conn {
    fn accept(listener: &UnixListener) -> (Self, Value) {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut conn = Conn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        };
        let request = conn.read_line().expect("a request line");
        (conn, request)
    }

    fn read_line(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(&line).unwrap()),
        }
    }

    fn send(&mut self, lines: &[&str]) {
        for line in lines {
            writeln!(self.writer, "{line}").unwrap();
        }
        self.writer.flush().unwrap();
    }
}

/// Serves `count` connections with `answer`, returning every request it saw.
fn serve(
    listener: UnixListener,
    count: usize,
    answer: impl Fn(usize, &mut Conn, &Value) + Send + 'static,
) -> JoinHandle<Vec<Value>> {
    thread::spawn(move || {
        (0..count)
            .map(|i| {
                let (mut conn, request) = Conn::accept(&listener);
                answer(i, &mut conn, &request);
                request
            })
            .collect()
    })
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

fn signal(child: &Child, name: &str) {
    let status = Command::new("kill")
        .arg(format!("-{name}"))
        .arg(child.id().to_string())
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn version_reads_the_bundle_without_the_app() {
    let fixture = Fixture::new("version");
    let output = fixture.run(&["--version"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout(&output),
        format!("codictate 0.0.62 ({IDENTIFIER}, contract 1)\n")
    );
}

#[test]
fn a_usage_error_under_json_is_an_error_event() {
    let fixture = Fixture::new("usage");
    let output = fixture.run(&["status", "--bogus", "--json"]);
    assert_eq!(output.status.code(), Some(2));
    let event: Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert_eq!(event["type"], "error");
    assert_eq!(event["code"], "usage");
    assert!(stderr(&output).starts_with("codictate: "));
}

#[test]
fn status_renders_key_value_lines() {
    let fixture = Fixture::new("status");
    let server = serve(fixture.listen(), 1, |_, conn, _| {
        conn.send(&[include_str!("fixtures/status.json")
            .replace('\n', "")
            .as_str()]);
    });
    let output = fixture.run(&["status"]);
    let requests = server.join().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(stdout(&output).starts_with("app: Codictate 0.0.62 (stable, app.codictate)\n"));
    assert!(stdout(&output).contains("\ndictation: idle\n"));
    let request = &requests[0];
    assert_eq!(request["contractVersion"], 1);
    assert_eq!(request["command"], "status");
    assert_eq!(request["args"], json!({}));
    assert_eq!(request["caller"]["pid"], std::process::id());
    assert!(
        request["caller"]["name"]
            .as_str()
            .is_some_and(|n| !n.is_empty())
    );
}

#[test]
fn transcribe_json_prints_every_event_verbatim_and_exits_with_the_first_failure() {
    let fixture = Fixture::new("tjson");
    let server = serve(fixture.listen(), 2, |i, conn, request| {
        let file = request["args"]["file"].as_str().unwrap().to_string();
        if i == 0 {
            conn.send(&[
                r#"{"type":"queued","position":1}"#,
                r#"{"type":"error","code":"model_not_installed","message":"Speech Model x is not installed"}"#,
            ]);
        } else {
            conn.send(&[
                r#"{"type":"progress","stage":"decoding","elapsedSeconds":0.1,"audioSeconds":null,"future":true}"#,
                r#"{"type":"something-new"}"#,
                &json!({"type": "result", "file": file, "text": "hej", "language": "da"}).to_string(),
            ]);
        }
    });
    let output = fixture.run(&["transcribe", "a.m4a", "sub/b.mov", "--model", "x", "--json"]);
    let requests = server.join().unwrap();
    assert_eq!(output.status.code(), Some(4));
    let text = stdout(&output);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 5, "{text}");
    assert_eq!(lines[0], r#"{"type":"queued","position":1}"#);
    assert!(lines[1].contains(r#""code":"model_not_installed""#));
    assert_eq!(lines[3], r#"{"type":"something-new"}"#);
    assert!(lines[4].contains(r#""text":"hej""#));
    assert_eq!(
        stderr(&output),
        "codictate: a.m4a: Speech Model x is not installed\n"
    );
    for (request, name) in requests.iter().zip(["a.m4a", "sub/b.mov"]) {
        let file = Path::new(request["args"]["file"].as_str().unwrap());
        assert!(file.is_absolute(), "{file:?}");
        assert!(file.ends_with(name), "{file:?}");
        assert_eq!(request["args"]["speechModelId"], "x");
        assert_eq!(request["args"]["languageId"], Value::Null);
    }
}

#[test]
fn transcribe_human_puts_headers_between_files() {
    let fixture = Fixture::new("thuman");
    let server = serve(fixture.listen(), 2, |i, conn, _| {
        let text = if i == 0 { "first" } else { "" };
        conn.send(&[&json!({"type": "result", "text": text}).to_string()]);
    });
    let output = fixture.run(&["transcribe", "a.m4a", "b.m4a"]);
    server.join().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout(&output), "==> a.m4a <==\nfirst\n\n==> b.m4a <==\n\n");
    assert_eq!(stderr(&output), "");
}

#[test]
fn a_contract_mismatch_exits_11() {
    let fixture = Fixture::new("contract");
    let server = serve(fixture.listen(), 1, |_, conn, _| {
        conn.send(&[
            r#"{"type":"error","code":"contract_mismatch","message":"This Codictate speaks contract 2"}"#,
        ]);
    });
    let output = fixture.run(&["models", "list"]);
    server.join().unwrap();
    assert_eq!(output.status.code(), Some(11));
    assert_eq!(
        stderr(&output),
        "codictate: This Codictate speaks contract 2\n"
    );
}

#[test]
fn a_connection_closed_without_an_answer_is_app_unavailable() {
    let fixture = Fixture::new("closed");
    let server = serve(fixture.listen(), 1, |_, _, _| {});
    let output = fixture.run(&["languages", "list", "--json"]);
    server.join().unwrap();
    assert_eq!(output.status.code(), Some(6));
    let event: Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert_eq!(event["code"], "app_unavailable");
}

#[test]
fn dictate_stops_on_the_first_ctrl_c_and_prints_the_text() {
    let fixture = Fixture::new("dstop");
    let listener = fixture.listen();
    let (got_request, request_seen) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut conn, request) = Conn::accept(&listener);
        conn.send(&[r#"{"type":"recording"}"#]);
        got_request.send(()).unwrap();
        // The connection stays open after the request: the next line is the stop.
        let control = conn.read_line();
        conn.send(&[
            r#"{"type":"transcribing"}"#,
            r#"{"type":"result","text":"Hello there.","rawText":"hello there","pasted":false,"live":false}"#,
        ]);
        (request, control)
    });
    let child = fixture.spawn(&["dictate", "--raw", "--max", "30"]);
    request_seen.recv_timeout(Duration::from_secs(20)).unwrap();
    signal(&child, "INT");
    let output = child.wait_with_output().unwrap();
    let (request, control) = server.join().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "Hello there.\n");
    assert_eq!(control, Some(json!({"type": "stop"})));
    assert_eq!(request["command"], "dictate");
    assert_eq!(request["args"]["output"], "stdout");
    assert_eq!(request["args"]["raw"], true);
    assert_eq!(request["args"]["maxSeconds"], 30.0);
}

#[test]
fn dictate_cancels_on_the_second_ctrl_c() {
    let fixture = Fixture::new("dcancel");
    let listener = fixture.listen();
    let (step, steps) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut conn, _) = Conn::accept(&listener);
        step.send(()).unwrap();
        let first = conn.read_line();
        step.send(()).unwrap();
        let second = conn.read_line();
        conn.send(&[r#"{"type":"error","code":"cancelled","message":"Cancelled"}"#]);
        (first, second)
    });
    let child = fixture.spawn(&["dictate", "--json"]);
    steps.recv_timeout(Duration::from_secs(20)).unwrap();
    signal(&child, "INT");
    steps.recv_timeout(Duration::from_secs(20)).unwrap();
    signal(&child, "INT");
    let output = child.wait_with_output().unwrap();
    let (first, second) = server.join().unwrap();
    assert_eq!(first, Some(json!({"type": "stop"})));
    assert_eq!(second, Some(json!({"type": "cancel"})));
    assert_eq!(output.status.code(), Some(130));
    // The app's own error event is printed once, not doubled by the client.
    assert_eq!(
        stdout(&output),
        "{\"type\":\"error\",\"code\":\"cancelled\",\"message\":\"Cancelled\"}\n"
    );
}

#[test]
fn transcribe_cancels_on_sigterm() {
    let fixture = Fixture::new("tterm");
    let listener = fixture.listen();
    let (step, steps) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut conn, _) = Conn::accept(&listener);
        conn.send(&[r#"{"type":"progress","stage":"transcribing","elapsedSeconds":1.0,"audioSeconds":60.0}"#]);
        step.send(()).unwrap();
        conn.read_line()
    });
    let child = fixture.spawn(&["transcribe", "/x/long.m4a"]);
    steps.recv_timeout(Duration::from_secs(20)).unwrap();
    signal(&child, "TERM");
    let output = child.wait_with_output().unwrap();
    let control = server.join().unwrap();
    assert_eq!(control, Some(json!({"type": "cancel"})));
    assert_eq!(output.status.code(), Some(143));
    assert_eq!(stdout(&output), "");
    assert_eq!(stderr(&output), "codictate: Cancelled\n");
}
