//! Pure translation between Codictate's swallow rules and Hyprland binds.
//!
//! Nothing here touches a socket, so all of it is unit tested.

use crate::keyboard::protocol::{DesktopBinding, KeyEventMessage, SwallowRule};
use serde::Deserialize;

/// Hyprland modmask bits (`HL_MODIFIER_*`).
pub const MOD_SHIFT: u32 = 1;
pub const MOD_CAPS: u32 = 2;
pub const MOD_CTRL: u32 = 4;
pub const MOD_ALT: u32 = 8;
pub const MOD_MOD2: u32 = 16;
pub const MOD_MOD3: u32 = 32;
pub const MOD_SUPER: u32 = 64;
pub const MOD_MOD5: u32 = 128;

/// Every Codictate bind's description carries this marker followed by the
/// helper's token, so Codictate's own binds (including stale ones left by a
/// helper that crashed) can be told apart from the desktop's.
pub const DESCRIPTION_MARKER: &str = "[codictate:";

/// macOS virtual keycodes of Modifiers. Rules on these keys are modifier-only
/// Presets, which have no Hyprland equivalent and are hidden on Linux.
const MODIFIER_KEYCODES: [i32; 11] = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 179];

/// A Trigger Key Codictate can bind on Linux.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TriggerKey {
    /// macOS virtual keycode, the key identity used by the Bun side.
    pub mac_keycode: i32,
    /// xkb keycode (evdev code + 8), what Hyprland's `code:N` binds and
    /// `hl.is_key_down(N)` use. Physical, so independent of the keyboard layout.
    pub xkb_keycode: u32,
    /// Hyprland/xkb key name, for logs and readable descriptions.
    pub name: &'static str,
}

const TRIGGER_KEYS: [TriggerKey; 17] = [
    key(49, 65, "SPACE"),
    key(36, 36, "RETURN"),
    key(53, 9, "ESCAPE"),
    key(48, 23, "TAB"),
    key(51, 22, "BACKSPACE"),
    key(122, 67, "F1"),
    key(120, 68, "F2"),
    key(99, 69, "F3"),
    key(118, 70, "F4"),
    key(96, 71, "F5"),
    key(97, 72, "F6"),
    key(98, 73, "F7"),
    key(100, 74, "F8"),
    key(101, 75, "F9"),
    key(109, 76, "F10"),
    key(103, 95, "F11"),
    key(111, 96, "F12"),
];

const fn key(mac_keycode: i32, xkb_keycode: u32, name: &'static str) -> TriggerKey {
    TriggerKey {
        mac_keycode,
        xkb_keycode,
        name,
    }
}

pub fn trigger_key(mac_keycode: i32) -> Option<TriggerKey> {
    TRIGGER_KEYS
        .iter()
        .copied()
        .find(|key| key.mac_keycode == mac_keycode)
}

pub fn is_modifier_keycode(mac_keycode: i32) -> bool {
    MODIFIER_KEYCODES.contains(&mac_keycode)
}

/// One Hyprland bind derived from one swallow rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HyprBind {
    /// Index of the rule in the `configure` payload; travels through the
    /// `codictate:<token>:down|up:<index>` event.
    pub rule_index: usize,
    pub trigger: TriggerKey,
    pub modmask: u32,
    /// The key string handed to `hl.bind` / `hl.unbind`, e.g. `ALT + code:65`.
    pub keys: String,
    option: bool,
    left_option: bool,
    right_option: bool,
    command: bool,
    control: bool,
    shift: bool,
}

impl HyprBind {
    pub fn key_event(&self, key_down: bool) -> KeyEventMessage {
        // A release carries no Modifier flags: the Bun matcher only needs the
        // Trigger Key to go up, and the modifiers may already have been released.
        let held = key_down;
        KeyEventMessage {
            keycode: self.trigger.mac_keycode,
            option: held && self.option,
            left_option: held && self.left_option,
            right_option: held && self.right_option,
            command: held && self.command,
            control: held && self.control,
            shift: held && self.shift,
            function: false,
            key_down,
            is_repeat: false,
        }
    }
}

pub fn modmask_for_rule(rule: &SwallowRule) -> u32 {
    let mut mask = 0;
    if rule.shift {
        mask |= MOD_SHIFT;
    }
    if rule.control {
        mask |= MOD_CTRL;
    }
    if rule.option {
        mask |= MOD_ALT;
    }
    if rule.command {
        mask |= MOD_SUPER;
    }
    mask
}

