use super::resample::{RECORDING_SAMPLE_RATE, StreamingResampler};
use super::wav::RecordingWavWriter;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate, StreamConfig};
use crossbeam_channel::{Receiver, Sender, bounded};
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(windows)]
use super::com::{ComApartment, ComTaskMem, to_wide};
#[cfg(windows)]
use std::ptr::{addr_of, null_mut, read_unaligned};
#[cfg(windows)]
use std::slice;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, WAVE_FORMAT_PCM,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
#[cfg(windows)]
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
#[cfg(windows)]
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
#[cfg(windows)]
use windows::core::{GUID, PCWSTR};

type RecordingWorker = JoinHandle<Result<(), String>>;

pub struct InputSampleStream {
    pub sample_rate: u32,
    rx: Receiver<Vec<f32>>,
    _source: InputSampleSource,
}

enum InputSampleSource {
    Cpal(cpal::Stream),
    #[cfg(windows)]
    Wasapi {
        stop_flag: Arc<AtomicBool>,
        worker: Option<JoinHandle<Result<(), String>>>,
    },
}

impl InputSampleStream {
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Vec<f32>, crossbeam_channel::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }
}

impl Drop for InputSampleSource {
    fn drop(&mut self) {
        match self {
            InputSampleSource::Cpal(stream) => {
                let _ = stream.pause();
            }
            #[cfg(windows)]
            InputSampleSource::Wasapi { stop_flag, worker } => {
                stop_flag.store(true, Ordering::SeqCst);
                if let Some(worker) = worker.take() {
                    let _ = worker.join();
                }
            }
        }
    }
}

fn spawn_recording_worker(
    path: &str,
    input_sample_rate: u32,
) -> (Sender<Vec<f32>>, RecordingWorker) {
    let path = path.to_string();
    let (sample_tx, sample_rx) = bounded::<Vec<f32>>(4096);
    let worker = thread::spawn(move || {
        let mut writer = RecordingWavWriter::create(&path)?;
        let mut resampler = StreamingResampler::new(input_sample_rate)?;

        while let Ok(chunk) = sample_rx.recv() {
            resampler.process(&chunk, |samples| writer.write_samples(samples))?;
        }

        resampler.finish(|samples| writer.write_samples(samples))?;
        writer.finalize()
    });

    (sample_tx, worker)
}

fn finish_recording_worker(
    sample_tx: Sender<Vec<f32>>,
    worker: RecordingWorker,
) -> Result<(), String> {
    drop(sample_tx);
    worker
        .join()
        .map_err(|_| "sample worker panicked".to_string())?
}

fn spawn_stdin_stop_thread(stop_flag: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                stop_flag.store(true, Ordering::SeqCst);
                return;
            };
            if line.trim().eq_ignore_ascii_case("stop") {
                stop_flag.store(true, Ordering::SeqCst);
                return;
            }
        }
        stop_flag.store(true, Ordering::SeqCst);
    })
}

fn pick_record_config(device: &cpal::Device) -> Result<(StreamConfig, SampleFormat), String> {
    if let Ok(ranges) = device.supported_input_configs() {
        let mut selected: Option<(StreamConfig, SampleFormat)> = None;
        for range in ranges {
            let channels = range.channels();
            if channels == 0 {
                continue;
            }
            let min = range.min_sample_rate().0;
            let max = range.max_sample_rate().0;
            let desired = if min <= RECORDING_SAMPLE_RATE && RECORDING_SAMPLE_RATE <= max {
                RECORDING_SAMPLE_RATE
            } else if min <= 48_000 && 48_000 <= max {
                48_000
            } else {
                max
            };
            selected = Some((
                StreamConfig {
                    channels,
                    sample_rate: SampleRate(desired),
                    buffer_size: cpal::BufferSize::Default,
                },
                range.sample_format(),
            ));
            if desired == RECORDING_SAMPLE_RATE && channels == 1 {
                break;
            }
        }
        if let Some(config) = selected {
            return Ok(config);
        }
    }

    let fallback = device
        .default_input_config()
        .map_err(|err| format!("default_input_config failed: {err}"))?;
    Ok((fallback.config(), fallback.sample_format()))
}

