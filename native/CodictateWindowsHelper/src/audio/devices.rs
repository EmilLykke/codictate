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

pub fn default_input_available() -> bool {
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

fn list_input_devices() -> Result<Vec<ListedInputDevice>, String> {
    match list_core_audio_capture_devices() {
        Ok(devices) if !devices.is_empty() => Ok(devices),
        Ok(_) | Err(_) => list_cpal_input_devices(),
    }
}

fn list_cpal_input_devices() -> Result<Vec<ListedInputDevice>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| format!("input_devices failed: {err}"))?;

    Ok(devices
        .enumerate()
        .map(|(index, device)| ListedInputDevice {
            index,
            name: device
                .name()
                .unwrap_or_else(|_| format!("Input device {index}")),
            id: None,
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

#[cfg(not(windows))]
fn list_core_audio_capture_devices() -> Result<Vec<ListedInputDevice>, String> {
    Ok(Vec::new())
}
