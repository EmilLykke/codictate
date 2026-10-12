// The Media Foundation half of extract-audio: a synchronous Source Reader over every audio
// stream in the file, each decoded to PCM at its own rate and channel count, downmixed and
// resampled to 16 kHz here, then summed into the output WAV as it arrives.
//
// Media Foundation is loaded at run time rather than linked. Windows N and KN editions ship
// without it until the Media Feature Pack is installed, and an import of mfplat.dll would stop
// the whole helper (keyboard hook, indicator, recording) from starting on those PCs.

use super::ExtractError;
use std::path::Path;

#[cfg(windows)]
use super::ExtractOutput;
#[cfg(windows)]
use super::mix::StreamMixer;
#[cfg(windows)]
use super::pcm::{PcmLayout, SampleFormat, downmix_to_mono};
#[cfg(windows)]
use crate::audio::com::{ComApartment, to_wide};
#[cfg(windows)]
use crate::audio::resample::StreamingResampler;
#[cfg(windows)]
use std::ffi::{CStr, c_void};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::ptr::null_mut;
#[cfg(windows)]
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MF_API_VERSION, MF_E_INVALIDSTREAMNUMBER,
    MF_E_NO_MORE_TYPES, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SDK_VERSION,
    MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ANY_STREAM,
    MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READERF_ERROR, MFAudioFormat_Float, MFAudioFormat_PCM, MFMediaType_Audio,
    MFSTARTUP_NOSOCKET,
};
#[cfg(windows)]
use windows::core::{GUID, HRESULT, Interface, PCWSTR};
#[cfg(windows)]
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};

#[cfg(windows)]
const MF_VERSION: u32 = (MF_SDK_VERSION << 16) | MF_API_VERSION;

#[cfg(windows)]
pub fn extract_audio(input: &Path, output: &str) -> Result<(), ExtractError> {
    // Dropped in reverse: every Media Foundation object, then MFShutdown, then COM.
    let _com = ComApartment::init().map_err(ExtractError::WriteFailed)?;
    let media_foundation = MediaFoundation::start()?;
    decode_to_wav(&media_foundation, input, output)
}

#[cfg(not(windows))]
pub fn extract_audio(_input: &Path, _output: &str) -> Result<(), ExtractError> {
    Err(ExtractError::WriteFailed(
        "extract-audio decodes with Media Foundation, which only exists on Windows".to_string(),
    ))
}

#[cfg(windows)]
fn decode_to_wav(
    media_foundation: &MediaFoundation,
    input: &Path,
    output: &str,
) -> Result<(), ExtractError> {
    let reader = media_foundation.open(input)?;
    let audio_indices = audio_stream_indices(&reader)?;
    if audio_indices.is_empty() {
        return Err(ExtractError::NoAudio);
    }

    unsafe { reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false) }
        .map_err(|err| cannot_decode_file(&err))?;
    let mut streams = Vec::new();
    let mut last_failure = None;
    for index in audio_indices {
        match configure_stream(media_foundation, &reader, index) {
            Ok(layout) => streams.push(AudioStream::new(index, layout)?),
            Err(failure) => {
                let _ = unsafe { reader.SetStreamSelection(index, false) };
                last_failure = Some(failure);
            }
        }
    }
    // A stream with no decoder on this PC is left out as long as another one decodes.
    if streams.is_empty() {
        return Err(ExtractError::Unreadable(match last_failure {
            Some(failure) => format!("cannot decode the audio track: {failure}"),
            None => "cannot decode the audio track".to_string(),
        }));
    }

    let mut output = ExtractOutput::create(output)?;
    let mut mixer = StreamMixer::new(streams.len());
    let mut mono = Vec::new();
    while streams.iter().any(|stream| !stream.ended) {
        let mut stream_index = 0u32;
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample: Option<IMFSample> = None;
        unsafe {
            reader.ReadSample(
                MF_SOURCE_READER_ANY_STREAM.0 as u32,
                0,
                Some(&mut stream_index),
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
        }
        .map_err(|err| cannot_decode_file(&err))?;
        if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
            return Err(ExtractError::Unreadable(
                "cannot decode the file: the decoder stopped with an error".to_string(),
            ));
        }
        let end_of_stream = flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0;
        let slot = streams
            .iter()
            .position(|stream| stream.index == stream_index);
        // An end of stream for a stream that is not being read or has already ended means the
        // reader has nothing left for any of them, so stop rather than ask again.
        let Some(slot) = slot.filter(|&slot| !(end_of_stream && streams[slot].ended)) else {
            if end_of_stream {
                finish_streams(&mut streams, &mut mixer)?;
            }
            continue;
        };
        let stream = &mut streams[slot];

        if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
            let layout = current_layout(&reader, stream.index).map_err(|detail| {
                ExtractError::Unreadable(format!("cannot decode the audio track: {detail}"))
            })?;
            stream.change_layout(layout, |chunk| mixer.push(slot, chunk))?;
        }
        if let Some(sample) = sample {
            mono.clear();
            read_sample_bytes(&sample, |bytes| {
                downmix_to_mono(bytes, stream.layout, &mut mono)
            })
            .map_err(|err| cannot_decode_file(&err))?;
            mixer.start(slot, timestamp);
            stream.push(&mono, |chunk| mixer.push(slot, chunk))?;
        }
        if end_of_stream {
            stream.finish(|chunk| mixer.push(slot, chunk))?;
            mixer.finish(slot);
        }

        mixer.drain(|chunk| output.write(chunk))?;
    }

    mixer.drain(|chunk| output.write(chunk))?;
    output.finalize()
}

