//! Human output (docs/CLI.md "Output"): the result on stdout, progress on stderr.
//! Every function here is pure and tolerates missing or unknown fields.

use serde_json::Value;

use crate::cli::Kind;

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn line(text: &str) -> String {
    format!("{text}\n")
}

/// What a `result` event prints on stdout, newline included; empty for nothing.
pub fn result(kind: Kind, result: &Value) -> String {
    match kind {
        Kind::Transcribe => line(str_field(result, "text").unwrap_or("")),
        Kind::Dictate { paste: true } => String::new(),
        Kind::Dictate { paste: false } => str_field(result, "text").map(line).unwrap_or_default(),
        Kind::Stop => line(if bool_field(result, "stopped") {
            "Stopped the Dictation."
        } else {
            "No Dictation was running."
        }),
        Kind::Status => status(result),
        Kind::ModelsList => models(result),
        Kind::ModelsUse => id_line("Selected", result, "speechModelId"),
        Kind::ModelsDownload => id_line("Downloaded", result, "speechModelId"),
        Kind::ModelsRemove => id_line("Removed", result, "speechModelId"),
        Kind::LanguagesList => languages(result),
        Kind::LanguagesUse => id_line("Selected", result, "transcriptionLanguageId"),
    }
}

fn id_line(verb: &str, result: &Value, key: &str) -> String {
    match str_field(result, key) {
        Some(id) => line(&format!("{verb} {id}")),
        None => String::new(),
    }
}

/// The `==> file <==` line before each transcript when several files are given, as `tail`.
pub fn file_header(label: &str, first: bool) -> String {
    format!("{}==> {label} <==\n", if first { "" } else { "\n" })
}

fn status(result: &Value) -> String {
    let mut rows: Vec<(&str, String)> = Vec::new();
    if let Some(app) = result.get("app") {
        let version = str_field(app, "version").unwrap_or("?");
        let mut detail = Vec::new();
        detail.extend(str_field(app, "channel"));
        detail.extend(str_field(app, "identifier"));
        rows.push((
            "app",
            if detail.is_empty() {
                format!("Codictate {version}")
            } else {
                format!("Codictate {version} ({})", detail.join(", "))
            },
        ));
    }
    if let Some(version) = result.get("contractVersion").and_then(Value::as_u64) {
        rows.push(("contract", version.to_string()));
    }
    if let Some(done) = result.get("onboardingCompleted").and_then(Value::as_bool) {
        rows.push((
            "onboarding",
            if done { "completed" } else { "not completed" }.into(),
        ));
    }
    if let Some(mic) = str_field(result, "microphone") {
        rows.push(("microphone", mic.into()));
    }
    if let Some(on) = result.get("commandLineControl").and_then(Value::as_bool) {
        rows.push(("command-line control", if on { "on" } else { "off" }.into()));
    }
    if let Some(dictation) = result.get("dictation") {
        let text = if bool_field(dictation, "active") {
            match str_field(dictation, "startedBy") {
                Some(by) => format!("running (started by {by})"),
                None => "running".into(),
            }
        } else {
            "idle".into()
        };
        rows.push(("dictation", text));
    }
    if let Some(model) = result.get("speechModel") {
        let id = str_field(model, "id").unwrap_or("?");
        let label = str_field(model, "label").unwrap_or(id);
        let mut detail = vec![id];
        detail.extend(str_field(model, "engine"));
        let mut text = format!("{label} ({})", detail.join(", "));
        if model.get("installed").and_then(Value::as_bool) == Some(false) {
            text.push_str(", not installed");
        }
        rows.push(("speech model", text));
    }
    if let Some(language) = result.get("transcriptionLanguage") {
        let id = str_field(language, "id").unwrap_or("?");
        let label = str_field(language, "label").unwrap_or(id);
        rows.push(("transcription language", format!("{label} ({id})")));
    }
    if let Some(files) = result.get("fileTranscriptions") {
        let count = |key| files.get(key).and_then(Value::as_u64).unwrap_or(0);
        rows.push((
            "file transcriptions",
            format!("{} running, {} queued", count("running"), count("queued")),
        ));
    }
    rows.iter()
        .map(|(key, value)| format!("{key}: {value}\n"))
        .collect()
}

