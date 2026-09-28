//! Linux microphone discovery through the PulseAudio API that PipeWire
//! (`pipewire-pulse`) serves, read with `pactl -f json list sources`.
//!
//! cpal 0.16 only has an ALSA host on Linux, whose device list is PCM names
//! (`default`, `pipewire`, `sysdefault:CARD=...`) rather than microphones.
//! PipeWire sources carry the human-readable names; recording from one goes
//! through ALSA's `pulse` PCM with `PULSE_SOURCE` naming the source.

use serde::Deserialize;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulseSource {
    /// Stable source name, e.g. `alsa_input.usb-...analog-stereo`.
    pub name: String,
    /// Human-readable description, e.g. `Blue Yeti Analog Stereo`.
    pub description: String,
}

#[derive(Deserialize)]
struct SourceJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    properties: serde_json::Map<String, serde_json::Value>,
}

/// Capture sources only: output monitors (`device.class = monitor`, or a
/// `media.class` that is not an `Audio/Source`) record system audio, not a
/// microphone.
pub fn parse_sources_json(json: &str) -> Result<Vec<PulseSource>, String> {
    let sources = serde_json::from_str::<Vec<SourceJson>>(json)
        .map_err(|err| format!("invalid pactl sources JSON: {err}"))?;
    Ok(sources
        .into_iter()
        .filter(|source| !source.name.is_empty())
        .filter(|source| {
            let property = |key: &str| source.properties.get(key).and_then(|value| value.as_str());
            let monitor =
                property("device.class") == Some("monitor") || source.name.ends_with(".monitor");
            let capture = property("media.class")
                .map(|class| class.starts_with("Audio/Source"))
                .unwrap_or(true);
            !monitor && capture
        })
        .map(|source| PulseSource {
            description: if source.description.trim().is_empty() {
                source.name.clone()
            } else {
                source.description
            },
            name: source.name,
        })
        .collect())
}

/// `Err` when `pactl` is missing or no PulseAudio server answers.
pub fn list_capture_sources() -> Result<Vec<PulseSource>, String> {
    let output = Command::new("pactl")
        .args(["-f", "json", "list", "sources"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|err| format!("pactl failed to start: {err}"))?;
    if !output.status.success() {
        return Err(format!("pactl exited with {}", output.status));
    }
    parse_sources_json(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitors_are_not_microphones() {
        let json = serde_json::json!([
            {
                "name": "alsa_output.pci-0000_01_00.1.hdmi-stereo.monitor",
                "description": "Monitor of HDMI",
                "properties": {"device.class": "monitor", "media.class": "Audio/Sink"}
            },
            {
                "name": "alsa_input.usb-Blue_Yeti-00.analog-stereo",
                "description": "Yeti Stereo Microphone Analog Stereo",
                "properties": {"device.class": "sound", "media.class": "Audio/Source"}
            },
            {
                "name": "cdx_vmic_src",
                "description": "",
                "properties": {"media.class": "Audio/Source/Virtual"}
            }
        ])
        .to_string();
        assert_eq!(
            parse_sources_json(&json).unwrap(),
            vec![
                PulseSource {
                    name: "alsa_input.usb-Blue_Yeti-00.analog-stereo".to_string(),
                    description: "Yeti Stereo Microphone Analog Stereo".to_string(),
                },
                PulseSource {
                    name: "cdx_vmic_src".to_string(),
                    description: "cdx_vmic_src".to_string(),
                },
            ]
        );
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert!(parse_sources_json("Connection failure").is_err());
    }
}
