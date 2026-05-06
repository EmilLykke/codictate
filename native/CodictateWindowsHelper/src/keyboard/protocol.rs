use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct SwallowRule {
    pub keycode: i32,
    pub option: bool,
    #[serde(default, rename = "leftOption")]
    pub left_option: Option<bool>,
    #[serde(default, rename = "rightOption")]
    pub right_option: Option<bool>,
    pub command: bool,
    pub control: bool,
    pub shift: bool,
    #[serde(rename = "fn")]
    pub function: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command")]
pub enum KeyboardHookCommand {
    #[serde(rename = "configure")]
    Configure { swallow: Vec<SwallowRule> },
    #[serde(rename = "set_clipboard")]
    SetClipboard { text: String },
    #[serde(rename = "paste_text")]
    PasteText { text: String },
    #[serde(rename = "replace_text")]
    ReplaceText {
        #[serde(rename = "deleteText")]
        delete_text: String,
        text: String,
    },
    #[serde(rename = "check_permissions")]
    CheckPermissions,
    #[serde(rename = "request_input_monitoring")]
    RequestInputMonitoring,
    #[serde(rename = "prompt_accessibility")]
    PromptAccessibility,
    #[serde(rename = "request_microphone")]
    RequestMicrophone,
}

#[derive(Clone, Copy, Serialize)]
pub struct KeyEventMessage {
    pub keycode: i32,
    pub option: bool,
    #[serde(rename = "leftOption")]
    pub left_option: bool,
    #[serde(rename = "rightOption")]
    pub right_option: bool,
    pub command: bool,
    pub control: bool,
    pub shift: bool,
    #[serde(rename = "fn")]
    pub function: bool,
    #[serde(rename = "keyDown")]
    pub key_down: bool,
    #[serde(rename = "isRepeat")]
    pub is_repeat: bool,
}

#[derive(Serialize)]
pub struct PermissionsMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "inputMonitoring")]
    input_monitoring: bool,
    microphone: bool,
    accessibility: bool,
}

impl PermissionsMessage {
    pub fn new(microphone: bool, accessibility: bool) -> Self {
        Self {
            kind: "permissions",
            input_monitoring: true,
            microphone,
            accessibility,
        }
    }
}

#[derive(Serialize)]
pub struct KeyboardStartedMessage {
    status: &'static str,
    platform: &'static str,
    #[serde(rename = "inputMonitoring")]
    input_monitoring: bool,
    microphone: bool,
    accessibility: bool,
}

impl KeyboardStartedMessage {
    pub fn new(microphone: bool, accessibility: bool) -> Self {
        Self {
            status: "started",
            platform: "windows",
            input_monitoring: true,
            microphone,
            accessibility,
        }
    }
}

#[derive(Serialize)]
pub struct ClipboardSetMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    success: bool,
}

impl ClipboardSetMessage {
    pub fn new(success: bool) -> Self {
        Self {
            kind: "clipboard_set",
            success,
        }
    }
}

#[derive(Serialize)]
pub struct PasteResultMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    success: bool,
    accessibility: bool,
    message: &'static str,
}

impl PasteResultMessage {
    pub fn new(success: bool, accessibility: bool, message: &'static str) -> Self {
        Self {
            kind: "paste_result",
            success,
            accessibility,
            message,
        }
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

    pub fn permission_requested(message: impl Into<String>) -> Self {
        Self {
            status: "permission_requested",
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_event_serializes_to_bun_protocol() {
        let value = serde_json::to_value(KeyEventMessage {
            keycode: 49,
            option: true,
            left_option: true,
            right_option: false,
            command: false,
            control: false,
            shift: false,
            function: false,
            key_down: true,
            is_repeat: false,
        })
        .unwrap();

        assert_eq!(value["keycode"], 49);
        assert_eq!(value["leftOption"], true);
        assert_eq!(value["keyDown"], true);
        assert_eq!(value["isRepeat"], false);
        assert_eq!(value["fn"], false);
    }

    #[test]
    fn paste_result_serializes_to_bun_protocol() {
        let value = serde_json::to_value(PasteResultMessage::new(true, true, "ok")).unwrap();
        assert_eq!(value["type"], "paste_result");
        assert_eq!(value["success"], true);
        assert_eq!(value["accessibility"], true);
        assert_eq!(value["message"], "ok");
    }
}
