pub mod protocol;

#[cfg(windows)]
mod hook;
#[cfg(windows)]
pub(crate) mod inject;
#[cfg(windows)]
mod win32;
#[cfg(windows)]
pub use win32::handle_keyboard_hook;

#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
pub use linux::handle_keyboard_hook;
#[cfg(not(windows))]
pub(crate) use linux::inject;