fn send_mono_chunk(sender: &Sender<Vec<f32>>, chunk: Vec<f32>) {
    if !chunk.is_empty() {
        let _ = sender.try_send(chunk);
    }
}

fn write_frames_f32(data: &[f32], channels: usize, sender: &Sender<Vec<f32>>) {
    if channels == 0 {
        return;
    }
    let mut chunk = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().copied().sum();
        chunk.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    send_mono_chunk(sender, chunk);
}

fn write_frames_i16(data: &[i16], channels: usize, sender: &Sender<Vec<f32>>) {
    if channels == 0 {
        return;
    }
    let mut chunk = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().map(|sample| *sample as f32 / 32768.0).sum();
        chunk.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    send_mono_chunk(sender, chunk);
}

fn write_frames_u8(data: &[u8], channels: usize, sender: &Sender<Vec<f32>>) {
    if channels == 0 {
        return;
    }
    let mut chunk = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks(channels) {
        let sum: f32 = frame
            .iter()
            .map(|sample| (*sample as f32 - 128.0) / 128.0)
            .sum();
        chunk.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    send_mono_chunk(sender, chunk);
}

fn write_frames_u16(data: &[u16], channels: usize, sender: &Sender<Vec<f32>>) {
    if channels == 0 {
        return;
    }
    let mut chunk = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks(channels) {
        let sum: f32 = frame
            .iter()
            .map(|sample| (*sample as f32 - 32_768.0) / 32_768.0)
            .sum();
        chunk.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    send_mono_chunk(sender, chunk);
}

fn cpal_input_device_by_index(device_index: usize) -> Result<Device, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|err| format!("input_devices failed: {err}"))?
        .collect::<Vec<_>>();

    let Some(device) = devices.into_iter().nth(device_index) else {
        return Err("device index out of range".to_string());
    };

    Ok(device)
}

