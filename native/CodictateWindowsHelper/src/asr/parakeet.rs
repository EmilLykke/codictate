use crate::audio::capture::open_default_input_sample_stream;
use crate::audio::resample::{RECORDING_SAMPLE_RATE, StreamingResampler};
use crate::ipc::emit_json;
use crate::keyboard::inject;
use arboard::Clipboard;
use parakeet_rs::{ExecutionConfig, ExecutionProvider, ParakeetTDT, TimestampMode, Transcriber};
use serde::Serialize;
use std::cmp::Ordering;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

const STREAM_RECV_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Serialize)]
struct FinalTranscriptMessage {
    kind: &'static str,
    text: String,
}

struct TextInjector {
    clipboard: Clipboard,
}

impl TextInjector {
    fn new() -> Result<Self, String> {
        let clipboard = Clipboard::new().map_err(|err| format!("clipboard init failed: {err}"))?;
        Ok(Self { clipboard })
    }

    fn paste_text(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        self.clipboard
            .set_text(text.to_string())
            .map_err(|err| format!("clipboard update failed: {err}"))?;
        if inject::send_ctrl_v() {
            Ok(())
        } else {
            Err("simulated Ctrl+V failed".to_string())
        }
    }

    fn update_live_line(&mut self, displayed: &mut String, next: &str) -> Result<(), String> {
        let common = common_prefix_byte_len(displayed, next);
        let delete_chars = displayed[common..].chars().count();
        let insert = &next[common..];

        if delete_chars > 0 {
            let modifiers_released = inject::release_modifiers_for_text_injection();
            let deleted = modifiers_released && inject::send_backspaces(delete_chars);
            if !deleted {
                return Err("failed to replace live transcript suffix".to_string());
            }
        }

        self.paste_text(insert)?;
        displayed.clear();
        displayed.push_str(next);
        Ok(())
    }
}

fn common_prefix_byte_len(a: &str, b: &str) -> usize {
    let mut len = 0;
    for (left, right) in a.chars().zip(b.chars()) {
        if left != right {
            break;
        }
        len += left.len_utf8();
    }
    len
}

fn log_phase(message: impl AsRef<str>) {
    let _ = writeln!(
        io::stderr().lock(),
        "[CodictateWindowsHelper:parakeet] {}",
        message.as_ref()
    );
}

fn base_execution_config() -> ExecutionConfig {
    let threads = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 8);
    ExecutionConfig::new()
        .with_intra_threads(threads)
        .with_inter_threads(1)
}

fn load_model(model_dir: &str) -> Result<ParakeetTDT, String> {
    log_phase("loading ONNX Parakeet TDT model with DirectML...");
    let directml_config =
        base_execution_config().with_execution_provider(ExecutionProvider::DirectML);
    match ParakeetTDT::from_pretrained(model_dir, Some(directml_config)) {
        Ok(model) => {
            log_phase("loaded ONNX Parakeet TDT model with DirectML");
            Ok(model)
        }
        Err(err) => {
            log_phase(format!(
                "DirectML model load failed, falling back to CPU: {err}"
            ));
            ParakeetTDT::from_pretrained(model_dir, Some(base_execution_config()))
                .map_err(|cpu_err| format!("failed to load Parakeet ONNX model: {cpu_err}"))
        }
    }
}

fn clean_transcript(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn transcribe_samples(model: &mut ParakeetTDT, samples: Vec<f32>) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    let result = model
        .transcribe_samples(
            samples,
            RECORDING_SAMPLE_RATE,
            1,
            Some(TimestampMode::Sentences),
        )
        .map_err(|err| format!("Parakeet transcription failed: {err}"))?;
    Ok(clean_transcript(&result.text))
}

fn transcribe_for_stream(model: &mut ParakeetTDT, samples: &[f32]) -> Option<String> {
    match transcribe_samples(model, samples.to_vec()) {
        Ok(text) => Some(text),
        Err(err) => {
            log_phase(format!("stream transcription error: {err}"));
            None
        }
    }
}

fn push_mono_frame(frame: &[f32], out: &mut Vec<f32>) {
    if frame.is_empty() {
        return;
    }
    let sum: f32 = frame.iter().copied().sum();
    out.push((sum / frame.len() as f32).clamp(-1.0, 1.0));
}

