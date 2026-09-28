//! Lua chunks the helper evaluates inside Hyprland (`hyprctl eval` over the
//! request socket). Pure string generation, so it is unit tested.
//!
//! Hyprland 0.56 safety rules these chunks follow:
//! - Never keep or call methods on an `HL.Keybind` handle. In 0.56.2 every
//!   method on an *expired* handle (already removed, `hl.unbind`, or a config
//!   reload) dereferences null and segfaults the compositor. Binds are removed
//!   with `hl.unbind("<keys>")`, which matches the bind's display key string.
//! - Never pass `"all"` to `hl.unbind` (it clears every bind).
//! - Only oneshot timers: disabled repeat timers are never freed until reload,
//!   oneshots are released after they fire.
//! - Every chunk starts with `do`, so Hyprland's `return <chunk>;` probe fails
//!   to parse and the chunk runs as plain statements.

use super::binds::{HyprBind, event_prefix};

/// How often the pressed Trigger Key is polled after its bind fired.
pub const KEY_POLL_INTERVAL_MS: u32 = 16;
/// Delay between the paste keystroke's down and up (Omarchy's universal paste
/// uses the same split to avoid Hyprland leaving synthetic key state stuck).
pub const PASTE_KEY_UP_DELAY_MS: u32 = 50;
/// BackSpaces sent per Hyprland event-loop tick, so a long delete neither hits
/// Hyprland's per-callback Lua timeout nor floods the client in one burst.
pub const BACKSPACE_BATCH: usize = 25;
pub const BACKSPACE_BATCH_INTERVAL_MS: u32 = 5;

/// A Lua string literal for any Rust string.
pub fn lua_str(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for byte in value.bytes() {
        match byte {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(byte as char),
            other => out.push_str(&format!("\\{other:03}")),
        }
    }
    out.push('"');
    out
}

fn lua_str_list<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    let items = values.into_iter().map(lua_str).collect::<Vec<_>>();
    format!("{{ {} }}", items.join(", "))
}

