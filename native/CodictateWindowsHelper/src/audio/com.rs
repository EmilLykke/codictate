#[cfg(windows)]
use std::slice;

#[cfg(windows)]
use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
#[cfg(windows)]
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
#[cfg(windows)]
use windows::core::PWSTR;

#[cfg(windows)]
pub struct ComApartment {
    should_uninitialize: bool,
}

#[cfg(windows)]
impl ComApartment {
    pub fn init() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self {
                should_uninitialize: true,
            })
        } else if hr == RPC_E_CHANGED_MODE {
            Ok(Self {
                should_uninitialize: false,
            })
        } else {
            Err(format!("CoInitializeEx failed: {hr:?}"))
        }
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.should_uninitialize {
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(windows)]
pub struct ComTaskMem<T>(*mut T);

#[cfg(windows)]
impl<T> ComTaskMem<T> {
    pub fn new(ptr: *mut T) -> Self {
        Self(ptr)
    }

    pub fn as_ptr(&self) -> *mut T {
        self.0
    }
}

#[cfg(windows)]
impl<T> Drop for ComTaskMem<T> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(Some(self.0 as _)) };
        }
    }
}

#[cfg(windows)]
pub fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub fn pwstr_to_string_and_free(value: PWSTR) -> String {
    if value.0.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    unsafe {
        while *value.0.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(slice::from_raw_parts(value.0, len));
        CoTaskMemFree(Some(value.0 as _));
        text
    }
}