fn build_cpal_input_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    error_context: &'static str,
    sample_tx: &Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    let err_fn = move |err| {
        let _ = writeln!(io::stderr().lock(), "{error_context}: {err}");
    };

    let channels = config.channels as usize;
    match sample_format {
        SampleFormat::F32 => {
            let sender = sample_tx.clone();
            device.build_input_stream(
                config,
                move |data: &[f32], _| write_frames_f32(data, channels, &sender),
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let sender = sample_tx.clone();
            device.build_input_stream(
                config,
                move |data: &[i16], _| write_frames_i16(data, channels, &sender),
                err_fn,
                None,
            )
        }
        SampleFormat::U8 => {
            let sender = sample_tx.clone();
            device.build_input_stream(
                config,
                move |data: &[u8], _| write_frames_u8(data, channels, &sender),
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let sender = sample_tx.clone();
            device.build_input_stream(
                config,
                move |data: &[u16], _| write_frames_u16(data, channels, &sender),
                err_fn,
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|err| format!("build_input_stream failed: {err}"))
}

pub fn open_input_sample_stream(device_ref: Option<&str>) -> Result<InputSampleStream, String> {
    let Some(device_ref) = device_ref.map(str::trim).filter(|value| !value.is_empty()) else {
        return open_default_input_sample_stream();
    };
    if device_ref.eq_ignore_ascii_case("default") {
        return open_default_input_sample_stream();
    }
    if let Ok(device_index) = device_ref.parse::<usize>() {
        return open_cpal_index_input_sample_stream(device_index);
    }

    open_wasapi_endpoint_sample_stream(device_ref)
}

pub fn open_default_input_sample_stream() -> Result<InputSampleStream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    open_cpal_input_sample_stream(device)
}

fn open_cpal_index_input_sample_stream(device_index: usize) -> Result<InputSampleStream, String> {
    open_cpal_input_sample_stream(cpal_input_device_by_index(device_index)?)
}

fn open_cpal_input_sample_stream(device: Device) -> Result<InputSampleStream, String> {
    let (config, sample_format) = pick_record_config(&device)?;
    let (sample_tx, sample_rx) = bounded::<Vec<f32>>(4096);
    let stream = build_cpal_input_stream(
        &device,
        &config,
        sample_format,
        "CodictateWindowsHelper stream input error",
        &sample_tx,
    )?;

    stream
        .play()
        .map_err(|err| format!("stream play failed: {err}"))?;

    Ok(InputSampleStream {
        sample_rate: config.sample_rate.0,
        rx: sample_rx,
        _source: InputSampleSource::Cpal(stream),
    })
}

#[cfg(windows)]
fn open_wasapi_endpoint_sample_stream(endpoint_id: &str) -> Result<InputSampleStream, String> {
    let (sample_tx, sample_rx) = bounded::<Vec<f32>>(4096);
    let (ready_tx, ready_rx) = bounded::<Result<u32, String>>(1);
    let endpoint_id = endpoint_id.to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop_flag = stop_flag.clone();

    let worker = thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let capture = open_wasapi_endpoint_capture(&endpoint_id)?;
            unsafe { capture.audio_client.Start() }
                .map_err(|err| format!("IAudioClient::Start failed: {err}"))?;
            let _ = ready_tx.send(Ok(capture.format.sample_rate));

            while !worker_stop_flag.load(Ordering::SeqCst) {
                if wait_for_wasapi_packet(&capture.capture_event, 100)? {
                    unsafe {
                        drain_wasapi_packets(&capture.capture_client, capture.format, &sample_tx)
                    }?;
                }
            }

            unsafe { drain_wasapi_packets(&capture.capture_client, capture.format, &sample_tx) }?;
            let _ = unsafe { capture.audio_client.Stop() };
            Ok(())
        })();

        if let Err(err) = &result {
            let _ = ready_tx.send(Err(err.clone()));
        }
        result
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(sample_rate)) => Ok(InputSampleStream {
            sample_rate,
            rx: sample_rx,
            _source: InputSampleSource::Wasapi {
                stop_flag,
                worker: Some(worker),
            },
        }),
        Ok(Err(err)) => {
            let _ = worker.join();
            Err(err)
        }
        Err(err) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = worker.join();
            Err(format!("WASAPI endpoint stream startup timed out: {err}"))
        }
    }
}

#[cfg(not(windows))]
fn open_wasapi_endpoint_sample_stream(_endpoint_id: &str) -> Result<InputSampleStream, String> {
    Err("WASAPI endpoint streaming is only available on Windows".to_string())
}

pub fn record_to_wav(path: &str, device_ref: &str, max_seconds: u64) -> Result<(), String> {
    if let Ok(device_index) = device_ref.parse::<usize>() {
        return record_cpal_index_to_wav(path, device_index, max_seconds);
    }

    record_wasapi_endpoint_to_wav(path, device_ref, max_seconds)
}

