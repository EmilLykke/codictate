use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndicatorStatus {
    #[default]
    Ready,
    Recording,
    Transcribing,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "command")]
pub enum IndicatorCommand {
    #[serde(rename = "show")]
    Show {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        status: IndicatorStatus,
    },
    #[serde(rename = "hide")]
    Hide,
    #[serde(rename = "status")]
    Status { status: IndicatorStatus },
    #[serde(rename = "quit")]
    Quit,
}

#[derive(Serialize)]
pub struct IndicatorStartedMessage {
    status: &'static str,
    platform: &'static str,
    kind: &'static str,
}

impl IndicatorStartedMessage {
    pub fn new() -> Self {
        Self {
            status: "started",
            platform: "windows",
            kind: "indicator",
        }
    }
}

#[derive(Serialize)]
pub struct MoveMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    x: i32,
    y: i32,
}

impl MoveMessage {
    pub fn new(x: i32, y: i32) -> Self {
        Self { kind: "move", x, y }
    }
}

#[derive(Serialize)]
pub struct StatusMessage {
    status: &'static str,
    message: String,
}

impl StatusMessage {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: "error",
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_message_serializes_to_bun_protocol() {
        let value = serde_json::to_value(MoveMessage::new(10, 20)).unwrap();
        assert_eq!(value["type"], "move");
        assert_eq!(value["x"], 10);
        assert_eq!(value["y"], 20);
    }

    #[test]
    fn status_deserializes_from_bun_command() {
        let command = serde_json::from_str::<IndicatorCommand>(
            r#"{"command":"status","status":"transcribing"}"#,
        )
        .unwrap();
        assert!(matches!(
            command,
            IndicatorCommand::Status {
                status: IndicatorStatus::Transcribing
            }
        ));
    }
}