/// Flushes every stream that has not ended into the mixer and marks it finished.
#[cfg(windows)]
fn finish_streams(
    streams: &mut [AudioStream],
    mixer: &mut StreamMixer,
) -> Result<(), ExtractError> {
    for (slot, stream) in streams.iter_mut().enumerate() {
        if !stream.ended {
            stream.finish(|chunk| mixer.push(slot, chunk))?;
            mixer.finish(slot);
        }
    }
    Ok(())
}

/// One decoded audio stream on its way to 16 kHz mono.
#[cfg(windows)]
struct AudioStream {
    index: u32,
    layout: PcmLayout,
    resampler: StreamingResampler,
    ended: bool,
}

#[cfg(windows)]
impl AudioStream {
    fn new(index: u32, layout: PcmLayout) -> Result<Self, ExtractError> {
        Ok(Self {
            index,
            layout,
            resampler: new_resampler(layout.sample_rate)?,
            ended: false,
        })
    }

    /// The mixer adds the leading silence for a late start; see `StreamMixer::start`.
    fn push(&mut self, mono: &[f32], mut emit: impl FnMut(&[f32])) -> Result<(), ExtractError> {
        self.resample(mono, &mut emit)
    }

    /// The decoder renegotiated its output mid-stream. A new sample rate needs a new resampler;
    /// the old one is flushed first so nothing it holds is lost.
    fn change_layout(
        &mut self,
        layout: PcmLayout,
        mut emit: impl FnMut(&[f32]),
    ) -> Result<(), ExtractError> {
        if layout.sample_rate != self.layout.sample_rate {
            self.flush(&mut emit)?;
            self.resampler = new_resampler(layout.sample_rate)?;
        }
        self.layout = layout;
        Ok(())
    }

    fn finish(&mut self, mut emit: impl FnMut(&[f32])) -> Result<(), ExtractError> {
        self.ended = true;
        self.flush(&mut emit)
    }

    fn resample(
        &mut self,
        mono: &[f32],
        emit: &mut impl FnMut(&[f32]),
    ) -> Result<(), ExtractError> {
        self.resampler
            .process(mono, |chunk| {
                emit(chunk);
                Ok(())
            })
            .map_err(ExtractError::WriteFailed)
    }

    fn flush(&mut self, emit: &mut impl FnMut(&[f32])) -> Result<(), ExtractError> {
        self.resampler
            .finish(|chunk| {
                emit(chunk);
                Ok(())
            })
            .map_err(ExtractError::WriteFailed)
    }
}

#[cfg(windows)]
fn new_resampler(sample_rate: u32) -> Result<StreamingResampler, ExtractError> {
    StreamingResampler::new(sample_rate).map_err(|err| {
        ExtractError::Unreadable(format!(
            "cannot convert the audio track from {sample_rate} Hz: {err}"
        ))
    })
}

