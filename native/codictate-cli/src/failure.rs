//! Error codes and exit codes, as the table in docs/CLI.md "Errors and exit codes" fixes them.

use serde_json::{Value, json};

/// The wire contract this client speaks (docs/CLI.md "Contract version").
pub const CONTRACT_VERSION: u32 = 1;

pub const EXIT_SIGINT: i32 = 130;
pub const EXIT_SIGTERM: i32 = 143;

/// Maps an `error.code` to the process exit code. An unknown code is an `internal` failure.
pub fn exit_code_for(code: &str) -> i32 {
    match code {
        "internal" | "output_unwritable" => 1,
        "usage"
        | "unknown_model"
        | "unknown_language"
        | "language_not_allowed"
        | "unknown_formatting_mode"
        | "model_bundled"
        | "cannot_translate"
        | "captions_unavailable" => 2,
        "input_unreadable" | "no_audio" => 3,
        "model_not_installed" => 4,
        "engine_failed" => 5,
        "app_unavailable" => 6,
        "command_line_control_off" => 7,
        "busy" => 8,
        "not_ready" => 9,
        "download_failed" => 10,
        "contract_mismatch" => 11,
        "cancelled" => EXIT_SIGINT,
        _ => 1,
    }
}

/// A command that did not succeed: either an `error` event from the app or one the client
/// raises itself (`usage`, `app_unavailable`, `cancelled`, `output_unwritable`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub exit: i32,
    /// The app sent this as an `error` event, so `--json` already printed it verbatim.
    pub from_app: bool,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            exit: exit_code_for(code),
            from_app: false,
        }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::new("usage", message)
    }

    pub fn app_unavailable(message: impl Into<String>) -> Self {
        Self::new("app_unavailable", message)
    }

    /// `-o` could not be written: `<path>: cannot write: <reason>`.
    pub fn output_unwritable(path: &std::path::Path, err: &std::io::Error) -> Self {
        Self::new(
            "output_unwritable",
            format!("{}: cannot write: {err}", path.display()),
        )
    }

    /// Cancelled by the user: exit 130 for SIGINT (Ctrl-C), 143 for SIGTERM.
    pub fn cancelled(exit: i32) -> Self {
        Self {
            exit,
            ..Self::new("cancelled", "Cancelled")
        }
    }

    /// An `error` event the app sent.
    pub fn from_event(event: &Value) -> Self {
        let code = event
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("internal");
        let message = event
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or(code);
        Self {
            from_app: true,
            ..Self::new(code, message)
        }
    }

    /// The `error` event a client-side failure is reported as under `--json`.
    pub fn to_event_line(&self) -> String {
        json!({"type": "error", "code": self.code, "message": self.message}).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_documented_code_maps_to_its_exit() {
        let table: &[(&str, i32)] = &[
            ("internal", 1),
            ("output_unwritable", 1),
            ("usage", 2),
            ("unknown_model", 2),
            ("unknown_language", 2),
            ("language_not_allowed", 2),
            ("unknown_formatting_mode", 2),
            ("model_bundled", 2),
            ("cannot_translate", 2),
            ("captions_unavailable", 2),
            ("input_unreadable", 3),
            ("no_audio", 3),
            ("model_not_installed", 4),
            ("engine_failed", 5),
            ("app_unavailable", 6),
            ("command_line_control_off", 7),
            ("busy", 8),
            ("not_ready", 9),
            ("download_failed", 10),
            ("contract_mismatch", 11),
            ("cancelled", 130),
        ];
        for (code, exit) in table {
            assert_eq!(exit_code_for(code), *exit, "{code}");
        }
    }

    #[test]
    fn an_unknown_code_is_internal() {
        assert_eq!(exit_code_for("something_new"), 1);
    }

    #[test]
    fn reads_the_documented_error_event() {
        let event: Value =
            serde_json::from_str(include_str!("../tests/fixtures/error.json")).unwrap();
        let failure = Failure::from_event(&event);
        assert_eq!(failure.code, "model_not_installed");
        assert_eq!(
            failure.message,
            "Speech Model large-v3-q5_0 is not installed"
        );
        assert_eq!(failure.exit, 4);
        assert!(failure.from_app);
    }

    #[test]
    fn an_error_event_without_fields_is_internal() {
        let failure = Failure::from_event(&json!({"type": "error"}));
        assert_eq!(failure.code, "internal");
        assert_eq!(failure.message, "internal");
        assert_eq!(failure.exit, 1);
    }

    #[test]
    fn cancellation_exit_follows_the_signal() {
        assert_eq!(Failure::cancelled(EXIT_SIGTERM).exit, 143);
        assert_eq!(Failure::cancelled(EXIT_SIGINT).code, "cancelled");
    }

    #[test]
    fn a_client_failure_serialises_as_an_error_event() {
        let line = Failure::app_unavailable("Codictate did not answer").to_event_line();
        let event: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(event["type"], "error");
        assert_eq!(event["code"], "app_unavailable");
        assert_eq!(event["message"], "Codictate did not answer");
    }
}