/// Registers `binds` for `token`, first unbinding `previous_keys` (the key
/// strings this helper registered before). Each bind's action announces the
/// press as `custom>>codictate:<token>:down:<i>`, then polls
/// `hl.is_key_down(<xkb keycode>)` and announces `...:up:<i>` once the Trigger
/// Key is up. Polling rather than a release bind, because a release bind may
/// not fire when the user lets go of the Modifier before the key.
pub fn register_chunk(
    token: &str,
    description: &str,
    previous_keys: &[String],
    binds: &[HyprBind],
) -> String {
    let mut lua = format!(
        r#"do
  local root = rawget(_G, "__codictate") or {{}}
  _G.__codictate = root
  local previous = root[{token}]
  if previous then previous.active = false end
  for _, keys in ipairs({previous_keys}) do hl.unbind(keys) end
  local state = {{ active = true, down = {{}} }}
  root[{token}] = state
  local function poll(index, code)
    if not state.active then return end
    if hl.is_key_down(code) then
      hl.timer(function() poll(index, code) end, {{ timeout = {interval}, type = "oneshot" }})
      return
    end
    state.down[index] = nil
    hl.dispatch(hl.dsp.event({up_prefix} .. index))
  end
  local function press(index, code)
    return function()
      if not state.active or state.down[index] then return end
      state.down[index] = true
      hl.dispatch(hl.dsp.event({down_prefix} .. index))
      hl.timer(function() poll(index, code) end, {{ timeout = {interval}, type = "oneshot" }})
    end
  end
  local failures = {{}}
  local function add(keys, index, code)
    local ok, err = pcall(hl.bind, keys, press(index, code), {{ description = {description} }})
    if not ok then failures[#failures + 1] = keys .. ": " .. tostring(err) end
  end
"#,
        token = lua_str(token),
        previous_keys = lua_str_list(previous_keys.iter().map(String::as_str)),
        interval = KEY_POLL_INTERVAL_MS,
        up_prefix = lua_str(&event_prefix(token, false)),
        down_prefix = lua_str(&event_prefix(token, true)),
        description = lua_str(description),
    );
    for bind in binds {
        lua.push_str(&format!(
            "  add({}, {}, {})\n",
            lua_str(&bind.keys),
            bind.rule_index,
            bind.trigger.xkb_keycode
        ));
    }
    lua.push_str("  if #failures > 0 then error(table.concat(failures, \"; \")) end\nend");
    lua
}

/// Removes every bind this helper registered and stops any running poll.
pub fn unregister_chunk(token: &str, keys: &[String]) -> String {
    format!(
        r#"do
  local root = rawget(_G, "__codictate")
  local state = root and root[{token}]
  if state then
    state.active = false
    root[{token}] = nil
  end
  for _, keys in ipairs({keys}) do hl.unbind(keys) end
end"#,
        token = lua_str(token),
        keys = lua_str_list(keys.iter().map(String::as_str)),
    )
}

/// Sends `backspaces` BackSpace presses and then the paste keystroke, the way
/// Omarchy's universal paste does it: SHIFT+Insert in a window tagged
/// `terminal` (dynamic tags carry a trailing `*`), CTRL+V everywhere else,
/// with explicit mods so physically held Modifiers do not leak into the chord.
pub fn paste_chunk(backspaces: usize) -> String {
    format!(
        r#"do
  local function key_state(mods, key, state)
    hl.dispatch(hl.dsp.send_key_state({{ mods = mods, key = key, state = state }}))
  end
  local function active_window_is_terminal()
    local window = hl.get_active_window()
    if not window then return false end
    for _, tag in ipairs(window.tags or {{}}) do
      if tostring(tag):gsub("%*$", "") == "terminal" then return true end
    end
    return false
  end
  local function paste()
    local mods, key = "CTRL", "V"
    if active_window_is_terminal() then mods, key = "SHIFT", "Insert" end
    key_state(mods, key, "down")
    hl.timer(function() key_state(mods, key, "up") end, {{ timeout = {up_delay}, type = "oneshot" }})
  end
{erase}
  erase(paste)
end"#,
        up_delay = PASTE_KEY_UP_DELAY_MS,
        erase = erase_function(backspaces),
    )
}

/// Only the BackSpace presses, then nothing.
pub fn backspaces_chunk(backspaces: usize) -> String {
    format!(
        r#"do
  local function key_state(mods, key, state)
    hl.dispatch(hl.dsp.send_key_state({{ mods = mods, key = key, state = state }}))
  end
{erase}
  erase(function() end)
end"#,
        erase = erase_function(backspaces),
    )
}

/// One unmodified key press (down, then up).
pub fn key_tap_chunk(key: &str) -> String {
    format!(
        r#"do
  hl.dispatch(hl.dsp.send_key_state({{ mods = "", key = {key}, state = "down" }}))
  hl.dispatch(hl.dsp.send_key_state({{ mods = "", key = {key}, state = "up" }}))
end"#,
        key = lua_str(key),
    )
}

/// `erase(done)`: BackSpace presses in batches of [`BACKSPACE_BATCH`] per
/// event-loop tick, calling `done` after the last one. With no more than one
/// batch everything, `done` included, runs synchronously inside the eval.
fn erase_function(backspaces: usize) -> String {
    format!(
        r#"  local remaining = {backspaces}
  local function erase(done)
    local batch = math.min(remaining, {batch})
    for _ = 1, batch do
      key_state("", "BackSpace", "down")
      key_state("", "BackSpace", "up")
    end
    remaining = remaining - batch
    if remaining > 0 then
      hl.timer(function() erase(done) end, {{ timeout = {interval}, type = "oneshot" }})
    else
      done()
    end
  end"#,
        batch = BACKSPACE_BATCH,
        interval = BACKSPACE_BATCH_INTERVAL_MS,
    )
}

/// How long [`backspaces_chunk`] keeps sending after its eval returned.
pub fn backspaces_duration_ms(backspaces: usize) -> u64 {
    let batches = backspaces.div_ceil(BACKSPACE_BATCH).max(1);
    (batches as u64 - 1) * u64::from(BACKSPACE_BATCH_INTERVAL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyboard::linux::binds::binds_for_rules;
    use crate::keyboard::protocol::SwallowRule;

    fn alt_space() -> SwallowRule {
        SwallowRule {
            keycode: 49,
            option: true,
            left_option: None,
            right_option: None,
            command: false,
            control: false,
            shift: false,
            function: false,
        }
    }

    #[test]
    fn lua_strings_escape_everything_unsafe() {
        assert_eq!(lua_str("ALT + code:65"), "\"ALT + code:65\"");
        assert_eq!(lua_str("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(lua_str("x\ny\0"), "\"x\\ny\\000\"");
        assert_eq!(lua_str("æ"), "\"\\195\\166\"");
    }

    #[test]
    fn register_chunk_binds_each_rule_by_keycode_and_polls_it() {
        let binds = binds_for_rules(&[alt_space()]);
        let lua = register_chunk("t0k", "Codictate [codictate:t0k]", &[], &binds);
        assert!(lua.starts_with("do\n"));
        assert!(lua.ends_with("\nend"));
        assert!(lua.contains("  add(\"ALT + code:65\", 0, 65)\n"));
        assert!(lua.contains("hl.dsp.event(\"codictate:t0k:down:\" .. index)"));
        assert!(lua.contains("hl.dsp.event(\"codictate:t0k:up:\" .. index)"));
        assert!(lua.contains("hl.is_key_down(code)"));
        assert!(lua.contains("{ timeout = 16, type = \"oneshot\" }"));
        assert!(lua.contains("description = \"Codictate [codictate:t0k]\""));
        assert!(lua.contains("for _, keys in ipairs({  }) do hl.unbind(keys) end"));
    }

    #[test]
    fn register_chunk_unbinds_the_previous_keys_first() {
        let lua = register_chunk("t", "d", &["ALT + code:65".to_string()], &[]);
        let unbind = lua
            .find("ipairs({ \"ALT + code:65\" }) do hl.unbind(keys) end")
            .unwrap();
        let bind = lua.find("local function add").unwrap();
        assert!(unbind < bind);
    }

    #[test]
    fn chunks_never_touch_keybind_handles_or_unbind_all() {
        let binds = binds_for_rules(&[alt_space()]);
        for lua in [
            register_chunk("t", "d", &["CTRL + code:36".to_string()], &binds),
            unregister_chunk("t", &["ALT + code:65".to_string()]),
            paste_chunk(3),
            backspaces_chunk(80),
            key_tap_chunk("space"),
        ] {
            assert!(!lua.contains(":remove("), "{lua}");
            assert!(!lua.contains(":unbind("), "{lua}");
            assert!(!lua.contains(":set_enabled("), "{lua}");
            assert!(!lua.contains("\"all\""), "{lua}");
            assert!(!lua.contains("\"repeat\""), "{lua}");
            assert!(lua.starts_with("do\n"), "{lua}");
            assert!(!lua.contains('\0'));
        }
    }

    #[test]
    fn unregister_chunk_unbinds_every_registered_key_string() {
        let lua = unregister_chunk(
            "tok",
            &["ALT + code:65".to_string(), "CTRL + code:36".to_string()],
        );
        assert!(lua.contains("root[\"tok\"] = nil"));
        assert!(lua.contains("ipairs({ \"ALT + code:65\", \"CTRL + code:36\" })"));
    }

    #[test]
    fn paste_chunk_replicates_omarchy_universal_paste() {
        let lua = paste_chunk(0);
        assert!(lua.contains("local mods, key = \"CTRL\", \"V\""));
        assert!(lua.contains("mods, key = \"SHIFT\", \"Insert\""));
        assert!(lua.contains("gsub(\"%*$\", \"\") == \"terminal\""));
        assert!(lua.contains("key_state(mods, key, \"down\")"));
        assert!(lua.contains("{ timeout = 50, type = \"oneshot\" }"));
        assert!(lua.contains("local remaining = 0\n"));
        assert!(lua.contains("erase(paste)"));
    }

    #[test]
    fn replace_chunk_sends_backspaces_before_the_paste() {
        let lua = paste_chunk(12);
        assert!(lua.contains("local remaining = 12\n"));
        assert!(lua.contains("key_state(\"\", \"BackSpace\", \"down\")"));
        assert!(lua.contains("math.min(remaining, 25)"));
    }

    #[test]
    fn key_tap_chunk_sends_down_then_up() {
        let lua = key_tap_chunk("space");
        let down = lua.find("state = \"down\"").unwrap();
        let up = lua.find("state = \"up\"").unwrap();
        assert!(down < up);
        assert!(lua.contains("key = \"space\""));
    }

    #[test]
    fn backspace_duration_counts_the_extra_batches() {
        assert_eq!(backspaces_duration_ms(0), 0);
        assert_eq!(backspaces_duration_ms(25), 0);
        assert_eq!(backspaces_duration_ms(26), 5);
        assert_eq!(backspaces_duration_ms(100), 15);
    }
}