/// Every stream whose native media type is audio, in file order.
#[cfg(windows)]
fn audio_stream_indices(reader: &IMFSourceReader) -> Result<Vec<u32>, ExtractError> {
    let mut indices = Vec::new();
    for index in 0u32.. {
        match unsafe { reader.GetNativeMediaType(index, 0) } {
            Ok(media_type) => {
                let major =
                    unsafe { media_type.GetMajorType() }.map_err(|err| not_readable_media(&err))?;
                if major == MFMediaType_Audio {
                    indices.push(index);
                }
            }
            Err(err) if err.code() == MF_E_INVALIDSTREAMNUMBER => break,
            // A stream that offers no media type at all cannot be audio we can decode.
            Err(err) if err.code() == MF_E_NO_MORE_TYPES => {}
            Err(err) => return Err(not_readable_media(&err)),
        }
    }
    Ok(indices)
}

/// Selects the stream and asks for PCM, which makes the Source Reader load the decoder. Float is
/// preferred; 16-bit and then whatever integer PCM the decoder offers are accepted, and
/// `current_layout` reads which one was granted.
#[cfg(windows)]
fn configure_stream(
    media_foundation: &MediaFoundation,
    reader: &IMFSourceReader,
    index: u32,
) -> Result<PcmLayout, String> {
    unsafe { reader.SetStreamSelection(index, true) }.map_err(|err| describe(&err))?;
    let mut last_error = String::new();
    for (subtype, bits) in [
        (MFAudioFormat_Float, None),
        (MFAudioFormat_PCM, Some(16)),
        (MFAudioFormat_PCM, None),
    ] {
        let attempt = media_foundation
            .pcm_media_type(&subtype, bits)
            .and_then(|media_type| unsafe { reader.SetCurrentMediaType(index, None, &media_type) });
        match attempt {
            Ok(()) => return current_layout(reader, index),
            Err(err) => last_error = describe(&err),
        }
    }
    Err(last_error)
}

#[cfg(windows)]
fn current_layout(reader: &IMFSourceReader, index: u32) -> Result<PcmLayout, String> {
    let media_type = unsafe { reader.GetCurrentMediaType(index) }.map_err(|err| describe(&err))?;
    let read_u32 = |key: &GUID| unsafe { media_type.GetUINT32(key) }.map_err(|err| describe(&err));
    let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE) }.map_err(|err| describe(&err))?;
    let bits = read_u32(&MF_MT_AUDIO_BITS_PER_SAMPLE)?;
    let channels = read_u32(&MF_MT_AUDIO_NUM_CHANNELS)? as usize;
    let sample_rate = read_u32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?;

    let format = if subtype == MFAudioFormat_Float || subtype == MFAudioFormat_PCM {
        SampleFormat::from_media_type(subtype == MFAudioFormat_Float, bits)
    } else {
        None
    };
    match format {
        Some(format) if channels > 0 && sample_rate > 0 => Ok(PcmLayout {
            format,
            channels,
            sample_rate,
        }),
        _ => Err(format!(
            "the decoder offers {bits}-bit audio with {channels} channels at {sample_rate} Hz"
        )),
    }
}

/// Hands the sample's bytes to `read` while the buffer is locked.
#[cfg(windows)]
fn read_sample_bytes(sample: &IMFSample, read: impl FnOnce(&[u8])) -> windows::core::Result<()> {
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }?;
    let mut data = null_mut();
    let mut length = 0u32;
    unsafe { buffer.Lock(&mut data, None, Some(&mut length)) }?;
    if !data.is_null() && length > 0 {
        read(unsafe { std::slice::from_raw_parts(data, length as usize) });
    }
    unsafe { buffer.Unlock() }
}

#[cfg(windows)]
fn not_readable_media(err: &windows::core::Error) -> ExtractError {
    ExtractError::Unreadable(format!(
        "not a readable audio or video file: {}",
        describe(err)
    ))
}

#[cfg(windows)]
fn cannot_decode_file(err: &windows::core::Error) -> ExtractError {
    ExtractError::Unreadable(format!("cannot decode the file: {}", describe(err)))
}

/// The system's text for the error and its HRESULT. Media Foundation codes often have no text.
#[cfg(windows)]
fn describe(err: &windows::core::Error) -> String {
    let code = format!("0x{:08X}", err.code().0 as u32);
    let message = err.message();
    let message = message.trim();
    if message.is_empty() {
        code
    } else {
        format!("{message} ({code})")
    }
}