fn record_cpal_index_to_wav(
    path: &str,
    device_index: usize,
    max_seconds: u64,
) -> Result<(), String> {
    let device = cpal_input_device_by_index(device_index)?;
    let (config, sample_format) = pick_record_config(&device)?;
    let (sample_tx, sample_worker) = spawn_recording_worker(path, config.sample_rate.0);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let _stdin_thread = spawn_stdin_stop_thread(stop_flag.clone());
    let stream = build_cpal_input_stream(
        &device,
        &config,
        sample_format,
        "CodictateWindowsHelper record stream error",
        &sample_tx,
    )?;

    stream
        .play()
        .map_err(|err| format!("stream play failed: {err}"))?;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(max_seconds) {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    drop(stream);
    stop_flag.store(true, Ordering::SeqCst);
    finish_recording_worker(sample_tx, sample_worker)
}

#[cfg(windows)]
const WASAPI_BUFFER_DURATION_100NS: i64 = 10_000_000;
#[cfg(windows)]
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
#[cfg(windows)]
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
#[cfg(windows)]
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
#[cfg(windows)]
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

#[cfg(windows)]
struct EventHandle(HANDLE);

#[cfg(windows)]
impl EventHandle {
    fn create_auto_reset() -> Result<Self, String> {
        let handle = unsafe { CreateEventW(None, false, false, PCWSTR(std::ptr::null())) }
            .map_err(|err| format!("CreateEventW failed: {err}"))?;
        Ok(Self(handle))
    }

    fn get(&self) -> HANDLE {
        self.0
    }
}

#[cfg(windows)]
impl Drop for EventHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum WasapiSampleFormat {
    Float32,
    PcmUnsigned8,
    PcmSigned16,
    PcmSigned24,
    PcmSigned32,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct WasapiCaptureFormat {
    channels: usize,
    sample_rate: u32,
    bytes_per_frame: usize,
    bytes_per_sample: usize,
    sample_format: WasapiSampleFormat,
}

#[cfg(windows)]
impl WasapiCaptureFormat {
    unsafe fn from_wave_format(format: *const WAVEFORMATEX) -> Result<Self, String> {
        if format.is_null() {
            return Err("IAudioClient::GetMixFormat returned null".to_string());
        }

        let format_tag = unsafe { read_unaligned(addr_of!((*format).wFormatTag)) };
        let channels = unsafe { read_unaligned(addr_of!((*format).nChannels)) } as usize;
        let sample_rate = unsafe { read_unaligned(addr_of!((*format).nSamplesPerSec)) };
        let block_align = unsafe { read_unaligned(addr_of!((*format).nBlockAlign)) } as usize;
        let bits_per_sample =
            unsafe { read_unaligned(addr_of!((*format).wBitsPerSample)) } as usize;

        if channels == 0 || sample_rate == 0 || block_align == 0 || bits_per_sample == 0 {
            return Err("WASAPI mix format is incomplete".to_string());
        }

        let sub_format = if format_tag == WAVE_FORMAT_EXTENSIBLE {
            let extensible = format.cast::<WAVEFORMATEXTENSIBLE>();
            Some(unsafe { read_unaligned(addr_of!((*extensible).SubFormat)) })
        } else {
            None
        };

        let is_pcm = format_tag == WAVE_FORMAT_PCM as u16
            || (format_tag == WAVE_FORMAT_EXTENSIBLE
                && sub_format == Some(KSDATAFORMAT_SUBTYPE_PCM));
        let is_float = format_tag == WAVE_FORMAT_IEEE_FLOAT
            || (format_tag == WAVE_FORMAT_EXTENSIBLE
                && sub_format == Some(KSDATAFORMAT_SUBTYPE_IEEE_FLOAT));

        let sample_format = if is_float && bits_per_sample == 32 {
            WasapiSampleFormat::Float32
        } else if is_pcm {
            match bits_per_sample {
                8 => WasapiSampleFormat::PcmUnsigned8,
                16 => WasapiSampleFormat::PcmSigned16,
                24 => WasapiSampleFormat::PcmSigned24,
                32 => WasapiSampleFormat::PcmSigned32,
                _ => {
                    return Err(format!(
                        "unsupported WASAPI PCM sample width: {bits_per_sample} bits"
                    ));
                }
            }
        } else {
            return Err(format!(
                "unsupported WASAPI mix format: tag={format_tag}, bits={bits_per_sample}, subFormat={sub_format:?}"
            ));
        };

        let bytes_per_sample = bits_per_sample.div_ceil(8);
        if block_align < channels * bytes_per_sample {
            return Err("WASAPI block alignment is smaller than sample width".to_string());
        }

        Ok(Self {
            channels,
            sample_rate,
            bytes_per_frame: block_align,
            bytes_per_sample,
            sample_format,
        })
    }
}

#[cfg(windows)]
struct WasapiEndpointCapture {
    _com: ComApartment,
    audio_client: IAudioClient,
    capture_client: IAudioCaptureClient,
    capture_event: EventHandle,
    format: WasapiCaptureFormat,
}

#[cfg(windows)]
fn open_wasapi_endpoint_capture(endpoint_id: &str) -> Result<WasapiEndpointCapture, String> {
    let com = ComApartment::init()?;
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|err| format!("CoCreateInstance(MMDeviceEnumerator) failed: {err}"))?
    };
    let endpoint_id_wide = to_wide(endpoint_id);
    let device = unsafe { enumerator.GetDevice(PCWSTR(endpoint_id_wide.as_ptr())) }
        .map_err(|err| format!("IMMDeviceEnumerator::GetDevice failed: {err}"))?;
    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|err| format!("IMMDevice::Activate(IAudioClient) failed: {err}"))?;
    let mix_format = ComTaskMem::new(
        unsafe { audio_client.GetMixFormat() }
            .map_err(|err| format!("IAudioClient::GetMixFormat failed: {err}"))?,
    );
    let format = unsafe { WasapiCaptureFormat::from_wave_format(mix_format.as_ptr()) }?;
    let capture_event = EventHandle::create_auto_reset()?;

    unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            WASAPI_BUFFER_DURATION_100NS,
            0,
            mix_format.as_ptr(),
            None,
        )
    }
    .map_err(|err| format!("IAudioClient::Initialize failed: {err}"))?;
    unsafe { audio_client.SetEventHandle(capture_event.get()) }
        .map_err(|err| format!("IAudioClient::SetEventHandle failed: {err}"))?;

    let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService() }
        .map_err(|err| format!("IAudioClient::GetService(IAudioCaptureClient) failed: {err}"))?;

    Ok(WasapiEndpointCapture {
        _com: com,
        audio_client,
        capture_client,
        capture_event,
        format,
    })
}