/// Hyprland modifier names for a modmask, in a fixed order, e.g. `SUPER + ALT`.
pub fn modmask_names(modmask: u32) -> Vec<&'static str> {
    [
        (MOD_SUPER, "SUPER"),
        (MOD_CTRL, "CTRL"),
        (MOD_ALT, "ALT"),
        (MOD_SHIFT, "SHIFT"),
        (MOD_CAPS, "CAPS"),
        (MOD_MOD2, "MOD2"),
        (MOD_MOD3, "MOD3"),
        (MOD_MOD5, "MOD5"),
    ]
    .into_iter()
    .filter(|(bit, _)| modmask & bit != 0)
    .map(|(_, name)| name)
    .collect()
}

/// The `hl.bind` key string. The Trigger Key is bound by physical keycode
/// (`code:N`), which also gives the bind a display key no hand-written
/// `ALT + SPACE` in the user's config can collide with when it is unbound.
pub fn bind_keys(modmask: u32, trigger: TriggerKey) -> String {
    let mut parts = modmask_names(modmask)
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    parts.push(format!("code:{}", trigger.xkb_keycode));
    parts.join(" + ")
}

/// Every rule with a bindable Trigger Key becomes one bind. Rules on a
/// Modifier keycode, on Fn, or on an unknown key are skipped, and a second
/// rule for an already-bound combination is dropped (first index wins).
pub fn binds_for_rules(rules: &[SwallowRule]) -> Vec<HyprBind> {
    let mut binds: Vec<HyprBind> = Vec::new();
    for (rule_index, rule) in rules.iter().enumerate() {
        if rule.function || is_modifier_keycode(rule.keycode) {
            continue;
        }
        let Some(trigger) = trigger_key(rule.keycode) else {
            continue;
        };
        let modmask = modmask_for_rule(rule);
        let keys = bind_keys(modmask, trigger);
        if binds.iter().any(|bind| bind.keys == keys) {
            continue;
        }
        binds.push(HyprBind {
            rule_index,
            trigger,
            modmask,
            keys,
            option: rule.option,
            left_option: rule.option && rule.left_option.unwrap_or(true),
            right_option: rule.option && rule.right_option.unwrap_or(false),
            command: rule.command,
            control: rule.control,
            shift: rule.shift,
        });
    }
    binds
}

pub fn bind_description(token: &str) -> String {
    format!("Codictate Dictation Shortcut {DESCRIPTION_MARKER}{token}]")
}

/// The custom event a bind dispatches, minus the rule index.
pub fn event_prefix(token: &str, down: bool) -> String {
    let edge = if down { "down" } else { "up" };
    format!("codictate:{token}:{edge}:")
}