#[cfg(windows)]
type MfStartup = unsafe extern "system" fn(u32, u32) -> HRESULT;
#[cfg(windows)]
type MfShutdown = unsafe extern "system" fn() -> HRESULT;
#[cfg(windows)]
type MfCreateSourceReaderFromUrl =
    unsafe extern "system" fn(PCWSTR, *mut c_void, *mut *mut c_void) -> HRESULT;
#[cfg(windows)]
type MfCreateMediaType = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;

/// A started Media Foundation, shut down on drop. Only the four free functions extract-audio
/// calls are resolved; everything else is reached through COM interfaces.
#[cfg(windows)]
struct MediaFoundation {
    shutdown: MfShutdown,
    create_source_reader_from_url: MfCreateSourceReaderFromUrl,
    create_media_type: MfCreateMediaType,
}

#[cfg(windows)]
impl MediaFoundation {
    fn start() -> Result<Self, ExtractError> {
        let mfplat = load_system_library("mfplat.dll")?;
        let mfreadwrite = load_system_library("mfreadwrite.dll")?;
        // SAFETY: each pointer is the named export, transmuted to its documented signature.
        let (startup, shutdown, create_source_reader_from_url, create_media_type) = unsafe {
            (
                std::mem::transmute::<RawProc, MfStartup>(proc_address(mfplat, c"MFStartup")?),
                std::mem::transmute::<RawProc, MfShutdown>(proc_address(mfplat, c"MFShutdown")?),
                std::mem::transmute::<RawProc, MfCreateSourceReaderFromUrl>(proc_address(
                    mfreadwrite,
                    c"MFCreateSourceReaderFromURL",
                )?),
                std::mem::transmute::<RawProc, MfCreateMediaType>(proc_address(
                    mfplat,
                    c"MFCreateMediaType",
                )?),
            )
        };
        unsafe { startup(MF_VERSION, MFSTARTUP_NOSOCKET) }
            .ok()
            .map_err(|err| {
                ExtractError::WriteFailed(format!(
                    "Media Foundation did not start: {}",
                    describe(&err)
                ))
            })?;
        Ok(Self {
            shutdown,
            create_source_reader_from_url,
            create_media_type,
        })
    }

    fn open(&self, path: &Path) -> Result<IMFSourceReader, ExtractError> {
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let mut raw = null_mut();
        unsafe {
            (self.create_source_reader_from_url)(PCWSTR(wide.as_ptr()), null_mut(), &mut raw)
        }
        .ok()
        .map_err(|err| not_readable_media(&err))?;
        if raw.is_null() {
            return Err(ExtractError::Unreadable(
                "not a readable audio or video file".to_string(),
            ));
        }
        // SAFETY: MFCreateSourceReaderFromURL succeeded and handed over one IMFSourceReader
        // reference.
        Ok(unsafe { IMFSourceReader::from_raw(raw) })
    }

    fn pcm_media_type(
        &self,
        subtype: &GUID,
        bits_per_sample: Option<u32>,
    ) -> windows::core::Result<IMFMediaType> {
        let mut raw = null_mut();
        unsafe { (self.create_media_type)(&mut raw) }.ok()?;
        // SAFETY: MFCreateMediaType succeeded and handed over one IMFMediaType reference.
        let media_type = unsafe { IMFMediaType::from_raw(raw) };
        unsafe {
            media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            media_type.SetGUID(&MF_MT_SUBTYPE, subtype)?;
            if let Some(bits) = bits_per_sample {
                media_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, bits)?;
            }
        }
        Ok(media_type)
    }
}

#[cfg(windows)]
impl Drop for MediaFoundation {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.shutdown)();
        }
    }
}

#[cfg(windows)]
type RawProc = unsafe extern "system" fn() -> isize;

#[cfg(windows)]
fn load_system_library(name: &str) -> Result<*mut c_void, ExtractError> {
    let wide = to_wide(name);
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
    if module.is_null() {
        return Err(ExtractError::WriteFailed(format!(
            "Media Foundation is not installed ({name} is missing; Windows N editions need the Media Feature Pack)"
        )));
    }
    Ok(module)
}

#[cfg(windows)]
fn proc_address(module: *mut c_void, name: &CStr) -> Result<RawProc, ExtractError> {
    unsafe { GetProcAddress(module, name.as_ptr().cast()) }.ok_or_else(|| {
        ExtractError::WriteFailed(format!(
            "Media Foundation is missing {}",
            name.to_string_lossy()
        ))
    })
}