#[cfg(windows)]
fn sample_from_bytes(bytes: &[u8], format: WasapiSampleFormat) -> f32 {
    match format {
        WasapiSampleFormat::Float32 => {
            f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).clamp(-1.0, 1.0)
        }
        WasapiSampleFormat::PcmUnsigned8 => ((bytes[0] as f32 - 128.0) / 128.0).clamp(-1.0, 1.0),
        WasapiSampleFormat::PcmSigned16 => {
            (i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0).clamp(-1.0, 1.0)
        }
        WasapiSampleFormat::PcmSigned24 => {
            let raw =
                ((bytes[2] as i32) << 24) | ((bytes[1] as i32) << 16) | ((bytes[0] as i32) << 8);
            ((raw >> 8) as f32 / 8_388_608.0).clamp(-1.0, 1.0)
        }
        WasapiSampleFormat::PcmSigned32 => {
            (i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0)
                .clamp(-1.0, 1.0)
        }
    }
}

#[cfg(windows)]
unsafe fn send_wasapi_frames(
    data: *const u8,
    frames: u32,
    flags: u32,
    format: WasapiCaptureFormat,
    sender: &Sender<Vec<f32>>,
) -> Result<(), String> {
    let frame_count = frames as usize;
    if frame_count == 0 {
        return Ok(());
    }

    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
    if silent || data.is_null() {
        send_mono_chunk(sender, vec![0.0; frame_count]);
        return Ok(());
    }

    let byte_count = frame_count
        .checked_mul(format.bytes_per_frame)
        .ok_or_else(|| "WASAPI packet byte count overflowed".to_string())?;
    let bytes = unsafe { slice::from_raw_parts(data, byte_count) };
    let mut chunk = Vec::with_capacity(frame_count);

    for frame_index in 0..frame_count {
        let frame_offset = frame_index * format.bytes_per_frame;
        let mut sum = 0.0f32;
        for channel in 0..format.channels {
            let start = frame_offset + channel * format.bytes_per_sample;
            let end = start + format.bytes_per_sample;
            sum += sample_from_bytes(&bytes[start..end], format.sample_format);
        }
        chunk.push((sum / format.channels as f32).clamp(-1.0, 1.0));
    }

    send_mono_chunk(sender, chunk);
    Ok(())
}