#[cfg(test)]
pub fn event_name(token: &str, down: bool, rule_index: usize) -> String {
    format!("{}{rule_index}", event_prefix(token, down))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Socket2Event {
    Key {
        token: String,
        down: bool,
        rule_index: usize,
    },
    ConfigReloaded,
}

/// Parses one `.socket2.sock` line (`EVENT>>DATA`). Everything that is not a
/// Codictate key event or a config reload is `None`.
pub fn parse_socket2_line(line: &str) -> Option<Socket2Event> {
    let (event, data) = line.trim_end_matches(['\r', '\n']).split_once(">>")?;
    match event {
        "configreloaded" => Some(Socket2Event::ConfigReloaded),
        "custom" => {
            let rest = data.strip_prefix("codictate:")?;
            let mut parts = rest.split(':');
            let token = parts.next()?;
            let down = match parts.next()? {
                "down" => true,
                "up" => false,
                _ => return None,
            };
            let rule_index = parts.next()?.parse::<usize>().ok()?;
            if token.is_empty() || parts.next().is_some() {
                return None;
            }
            Some(Socket2Event::Key {
                token: token.to_string(),
                down,
                rule_index,
            })
        }
        _ => None,
    }
}

#[derive(Deserialize)]
struct HyprlandBindJson {
    #[serde(default)]
    modmask: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    keycode: u32,
    #[serde(default)]
    description: String,
    #[serde(default)]
    submap: String,
    #[serde(default)]
    catch_all: bool,
    #[serde(default)]
    mouse: bool,
}

/// Converts `j/binds` output into the desktop's own bindings: Codictate's
/// binds, submap-only binds, catch-alls and mouse binds are not conflicts
/// for a global keyboard Preset and are left out.
pub fn desktop_bindings_from_json(json: &str) -> Result<Vec<DesktopBinding>, String> {
    let binds = serde_json::from_str::<Vec<HyprlandBindJson>>(json)
        .map_err(|err| format!("invalid Hyprland binds JSON: {err}"))?;
    Ok(binds
        .into_iter()
        .filter(|bind| {
            !bind.description.contains(DESCRIPTION_MARKER)
                && bind.submap.is_empty()
                && !bind.catch_all
                && !bind.mouse
        })
        .filter_map(|bind| {
            let key = if !bind.key.is_empty() {
                bind.key
            } else if bind.keycode > 0 {
                format!("code:{}", bind.keycode)
            } else {
                return None;
            };
            Some(DesktopBinding {
                modmask: bind.modmask,
                key,
                description: bind.description,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(keycode: i32) -> SwallowRule {
        SwallowRule {
            keycode,
            option: false,
            left_option: None,
            right_option: None,
            command: false,
            control: false,
            shift: false,
            function: false,
        }
    }

    #[test]
    fn alt_space_maps_to_keycode_bind() {
        let binds = binds_for_rules(&[SwallowRule {
            option: true,
            ..rule(49)
        }]);
        assert_eq!(binds.len(), 1);
        assert_eq!(binds[0].keys, "ALT + code:65");
        assert_eq!(binds[0].modmask, MOD_ALT);
        assert_eq!(binds[0].rule_index, 0);
        assert_eq!(binds[0].trigger.name, "SPACE");
    }

    #[test]
    fn every_modifier_maps_to_hyprland_names_in_fixed_order() {
        let binds = binds_for_rules(&[SwallowRule {
            option: true,
            command: true,
            control: true,
            shift: true,
            ..rule(122)
        }]);
        assert_eq!(binds[0].keys, "SUPER + CTRL + ALT + SHIFT + code:67");
        assert_eq!(binds[0].modmask, MOD_SUPER | MOD_CTRL | MOD_ALT | MOD_SHIFT);
    }

    #[test]
    fn unmodified_trigger_key_has_no_modifier_prefix() {
        let binds = binds_for_rules(&[rule(120)]);
        assert_eq!(binds[0].keys, "code:68");
        assert_eq!(binds[0].modmask, 0);
    }

    #[test]
    fn trigger_keys_map_to_xkb_keycodes() {
        let expected = [
            (49, 65),
            (36, 36),
            (122, 67),
            (120, 68),
            (53, 9),
            (48, 23),
            (51, 22),
        ];
        for (mac, xkb) in expected {
            assert_eq!(trigger_key(mac).unwrap().xkb_keycode, xkb, "mac {mac}");
        }
    }

    #[test]
    fn modifier_fn_and_unknown_rules_are_skipped() {
        let mut rules = MODIFIER_KEYCODES.map(rule).to_vec();
        rules.push(SwallowRule {
            function: true,
            ..rule(49)
        });
        rules.push(rule(0));
        assert!(binds_for_rules(&rules).is_empty());
    }

    #[test]
    fn duplicate_combinations_keep_the_first_rule_index() {
        let alt_space = SwallowRule {
            option: true,
            ..rule(49)
        };
        let binds = binds_for_rules(&[
            SwallowRule {
                option: true,
                ..rule(58)
            },
            alt_space.clone(),
            alt_space,
            SwallowRule {
                control: true,
                ..rule(49)
            },
        ]);
        let summary = binds
            .iter()
            .map(|bind| (bind.rule_index, bind.keys.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(summary, vec![(1, "ALT + code:65"), (3, "CTRL + code:65")]);
    }

    #[test]
    fn key_events_follow_the_rule_on_press_and_clear_modifiers_on_release() {
        let bind = binds_for_rules(&[SwallowRule {
            option: true,
            shift: true,
            ..rule(49)
        }])
        .remove(0);

        let down = serde_json::to_value(bind.key_event(true)).unwrap();
        assert_eq!(
            down,
            serde_json::json!({
                "keycode": 49, "option": true, "leftOption": true, "rightOption": false,
                "command": false, "control": false, "shift": true, "fn": false,
                "keyDown": true, "isRepeat": false,
            })
        );

        let up = serde_json::to_value(bind.key_event(false)).unwrap();
        assert_eq!(
            up,
            serde_json::json!({
                "keycode": 49, "option": false, "leftOption": false, "rightOption": false,
                "command": false, "control": false, "shift": false, "fn": false,
                "keyDown": false, "isRepeat": false,
            })
        );
    }

    #[test]
    fn left_right_option_flags_are_only_set_with_option() {
        let bind = binds_for_rules(&[SwallowRule {
            control: true,
            left_option: Some(true),
            ..rule(49)
        }])
        .remove(0);
        let down = bind.key_event(true);
        assert!(!down.option && !down.left_option && !down.right_option);
    }

    #[test]
    fn modmask_names_cover_every_bit() {
        assert_eq!(
            modmask_names(255),
            vec![
                "SUPER", "CTRL", "ALT", "SHIFT", "CAPS", "MOD2", "MOD3", "MOD5"
            ]
        );
        assert!(modmask_names(0).is_empty());
    }

    #[test]
    fn socket2_key_events_parse() {
        assert_eq!(
            parse_socket2_line("custom>>codictate:ab12:down:3\n"),
            Some(Socket2Event::Key {
                token: "ab12".to_string(),
                down: true,
                rule_index: 3,
            })
        );
        assert_eq!(
            parse_socket2_line("custom>>codictate:ab12:up:0"),
            Some(Socket2Event::Key {
                token: "ab12".to_string(),
                down: false,
                rule_index: 0,
            })
        );
    }

    #[test]
    fn socket2_config_reload_parses() {
        assert_eq!(
            parse_socket2_line("configreloaded>>"),
            Some(Socket2Event::ConfigReloaded)
        );
    }

    #[test]
    fn socket2_ignores_everything_else() {
        for line in [
            "",
            "workspace>>2",
            "activewindow>>kitty,~",
            "custom>>something-else",
            "custom>>codictate:ab12:sideways:1",
            "custom>>codictate:ab12:down:x",
            "custom>>codictate::down:1",
            "custom>>codictate:ab12:down:1:extra",
        ] {
            assert_eq!(parse_socket2_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn event_names_round_trip_through_the_parser() {
        let line = format!("custom>>{}", event_name("f00d", false, 7));
        assert_eq!(
            parse_socket2_line(&line),
            Some(Socket2Event::Key {
                token: "f00d".to_string(),
                down: false,
                rule_index: 7,
            })
        );
    }

    #[test]
    fn desktop_bindings_exclude_codictate_submap_mouse_and_catchall_binds() {
        let json = serde_json::json!([
            {"modmask": 64, "key": "V", "keycode": 0, "description": "Universal paste", "submap": ""},
            {"modmask": 8, "key": "", "keycode": 0, "description": bind_description("abc"), "submap": ""},
            {"modmask": 8, "key": "SPACE", "keycode": 0, "description": "Codictate Dictation Shortcut [codictate:stale]", "submap": ""},
            {"modmask": 0, "key": "ESCAPE", "keycode": 0, "description": "leave", "submap": "resize"},
            {"modmask": 64, "key": "mouse:272", "keycode": 0, "description": "Move", "submap": "", "mouse": true},
            {"modmask": 0, "key": "", "keycode": 0, "description": "", "submap": "x", "catch_all": true},
            {"modmask": 64, "key": "", "keycode": 10, "description": "Workspace 1", "submap": ""},
            {"modmask": 64, "key": "", "keycode": 0, "description": "Unknown key", "submap": ""}
        ])
        .to_string();
        let bindings = desktop_bindings_from_json(&json).unwrap();
        assert_eq!(
            bindings,
            vec![
                DesktopBinding {
                    modmask: 64,
                    key: "V".to_string(),
                    description: "Universal paste".to_string(),
                },
                DesktopBinding {
                    modmask: 64,
                    key: "code:10".to_string(),
                    description: "Workspace 1".to_string(),
                },
            ]
        );
    }

    #[test]
    fn desktop_bindings_reject_invalid_json() {
        assert!(desktop_bindings_from_json("ok").is_err());
    }
}