fn load_wav_mono_f32(path: &str) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(Path::new(path))
        .map_err(|err| format!("failed to open wav: {err}"))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err("wav has zero channels".to_string());
    }

    let mut samples = Vec::new();
    match spec.sample_format {
        hound::SampleFormat::Float => {
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<f32>() {
                frame.push(sample.map_err(|err| format!("invalid float sample: {err}"))?);
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => {
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<i16>() {
                frame.push(
                    sample.map_err(|err| format!("invalid i16 sample: {err}"))? as f32 / 32768.0,
                );
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<i32>() {
                frame.push(
                    (sample.map_err(|err| format!("invalid i32 sample: {err}"))? as f32 / scale)
                        .clamp(-1.0, 1.0),
                );
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
    }

    Ok((samples, spec.sample_rate))
}

fn resample_to_recording_rate(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
    let mut out = Vec::new();
    let mut resampler = StreamingResampler::new(sample_rate)?;
    resampler.process(samples, |chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    resampler.finish(|chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(out)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f32 = samples.iter().map(|sample| sample * sample).sum();
    (energy / samples.len() as f32).sqrt()
}

fn join_transcript(left: &str, right: &str) -> String {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() {
        return right.to_string();
    }
    if right.is_empty() {
        return left.to_string();
    }
    format!("{left} {right}")
}

fn resolve_live_utterance_text(final_raw: &str, last_partial: &str) -> String {
    let final_text = clean_transcript(final_raw);
    if !final_text.is_empty() {
        final_text
    } else {
        clean_transcript(last_partial)
    }
}

pub fn handle_transcribe(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!("CodictateWindowsHelper transcribe <wavPath> <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let wav_path = &args[2];
    let model_dir = &args[3];
    let result = (|| -> Result<String, String> {
        let mut model = load_model(model_dir)?;
        log_phase("transcribing wav...");
        let (samples, sample_rate) = load_wav_mono_f32(wav_path)?;
        let samples = resample_to_recording_rate(&samples, sample_rate)?;
        transcribe_samples(&mut model, samples)
    })();

    match result {
        Ok(text) => match emit_json(&FinalTranscriptMessage {
            kind: "final",
            text,
        }) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("CodictateWindowsHelper transcribe failed to write JSON: {err}");
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("CodictateWindowsHelper transcribe failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_stream(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!("CodictateWindowsHelper stream <vad|live> <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let mode = &args[2];
    let model_dir = &args[3];
    let result = match mode.as_str() {
        "vad" => run_vad_stream(model_dir),
        "live" => run_live_stream(model_dir),
        other => Err(format!("unknown stream mode: {other}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper stream failed: {err}");
            ExitCode::from(1)
        }
    }
}

fn run_vad_stream(model_dir: &str) -> Result<(), String> {
    let mut model = load_model(model_dir)?;
    let mut injector = TextInjector::new()?;
    let input = open_default_input_sample_stream()?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;
    log_phase("stream [vad]: audio input running");

    const RMS_THRESHOLD: f32 = 0.012;
    const SILENCE_COMMIT: usize = 8_000;
    const MIN_UTTERANCE: usize = 8_000;
    const MAX_UTTERANCE: usize = RECORDING_SAMPLE_RATE as usize * 30;

    let mut utterance = Vec::<f32>::new();
    let mut in_speech = false;
    let mut silence_accum = 0usize;

    loop {
        let input_chunk = match input.recv_timeout(STREAM_RECV_TIMEOUT) {
            Ok(chunk) => chunk,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        };

        resampler.process(&input_chunk, |chunk| {
            let chunk_rms = rms(chunk);
            if chunk_rms >= RMS_THRESHOLD {
                silence_accum = 0;
                if !in_speech {
                    in_speech = true;
                    utterance.clear();
                    log_phase("stream [vad]: speech start");
                }
                utterance.extend_from_slice(chunk);
                if utterance.len() >= MAX_UTTERANCE {
                    if let Some(text) = transcribe_for_stream(&mut model, &utterance)
                        && !text.is_empty()
                    {
                        injector.paste_text(&(text + " "))?;
                    }
                    utterance.clear();
                }
            } else if in_speech {
                utterance.extend_from_slice(chunk);
                silence_accum += chunk.len();
                if silence_accum >= SILENCE_COMMIT {
                    in_speech = false;
                    silence_accum = 0;
                    log_phase(format!(
                        "stream [vad]: speech end, transcribing {} samples",
                        utterance.len()
                    ));
                    if utterance.len() >= MIN_UTTERANCE
                        && let Some(text) = transcribe_for_stream(&mut model, &utterance)
                        && !text.is_empty()
                    {
                        injector.paste_text(&(text + " "))?;
                    }
                    utterance.clear();
                }
            }
            Ok(())
        })?;
    }

    Ok(())
}

fn run_live_stream(model_dir: &str) -> Result<(), String> {
    let mut model = load_model(model_dir)?;
    let mut injector = TextInjector::new()?;
    let input = open_default_input_sample_stream()?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;
    log_phase("stream [live]: audio input running");

    const RMS_THRESHOLD: f32 = 0.010;
    const SILENCE_COMMIT: usize = 24_000;
    const MIN_UTTERANCE: usize = 2_400;
    const MIN_SAMPLES_FOR_INFER: usize = RECORDING_SAMPLE_RATE as usize;
    const MIN_SAMPLES_BETWEEN_UPDATES: usize = 4_800;
    const MAX_UTTERANCE: usize = RECORDING_SAMPLE_RATE as usize * 20;

    let mut committed_text = String::new();
    let mut utterance = Vec::<f32>::new();
    let mut in_speech = false;
    let mut silence_accum = 0usize;
    let mut samples_since_last_update = 0usize;
    let mut last_live_text = String::new();
    let mut injected_display = String::new();

    loop {
        let input_chunk = match input.recv_timeout(STREAM_RECV_TIMEOUT) {
            Ok(chunk) => chunk,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        };

        resampler.process(&input_chunk, |chunk| {
            let chunk_rms = rms(chunk);
            match chunk_rms.partial_cmp(&RMS_THRESHOLD) {
                Some(Ordering::Greater | Ordering::Equal) => {
                    silence_accum = 0;
                    if !in_speech {
                        in_speech = true;
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_live_text.clear();
                        log_phase("stream [live]: voice active");
                    }

                    utterance.extend_from_slice(chunk);
                    samples_since_last_update += chunk.len();

                    let should_emit_update = utterance.len() >= MIN_SAMPLES_FOR_INFER
                        && samples_since_last_update >= MIN_SAMPLES_BETWEEN_UPDATES;
                    if should_emit_update {
                        samples_since_last_update = 0;
                        if let Some(partial_text) = transcribe_for_stream(&mut model, &utterance)
                            && !partial_text.is_empty()
                            && partial_text != last_live_text
                        {
                            last_live_text = partial_text.clone();
                            let full_text = join_transcript(&committed_text, &partial_text);
                            injector.update_live_line(&mut injected_display, &full_text)?;
                        }
                    }

                    if utterance.len() >= MAX_UTTERANCE {
                        commit_live_utterance(
                            &mut model,
                            &mut injector,
                            &mut committed_text,
                            &mut injected_display,
                            &utterance,
                            &last_live_text,
                        )?;
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_live_text.clear();
                    }
                }
                _ if in_speech => {
                    utterance.extend_from_slice(chunk);
                    silence_accum += chunk.len();

                    if silence_accum >= SILENCE_COMMIT {
                        in_speech = false;
                        silence_accum = 0;
                        log_phase("stream [live]: silence commit");
                        if utterance.len() >= MIN_UTTERANCE {
                            commit_live_utterance(
                                &mut model,
                                &mut injector,
                                &mut committed_text,
                                &mut injected_display,
                                &utterance,
                                &last_live_text,
                            )?;
                        }
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_live_text.clear();
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
    }

    Ok(())
}

fn commit_live_utterance(
    model: &mut ParakeetTDT,
    injector: &mut TextInjector,
    committed_text: &mut String,
    injected_display: &mut String,
    utterance: &[f32],
    last_live_text: &str,
) -> Result<(), String> {
    let final_text = match transcribe_for_stream(model, utterance) {
        Some(raw) => resolve_live_utterance_text(&raw, last_live_text),
        None => clean_transcript(last_live_text),
    };
    if final_text.is_empty() {
        return Ok(());
    }

    *committed_text = join_transcript(committed_text, &final_text);
    injector.update_live_line(injected_display, committed_text)
}