#[cfg(windows)]
unsafe fn drain_wasapi_packets(
    capture_client: &IAudioCaptureClient,
    capture_format: WasapiCaptureFormat,
    sender: &Sender<Vec<f32>>,
) -> Result<(), String> {
    loop {
        let packet_size = unsafe { capture_client.GetNextPacketSize() }
            .map_err(|err| format!("IAudioCaptureClient::GetNextPacketSize failed: {err}"))?;
        if packet_size == 0 {
            return Ok(());
        }

        let mut data: *mut u8 = null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        unsafe { capture_client.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
            .map_err(|err| format!("IAudioCaptureClient::GetBuffer failed: {err}"))?;

        let convert_result =
            unsafe { send_wasapi_frames(data, frames, flags, capture_format, sender) };
        let release_result = unsafe { capture_client.ReleaseBuffer(frames) }
            .map_err(|err| format!("IAudioCaptureClient::ReleaseBuffer failed: {err}"));
        convert_result?;
        release_result?;
    }
}

#[cfg(windows)]
fn next_wait_timeout_ms(started: Instant, max_seconds: u64) -> Option<u32> {
    let remaining = Duration::from_secs(max_seconds).checked_sub(started.elapsed())?;
    let wait = remaining.min(Duration::from_millis(100));
    Some(wait.as_millis().max(1).min(u32::MAX as u128) as u32)
}

#[cfg(windows)]
fn wait_for_wasapi_packet(capture_event: &EventHandle, wait_ms: u32) -> Result<bool, String> {
    let wait_result = unsafe { WaitForSingleObject(capture_event.get(), wait_ms) };
    if wait_result == WAIT_OBJECT_0 {
        Ok(true)
    } else if wait_result == WAIT_TIMEOUT {
        Ok(false)
    } else if wait_result == WAIT_FAILED {
        Err("WaitForSingleObject failed for WASAPI capture event".to_string())
    } else {
        Err(format!(
            "unexpected WASAPI capture wait result: {wait_result:?}"
        ))
    }
}

#[cfg(windows)]
fn record_wasapi_endpoint_to_wav(
    path: &str,
    endpoint_id: &str,
    max_seconds: u64,
) -> Result<(), String> {
    let capture = open_wasapi_endpoint_capture(endpoint_id)?;
    let (sample_tx, sample_worker) = spawn_recording_worker(path, capture.format.sample_rate);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let _stdin_thread = spawn_stdin_stop_thread(stop_flag.clone());

    unsafe { capture.audio_client.Start() }
        .map_err(|err| format!("IAudioClient::Start failed: {err}"))?;

    let started = Instant::now();
    while let Some(wait_ms) = next_wait_timeout_ms(started, max_seconds) {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        if wait_for_wasapi_packet(&capture.capture_event, wait_ms)? {
            unsafe { drain_wasapi_packets(&capture.capture_client, capture.format, &sample_tx) }?;
        }
    }

    unsafe { drain_wasapi_packets(&capture.capture_client, capture.format, &sample_tx) }?;
    let _ = unsafe { capture.audio_client.Stop() };
    stop_flag.store(true, Ordering::SeqCst);
    finish_recording_worker(sample_tx, sample_worker)
}

#[cfg(not(windows))]
fn record_wasapi_endpoint_to_wav(
    _path: &str,
    _endpoint_id: &str,
    _max_seconds: u64,
) -> Result<(), String> {
    Err("WASAPI endpoint recording is only available on Windows".to_string())
}
