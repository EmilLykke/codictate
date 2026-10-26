use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use std::collections::BTreeMap;

/// One input in `--list-devices`. `transport` uses the `MicrophoneTransport` names in
/// `src/shared/microphone.ts`, which picks the fallback when the user's pick is not connected.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedInputDevice {
    pub index: usize,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub transport: &'static str,
    pub is_default: bool,
}

/// How an endpoint's hardware is attached, read from the device it is connected to
/// (`IConnector::GetDeviceIdConnectedTo`), e.g. `{2}.\\?\bthhfenum#...` or `{1}.\\?\hdaudio#...`.
pub(crate) fn transport_from_connected_device_id(device_id: &str) -> &'static str {
    let id = device_id.to_ascii_lowercase();
    if id.contains("bthenum") || id.contains("bthhfenum") || id.contains("bthledevice") {
        "bluetooth"
    } else if id.contains("usb") {
        "usb"
    } else if id.contains("root#") {
        "virtual"
    } else if ["hdaudio", "intelaudio", "acpi", "sst", "pci"]
        .iter()
        .any(|bus| id.contains(bus))
    {
        "built-in"
    } else {
        "other"
    }
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
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());

    Ok(devices
        .enumerate()
        .map(|(index, device)| {
            let name = device
                .name()
                .unwrap_or_else(|_| format!("Input device {index}"));
            ListedInputDevice {
                index,
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                id: None,
                transport: "other",
            }
        })
        .collect())
}

#[cfg(windows)]
fn list_core_audio_capture_devices() -> Result<Vec<ListedInputDevice>, String> {
    use super::com::{ComApartment, pwstr_to_string_and_free};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture, eConsole,
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
    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }
        .ok()
        .and_then(|device| endpoint_id(&device).ok());
    let collection = unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) }
        .map_err(|err| format!("EnumAudioEndpoints failed: {err}"))?;
    let count = unsafe { collection.GetCount() }
        .map_err(|err| format!("IMMDeviceCollection::GetCount failed: {err}"))?;

    let mut devices = Vec::with_capacity(count as usize);
    for raw_index in 0..count {
        let device = unsafe { collection.Item(raw_index) }
            .map_err(|err| format!("IMMDeviceCollection::Item({raw_index}) failed: {err}"))?;
        let index = raw_index as usize;
        let id = endpoint_id(&device)?;
        devices.push(ListedInputDevice {
            index,
            name: endpoint_name(&device, index),
            transport: endpoint_transport(&device),
            is_default: default_id.as_deref() == Some(id.as_str()),
            id: Some(id),
        });
    }

    Ok(devices)
}

/// `transport_from_connected_device_id` for an endpoint, or `other` when the topology does
/// not say.
#[cfg(windows)]
pub(crate) fn endpoint_transport(device: &windows::Win32::Media::Audio::IMMDevice) -> &'static str {
    use super::com::pwstr_to_string_and_free;
    use windows::Win32::Media::Audio::IDeviceTopology;
    use windows::Win32::System::Com::CLSCTX_ALL;

    let connected = (|| -> windows::core::Result<String> {
        let topology: IDeviceTopology = unsafe { device.Activate(CLSCTX_ALL, None) }?;
        let connector = unsafe { topology.GetConnector(0) }?;
        let id = unsafe { connector.GetDeviceIdConnectedTo() }?;
        Ok(pwstr_to_string_and_free(id))
    })();
    connected
        .map(|id| transport_from_connected_device_id(&id))
        .unwrap_or("other")
}

#[cfg(not(windows))]
fn list_core_audio_capture_devices() -> Result<Vec<ListedInputDevice>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::transport_from_connected_device_id as transport;

    #[test]
    fn reads_the_bus_from_the_connected_device() {
        assert_eq!(
            transport(r"{2}.\\?\bthhfenum#{0000111e-0000-1000-8000-00805f9b34fb}"),
            "bluetooth"
        );
        assert_eq!(transport(r"{2}.\\?\USB#VID_2CA3&PID_4011&MI_00#7&1"), "usb");
        assert_eq!(
            transport(r"{2}.\\?\hdaudio#func_01&ven_10ec&dev_0257"),
            "built-in"
        );
        assert_eq!(transport(r"{2}.\\?\ROOT#MEDIA#0000#{6994ad04}"), "virtual");
        assert_eq!(transport("something else"), "other");
    }
}
