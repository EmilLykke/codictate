use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct ListedInputDevice {
    pub index: usize,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[cfg(windows)]
pub fn default_input_available() -> bool {
    cpal_default_input_available()
}

/// A microphone exists: a PipeWire capture source, or, without a PulseAudio
/// server to ask, an input on the ALSA default device.
#[cfg(not(windows))]
pub fn default_input_available() -> bool {
    match super::pulse::list_capture_sources() {
        Ok(sources) => !sources.is_empty(),
        Err(_) => cpal_default_input_available(),
    }
}

fn cpal_default_input_available() -> bool {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return false;
    };
    device.default_input_config().is_ok()
}

pub fn list_input_device_map() -> Result<BTreeMap<String, ListedInputDevice>, String> {
    Ok(list_input_devices()?
        .into_iter()
        .map(|device| (device.index.to_string(), device))
        .collect())
}

#[cfg(windows)]
pub(crate) fn list_input_devices() -> Result<Vec<ListedInputDevice>, String> {
    match list_core_audio_capture_devices() {
        Ok(devices) if !devices.is_empty() => Ok(devices),
        Ok(_) | Err(_) => list_cpal_input_devices(),
    }
}

/// Linux: when PipeWire answers, its capture sources are the whole truth, so
/// no microphone means an empty list rather than a list of ALSA PCM names.
/// The ALSA list is only the fallback for a system without a PulseAudio API.
#[cfg(not(windows))]
pub(crate) fn list_input_devices() -> Result<Vec<ListedInputDevice>, String> {
    match list_core_audio_capture_devices() {
        Ok(devices) => Ok(devices),
        Err(_) => list_cpal_input_devices(),
    }
}

fn list_cpal_input_devices() -> Result<Vec<ListedInputDevice>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| format!("input_devices failed: {err}"))?;

    Ok(devices
        .enumerate()
        .map(|(index, device)| {
            let name = device
                .name()
                .unwrap_or_else(|_| format!("Input device {index}"));
            // Linux has no endpoint id to fall back to; the ALSA PCM name is
            // what `record` resolves.
            let id = if cfg!(windows) {
                None
            } else {
                Some(name.clone())
            };
            ListedInputDevice { index, name, id }
        })
        .collect())
}

#[cfg(windows)]
fn list_core_audio_capture_devices() -> Result<Vec<ListedInputDevice>, String> {
    use super::com::{ComApartment, pwstr_to_string_and_free};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, STGM_READ};

    fn endpoint_id(device: &IMMDevice) -> Result<String, String> {
        let value = unsafe { device.GetId() }.map_err(|err| format!("GetId failed: {err}"))?;
        Ok(pwstr_to_string_and_free(value))
    }

    fn endpoint_name(device: &IMMDevice, index: usize) -> String {
        let Ok(store) = (unsafe { device.OpenPropertyStore(STGM_READ) }) else {
            return format!("Input device {index}");
        };
        let Ok(mut value) = (unsafe { store.GetValue(&PKEY_Device_FriendlyName) }) else {
            return format!("Input device {index}");
        };

        let name = unsafe { PropVariantToStringAlloc(&value) }
            .map(pwstr_to_string_and_free)
            .unwrap_or_else(|_| format!("Input device {index}"));
        let _ = unsafe { PropVariantClear(&mut value) };
        name
    }

    let _com = ComApartment::init()?;
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|err| format!("CoCreateInstance(MMDeviceEnumerator) failed: {err}"))?
    };
    let collection = unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) }
        .map_err(|err| format!("EnumAudioEndpoints failed: {err}"))?;
    let count = unsafe { collection.GetCount() }
        .map_err(|err| format!("IMMDeviceCollection::GetCount failed: {err}"))?;

    let mut devices = Vec::with_capacity(count as usize);
    for raw_index in 0..count {
        let device = unsafe { collection.Item(raw_index) }
            .map_err(|err| format!("IMMDeviceCollection::Item({raw_index}) failed: {err}"))?;
        let index = raw_index as usize;
        devices.push(ListedInputDevice {
            index,
            name: endpoint_name(&device, index),
            id: Some(endpoint_id(&device)?),
        });
    }

    Ok(devices)
}

/// Linux: PipeWire capture sources, named by their description and
/// identified by their source name (what `record` accepts as a device ref).
#[cfg(not(windows))]
fn list_core_audio_capture_devices() -> Result<Vec<ListedInputDevice>, String> {
    Ok(super::pulse::list_capture_sources()?
        .into_iter()
        .enumerate()
        .map(|(index, source)| ListedInputDevice {
            index,
            name: source.description,
            id: Some(source.name),
        })
        .collect())
}