/// Left-aligned columns separated by two spaces, trailing spaces trimmed.
fn table(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|c| {
            rows.iter()
                .filter_map(|r| r.get(c))
                .map(|cell| cell.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let mut out = String::new();
    for row in rows {
        let mut text = String::new();
        for (c, cell) in row.iter().enumerate() {
            if c > 0 {
                text.push_str("  ");
            }
            text.push_str(cell);
            let pad = widths[c] - cell.chars().count();
            text.extend(std::iter::repeat_n(' ', pad));
        }
        out.push_str(text.trim_end());
        out.push('\n');
    }
    out
}

/// The first column: the id, marked `*` when selected.
fn marked_id(item: &Value) -> String {
    let mark = if bool_field(item, "selected") {
        '*'
    } else {
        ' '
    };
    format!("{mark} {}", str_field(item, "id").unwrap_or("?"))
}

fn size(megabytes: Option<f64>) -> String {
    match megabytes {
        Some(mb) if mb >= 1000.0 => format!("{:.1} GB", mb / 1000.0),
        Some(mb) => format!("{} MB", mb.round()),
        None => String::new(),
    }
}

fn models(result: &Value) -> String {
    let Some(models) = result.get("models").and_then(Value::as_array) else {
        return String::new();
    };
    let mut rows = vec![vec![
        "  ID".to_string(),
        "NAME".into(),
        "ENGINE".into(),
        "SIZE".into(),
        "STATUS".into(),
    ]];
    for model in models {
        let mut status = vec![if bool_field(model, "installed") {
            "installed"
        } else {
            "not installed"
        }];
        if bool_field(model, "bundled") {
            status.push("bundled");
        }
        rows.push(vec![
            marked_id(model),
            str_field(model, "label").unwrap_or("").into(),
            str_field(model, "engine").unwrap_or("").into(),
            size(model.get("downloadSizeMB").and_then(Value::as_f64)),
            status.join(", "),
        ]);
    }
    table(&rows)
}

fn languages(result: &Value) -> String {
    let Some(languages) = result.get("languages").and_then(Value::as_array) else {
        return String::new();
    };
    let mut rows = vec![vec!["  ID".to_string(), "NAME".into(), String::new()]];
    for language in languages {
        let allowed = language
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        rows.push(vec![
            marked_id(language),
            str_field(language, "label").unwrap_or("").into(),
            if allowed {
                String::new()
            } else {
                "not allowed by the selected Speech Model".into()
            },
        ]);
    }
    table(&rows)
}

/// `1:05`, or `1:02:01` past an hour.
pub fn duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// The one-line progress shown on stderr for a non-final event, if it has one.
/// `recording_hint` is what ends a `dictate` recording from this terminal.
pub fn progress(event: &Value, recording_hint: &str) -> Option<String> {
    let seconds = |key| event.get(key).and_then(Value::as_f64);
    match str_field(event, "type")? {
        "queued" => Some(match event.get("position").and_then(Value::as_u64) {
            Some(position) => format!("Waiting in the queue (position {position})"),
            None => "Waiting in the queue".into(),
        }),
        "progress" => {
            let stage = match str_field(event, "stage") {
                Some("decoding") => "Decoding audio".to_string(),
                Some("transcribing") => "Transcribing".to_string(),
                Some(other) => {
                    let mut chars = other.chars();
                    chars
                        .next()
                        .map(|c| c.to_uppercase().chain(chars).collect())
                        .unwrap_or_else(|| "Working".into())
                }
                None => "Working".into(),
            };
            let mut text = format!("{stage}...");
            if let Some(elapsed) = seconds("elapsedSeconds") {
                text.push_str(&format!(" {}", duration(elapsed)));
            }
            if let Some(audio) = seconds("audioSeconds") {
                text.push_str(&format!(" ({} of audio)", duration(audio)));
            }
            Some(text)
        }
        "recording" => Some(format!("Recording... {recording_hint}")),
        "transcribing" => Some("Transcribing...".into()),
        "download" => seconds("fraction")
            .map(|f| format!("Downloading... {}%", (f.clamp(0.0, 1.0) * 100.0).floor())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn transcribe_prints_the_transcript() {
        let value = fixture(include_str!("../tests/fixtures/transcribe.json"));
        assert_eq!(result(Kind::Transcribe, &value), "…\n");
    }

    #[test]
    fn an_empty_transcript_is_an_empty_line() {
        let value = fixture(r#"{"type":"result","text":""}"#);
        assert_eq!(result(Kind::Transcribe, &value), "\n");
    }

    #[test]
    fn several_files_get_tail_headers() {
        assert_eq!(file_header("a.m4a", true), "==> a.m4a <==\n");
        assert_eq!(file_header("b.mov", false), "\n==> b.mov <==\n");
    }

    #[test]
    fn dictate_prints_the_text_unless_pasted() {
        let value = fixture(include_str!("../tests/fixtures/dictate.json"));
        assert_eq!(result(Kind::Dictate { paste: false }, &value), "…\n");
        assert_eq!(result(Kind::Dictate { paste: true }, &value), "");
        let live = fixture(r#"{"type":"result","text":null,"live":true}"#);
        assert_eq!(result(Kind::Dictate { paste: false }, &live), "");
    }

    #[test]
    fn stop_says_what_happened() {
        let value = fixture(include_str!("../tests/fixtures/stop.json"));
        assert_eq!(result(Kind::Stop, &value), "Stopped the Dictation.\n");
        let nothing = fixture(r#"{"type":"result","stopped":false}"#);
        assert_eq!(result(Kind::Stop, &nothing), "No Dictation was running.\n");
    }

    #[test]
    fn status_is_key_value_lines() {
        let value = fixture(include_str!("../tests/fixtures/status.json"));
        assert_eq!(
            result(Kind::Status, &value),
            "app: Codictate 0.0.62 (stable, app.codictate)\n\
             contract: 1\n\
             onboarding: completed\n\
             microphone: granted\n\
             command-line control: off\n\
             dictation: idle\n\
             speech model: Large V3 Turbo (large-v3-turbo-q5_0, whisper)\n\
             transcription language: Auto-detect (auto)\n\
             file transcriptions: 0 running, 0 queued\n"
        );
    }

    #[test]
    fn status_shows_a_running_dictation_and_a_missing_model() {
        let value = fixture(
            r#"{"type":"result","dictation":{"active":true,"startedBy":"command-line"},
               "speechModel":{"id":"x","label":"X","engine":"parakeet","installed":false},
               "somethingNew":42}"#,
        );
        assert_eq!(
            result(Kind::Status, &value),
            "dictation: running (started by command-line)\n\
             speech model: X (x, parakeet), not installed\n"
        );
    }

    #[test]
    fn models_list_is_a_table() {
        let value = fixture(include_str!("../tests/fixtures/models-list.json"));
        assert_eq!(
            result(Kind::ModelsList, &value),
            "  ID                   NAME            ENGINE   SIZE    STATUS\n\
             * large-v3-turbo-q5_0  Large V3 Turbo  whisper  574 MB  installed, bundled\n"
        );
    }

    #[test]
    fn models_list_aligns_several_rows() {
        let value = fixture(
            r#"{"type":"result","models":[
                {"id":"a","label":"Alpha","engine":"whisper","downloadSizeMB":1620,"installed":false,"selected":false},
                {"id":"parakeet-tdt-0.6b-v3","label":"Parakeet","engine":"parakeet","downloadSizeMB":480,"installed":true,"selected":true}]}"#,
        );
        assert_eq!(
            result(Kind::ModelsList, &value),
            "  ID                    NAME      ENGINE    SIZE    STATUS\n\
             \x20 a                     Alpha     whisper   1.6 GB  not installed\n\
             * parakeet-tdt-0.6b-v3  Parakeet  parakeet  480 MB  installed\n"
        );
    }

    #[test]
    fn model_changes_name_the_model() {
        let value = fixture(include_str!("../tests/fixtures/models-use.json"));
        assert_eq!(
            result(Kind::ModelsUse, &value),
            "Selected parakeet-tdt-0.6b-v3\n"
        );
        assert_eq!(
            result(Kind::ModelsDownload, &value),
            "Downloaded parakeet-tdt-0.6b-v3\n"
        );
        assert_eq!(
            result(Kind::ModelsRemove, &value),
            "Removed parakeet-tdt-0.6b-v3\n"
        );
    }

    #[test]
    fn languages_list_is_a_table() {
        let value = fixture(include_str!("../tests/fixtures/languages-list.json"));
        assert_eq!(
            result(Kind::LanguagesList, &value),
            "  ID    NAME\n* auto  Auto-detect\n"
        );
        let more = fixture(
            r#"{"type":"result","languages":[
                {"id":"auto","label":"Auto-detect","selected":true,"allowed":true},
                {"id":"da","label":"Danish","selected":false,"allowed":false}]}"#,
        );
        assert_eq!(
            result(Kind::LanguagesList, &more),
            "  ID    NAME\n\
             * auto  Auto-detect\n\
             \x20 da    Danish       not allowed by the selected Speech Model\n"
        );
    }

    #[test]
    fn languages_use_names_the_language() {
        let value = fixture(include_str!("../tests/fixtures/languages-use.json"));
        assert_eq!(result(Kind::LanguagesUse, &value), "Selected da\n");
    }

    #[test]
    fn every_documented_event_has_progress_text() {
        let texts: Vec<_> = include_str!("../tests/fixtures/events.ndjson")
            .lines()
            .map(|l| progress(&fixture(l), "press Enter to stop").unwrap())
            .collect();
        assert_eq!(
            texts,
            vec![
                "Waiting in the queue (position 2)",
                "Decoding audio... 0:00",
                "Transcribing... 0:12 (52:02 of audio)",
                "Recording... press Enter to stop",
                "Transcribing...",
                "Downloading... 42%",
            ]
        );
    }

    #[test]
    fn unknown_events_and_results_have_no_progress() {
        assert_eq!(progress(&fixture(r#"{"type":"result"}"#), ""), None);
        assert_eq!(progress(&fixture(r#"{"type":"brand-new"}"#), ""), None);
        assert_eq!(progress(&fixture(r#"{"no":"type"}"#), ""), None);
    }

    #[test]
    fn durations() {
        assert_eq!(duration(0.4), "0:00");
        assert_eq!(duration(65.0), "1:05");
        assert_eq!(duration(3721.0), "1:02:01");
    }
}
