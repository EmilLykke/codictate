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
    /// Linux only: report the desktop's own shortcut bindings so the Bun side can
    /// hide Presets that would be a Shortcut Conflict.
    #[cfg(not(windows))]
    #[serde(rename = "list_desktop_bindings")]
    ListDesktopBindings,
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
    /// Linux only (`"hyprland"` or `"unavailable"`); never serialized on Windows.
    #[serde(rename = "shortcutBackend", skip_serializing_if = "Option::is_none")]
    shortcut_backend: Option<&'static str>,
}

impl KeyboardStartedMessage {
    #[cfg(windows)]
    pub fn new(microphone: bool, accessibility: bool) -> Self {
        Self {
            status: "started",
            platform: "windows",
            input_monitoring: true,
            microphone,
            accessibility,
            shortcut_backend: None,
        }
    }

    #[cfg(not(windows))]
    pub fn linux(microphone: bool, shortcut_backend: &'static str) -> Self {
        Self {
            status: "started",
            platform: "linux",
            input_monitoring: true,
            microphone,
            accessibility: true,
            shortcut_backend: Some(shortcut_backend),
        }
    }
}

/// One desktop shortcut binding, as reported by the compositor.
#[cfg(not(windows))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopBinding {
    pub modmask: u32,
    pub key: String,
    pub description: String,
}

#[cfg(not(windows))]
#[derive(Serialize)]
pub struct DesktopBindingsMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    bindings: Vec<DesktopBinding>,
}

#[cfg(not(windows))]
impl DesktopBindingsMessage {
    pub fn new(bindings: Vec<DesktopBinding>) -> Self {
        Self {
            kind: "desktop_bindings",
            bindings,
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

    #[cfg(windows)]
    #[test]
    fn windows_started_message_has_no_shortcut_backend() {
        let value = serde_json::to_value(KeyboardStartedMessage::new(true, true)).unwrap();
        assert_eq!(value["platform"], "windows");
        assert!(value.get("shortcutBackend").is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn linux_started_message_serializes_to_bun_protocol() {
        let value = serde_json::to_value(KeyboardStartedMessage::linux(false, "hyprland")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "status": "started",
                "platform": "linux",
                "inputMonitoring": true,
                "microphone": false,
                "accessibility": true,
                "shortcutBackend": "hyprland",
            })
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn list_desktop_bindings_command_parses() {
        let command =
            serde_json::from_str::<KeyboardHookCommand>(r#"{"command":"list_desktop_bindings"}"#)
                .unwrap();
        assert!(matches!(command, KeyboardHookCommand::ListDesktopBindings));
    }

    #[cfg(not(windows))]
    #[test]
    fn desktop_bindings_serialize_to_bun_protocol() {
        let value = serde_json::to_value(DesktopBindingsMessage::new(vec![DesktopBinding {
            modmask: 64,
            key: "V".to_string(),
            description: "Universal paste".to_string(),
        }]))
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "desktop_bindings",
                "bindings": [{"modmask": 64, "key": "V", "description": "Universal paste"}],
            })
        );
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
