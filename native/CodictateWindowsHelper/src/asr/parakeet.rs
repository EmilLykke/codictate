use crate::audio::capture::open_input_sample_stream;
use crate::audio::resample::{RECORDING_SAMPLE_RATE, StreamingResampler};
use crate::ipc::emit_json;
use crate::keyboard::inject;
use arboard::Clipboard;
use parakeet_rs::{
    ExecutionConfig, ExecutionProvider, ParakeetTDT, TimedToken, TimestampMode, Transcriber,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

const STREAM_RECV_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Serialize)]
struct FinalTranscriptMessage {
    kind: &'static str,
    text: String,
    /// When each sentence of `text` was spoken. Omitted when there is no transcript or no
    /// timings, so readers that do not know the field see the line they always did.
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<Timing>,
}

/// The batch `final` line's `timing` (`src/shared/command-line-protocol.ts`). Windows times
/// whole sentences: the same `TimestampMode::Sentences` tokens `text` is joined from.
#[derive(Serialize, Debug, PartialEq)]
struct Timing {
    unit: &'static str,
    items: Vec<TimedItem>,
}

/// One timed span of `text`, in seconds from the start of the audio, rounded to ms.
#[derive(Serialize, Debug, PartialEq)]
struct TimedItem {
    text: String,
    start: f64,
    end: f64,
}

/// A batch transcript and its sentence timing.
struct TimedTranscription {
    text: String,
    timing: Option<Timing>,
}

#[derive(Serialize)]
struct SessionReadyMessage {
    kind: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeSessionRequest {
    id: u64,
    audio_path: String,
}

/// A session `final`: the one-shot `final` plus the request id it answers.
#[derive(Serialize)]
struct SessionFinalTranscriptMessage {
    kind: &'static str,
    id: u64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<Timing>,
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

    fn replace_typed_segment(&mut self, typed: &mut String, next: &str) -> Result<(), String> {
        let common = common_prefix_byte_len(typed, next);
        let delete_chars = typed[common..].chars().count();
        let insert = &next[common..];

        if delete_chars > 0 {
            let modifiers_released = inject::release_modifiers_for_text_injection();
            let deleted = modifiers_released && inject::send_backspaces(delete_chars);
            if !deleted {
                return Err("failed to replace live transcript suffix".to_string());
            }
        }

        self.paste_text(insert)?;
        typed.clear();
        typed.push_str(next);
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

fn round_ms(seconds: f32) -> f64 {
    (f64::from(seconds) * 1000.0).round() / 1000.0
}

/// The `timing` for a batch transcript: each sentence token cleaned the way `text` is, empty
/// and non-finite ones skipped. `None` when `text` is empty or nothing is left.
fn sentence_timing(text: &str, tokens: &[TimedToken]) -> Option<Timing> {
    if text.is_empty() {
        return None;
    }
    let items: Vec<TimedItem> = tokens
        .iter()
        .filter(|token| token.start.is_finite() && token.end.is_finite() && token.start >= 0.0)
        .filter_map(|token| {
            let text = clean_transcript(&token.text);
            if text.is_empty() {
                return None;
            }
            let start = round_ms(token.start);
            Some(TimedItem {
                text,
                start,
                end: round_ms(token.end).max(start),
            })
        })
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(Timing {
            unit: "sentence",
            items,
        })
    }
}

/// `transcribe_samples` that also keeps the sentence timings. Still `Sentences` mode: in
/// parakeet-rs 0.3.8 `result.text` depends on the mode (`Words` drops repeated words), and
/// the sentence tokens are what that text is joined from.
fn transcribe_samples_timed(
    model: &mut ParakeetTDT,
    samples: Vec<f32>,
) -> Result<TimedTranscription, String> {
    if samples.is_empty() {
        return Ok(TimedTranscription {
            text: String::new(),
            timing: None,
        });
    }
    let result = model
        .transcribe_samples(
            samples,
            RECORDING_SAMPLE_RATE,
            1,
            Some(TimestampMode::Sentences),
        )
        .map_err(|err| format!("Parakeet transcription failed: {err}"))?;
    let text = clean_transcript(&result.text);
    let timing = sentence_timing(&text, &result.tokens);
    Ok(TimedTranscription { text, timing })
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

fn load_wav_for_transcription(wav_path: &str) -> Result<Vec<f32>, String> {
    let (samples, sample_rate) = load_wav_mono_f32(wav_path)?;
    resample_to_recording_rate(&samples, sample_rate)
}

fn transcribe_wav_timed(
    model: &mut ParakeetTDT,
    wav_path: &str,
) -> Result<TimedTranscription, String> {
    transcribe_samples_timed(model, load_wav_for_transcription(wav_path)?)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f32 = samples.iter().map(|sample| sample * sample).sum();
    (energy / samples.len() as f32).sqrt()
}

fn resolve_live_utterance_text(final_raw: &str, last_partial: &str) -> String {
    let final_text = clean_transcript(final_raw);
    if !final_text.is_empty() {
        final_text
    } else {
        clean_transcript(last_partial)
    }
}

fn completed_stable_prefix(previous: &str, current: &str) -> String {
    let common = common_prefix_byte_len(previous, current);
    let common_prefix = &current[..common];
    let trimmed = common_prefix.trim_end();
    let Some(last_boundary) = trimmed.rfind(char::is_whitespace) else {
        return String::new();
    };
    clean_transcript(&trimmed[..last_boundary])
}

fn append_live_prefix(
    injector: &mut TextInjector,
    typed_utterance: &mut String,
    next_prefix: &str,
) -> Result<(), String> {
    if next_prefix.len() <= typed_utterance.len()
        || !next_prefix.starts_with(typed_utterance.as_str())
    {
        return Ok(());
    }

    let insert = &next_prefix[typed_utterance.len()..];
    injector.paste_text(insert)?;
    typed_utterance.push_str(insert);
    Ok(())
}

pub fn handle_transcribe(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!("CodictateWindowsHelper transcribe <wavPath> <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let wav_path = &args[2];
    let model_dir = &args[3];
    let result = (|| -> Result<TimedTranscription, String> {
        let mut model = load_model(model_dir)?;
        log_phase("transcribing wav...");
        transcribe_wav_timed(&mut model, wav_path)
    })();

    match result {
        Ok(TimedTranscription { text, timing }) => match emit_json(&FinalTranscriptMessage {
            kind: "final",
            text,
            timing,
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

pub fn handle_transcribe_session(args: &[String]) -> ExitCode {
    if args.len() < 3 {
        eprintln!("CodictateWindowsHelper transcribe-session <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let model_dir = &args[2];
    let result = (|| -> Result<(), String> {
        let mut model = load_model(model_dir)?;
        emit_json(&SessionReadyMessage { kind: "ready" })
            .map_err(|err| format!("failed to write ready response: {err}"))?;

        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = line.map_err(|err| format!("failed to read session request: {err}"))?;
            if line.trim().is_empty() {
                continue;
            }
            let request: TranscribeSessionRequest = serde_json::from_str(&line)
                .map_err(|err| format!("invalid transcribe-session request: {err}"))?;
            if request.audio_path.is_empty() {
                return Err("invalid transcribe-session request: audioPath is empty".to_string());
            }

            log_phase(format!("transcribe session request {}...", request.id));
            let TimedTranscription { text, timing } =
                transcribe_wav_timed(&mut model, &request.audio_path)?;
            emit_json(&SessionFinalTranscriptMessage {
                kind: "final",
                id: request.id,
                text,
                timing,
            })
            .map_err(|err| format!("failed to write session response: {err}"))?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper transcribe-session failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_stream(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!(
            "CodictateWindowsHelper stream <vad|live> <parakeetModelDir> [deviceIndexOrEndpointId]"
        );
        return ExitCode::from(1);
    }

    let mode = &args[2];
    let model_dir = &args[3];
    let device_ref = args.get(4).map(String::as_str);
    let result = match mode.as_str() {
        "vad" => run_vad_stream(model_dir, device_ref),
        "live" => run_live_stream(model_dir, device_ref),
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

fn run_vad_stream(model_dir: &str, device_ref: Option<&str>) -> Result<(), String> {
    // Capture starts before the model loads. A slow load takes seconds, and a mic opened only
    // after that loses everything said in the meantime. The input channel holds about 40 s of
    // chunks until the loop reads them, so a slow load costs latency, never speech.
    let input = open_input_sample_stream(device_ref)?;
    log_phase("stream [vad]: audio input running");
    let mut model = load_model(model_dir)?;
    let mut injector = TextInjector::new()?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;

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

fn run_live_stream(model_dir: &str, device_ref: Option<&str>) -> Result<(), String> {
    // Capture first, for the reason in `run_vad_stream`.
    let input = open_input_sample_stream(device_ref)?;
    log_phase("stream [live]: audio input running");
    let mut model = load_model(model_dir)?;
    let mut injector = TextInjector::new()?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;

    const RMS_THRESHOLD: f32 = 0.010;
    const SILENCE_COMMIT: usize = 24_000;
    const MIN_UTTERANCE: usize = 2_400;
    const MIN_SAMPLES_FOR_INFER: usize = RECORDING_SAMPLE_RATE as usize;
    const MIN_SAMPLES_BETWEEN_UPDATES: usize = 4_800;
    const MAX_UTTERANCE: usize = RECORDING_SAMPLE_RATE as usize * 20;

    let mut utterance = Vec::<f32>::new();
    let mut in_speech = false;
    let mut silence_accum = 0usize;
    let mut samples_since_last_update = 0usize;
    let mut last_partial_text = String::new();
    let mut typed_utterance = String::new();

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
                        last_partial_text.clear();
                        typed_utterance.clear();
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
                            && partial_text != last_partial_text
                        {
                            let stable_prefix =
                                completed_stable_prefix(&last_partial_text, &partial_text);
                            append_live_prefix(
                                &mut injector,
                                &mut typed_utterance,
                                &stable_prefix,
                            )?;
                            last_partial_text = partial_text;
                        }
                    }

                    if utterance.len() >= MAX_UTTERANCE {
                        commit_live_utterance(
                            &mut model,
                            &mut injector,
                            &mut typed_utterance,
                            &utterance,
                            &last_partial_text,
                        )?;
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_partial_text.clear();
                    }
                }
                _ if in_speech => {
                    utterance.extend_from_slice(chunk);
                    silence_accum += chunk.len();

                    if silence_accum >= SILENCE_COMMIT {
                        in_speech = false;
                        silence_accum = 0;
                        log_phase("stream [live]: silence commit");
                        if utterance.len() >= MIN_UTTERANCE || !typed_utterance.is_empty() {
                            commit_live_utterance(
                                &mut model,
                                &mut injector,
                                &mut typed_utterance,
                                &utterance,
                                &last_partial_text,
                            )?;
                        }
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_partial_text.clear();
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
    typed_utterance: &mut String,
    utterance: &[f32],
    last_partial_text: &str,
) -> Result<(), String> {
    let final_text = match transcribe_for_stream(model, utterance) {
        Some(raw) => resolve_live_utterance_text(&raw, last_partial_text),
        None => clean_transcript(last_partial_text),
    };
    if final_text.is_empty() {
        return Ok(());
    }

    injector.replace_typed_segment(typed_utterance, &final_text)?;
    if !inject::send_space() {
        return Err("failed to insert trailing space".to_string());
    }
    typed_utterance.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_request_uses_the_shared_camel_case_contract() {
        let request: TranscribeSessionRequest =
            serde_json::from_str(r#"{"id":7,"audioPath":"C:\\clips\\sample.wav"}"#)
                .expect("request should decode");

        assert_eq!(request.id, 7);
        assert_eq!(request.audio_path, r"C:\clips\sample.wav");
        assert!(
            serde_json::from_str::<TranscribeSessionRequest>(
                r#"{"id":-1,"audioPath":"sample.wav"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<TranscribeSessionRequest>(
                r#"{"id":1.5,"audioPath":"sample.wav"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn session_messages_emit_ready_and_correlated_final_shapes() {
        let ready = serde_json::to_string(&SessionReadyMessage { kind: "ready" })
            .expect("ready response should encode");
        let final_response = serde_json::to_string(&SessionFinalTranscriptMessage {
            kind: "final",
            id: 7,
            text: "hej verden".to_string(),
            timing: None,
        })
        .expect("final response should encode");

        assert_eq!(ready, r#"{"kind":"ready"}"#);
        assert_eq!(
            final_response,
            r#"{"kind":"final","id":7,"text":"hej verden"}"#
        );
    }

    #[test]
    fn session_final_carries_the_same_timing_as_the_batch_final() {
        let timing = sentence_timing("Hej verden.", &[token("Hej verden.", 0.0, 1.25)]);
        let line = serde_json::to_string(&SessionFinalTranscriptMessage {
            kind: "final",
            id: 1,
            text: "Hej verden.".to_string(),
            timing,
        })
        .expect("final response should encode");

        assert_eq!(
            line,
            r#"{"kind":"final","id":1,"text":"Hej verden.","timing":{"unit":"sentence","items":[{"text":"Hej verden.","start":0.0,"end":1.25}]}}"#
        );
    }

    fn token(text: &str, start: f32, end: f32) -> TimedToken {
        TimedToken {
            text: text.to_string(),
            start,
            end,
        }
    }

    #[test]
    fn batch_final_carries_sentence_timing() {
        let text = "Hello there. How are you?".to_string();
        let timing = sentence_timing(
            &text,
            &[
                token("Hello there.", 0.0, 1.2),
                token(" How  are you? ", 1.4567, 2.0004),
            ],
        );
        let line = serde_json::to_string(&FinalTranscriptMessage {
            kind: "final",
            text,
            timing,
        })
        .expect("final line should encode");

        assert_eq!(
            line,
            r#"{"kind":"final","text":"Hello there. How are you?","timing":{"unit":"sentence","items":[{"text":"Hello there.","start":0.0,"end":1.2},{"text":"How are you?","start":1.457,"end":2.0}]}}"#
        );
    }

    #[test]
    fn batch_final_omits_timing_when_there_is_none() {
        let line = serde_json::to_string(&FinalTranscriptMessage {
            kind: "final",
            text: String::new(),
            timing: sentence_timing("", &[token("Hello.", 0.0, 1.0)]),
        })
        .expect("final line should encode");

        assert_eq!(line, r#"{"kind":"final","text":""}"#);
    }

    #[test]
    fn sentence_timing_skips_empty_and_unusable_tokens() {
        let timing = sentence_timing(
            "Hi.",
            &[
                token("  ", 0.0, 0.5),
                token("Hi.", 0.5, 0.4),
                token("Gone.", f32::NAN, 1.0),
                token("Before.", -1.0, 1.0),
            ],
        )
        .expect("one usable sentence");

        assert_eq!(
            timing,
            Timing {
                unit: "sentence",
                items: vec![TimedItem {
                    text: "Hi.".to_string(),
                    start: 0.5,
                    end: 0.5,
                }],
            }
        );
        assert_eq!(sentence_timing("Hi.", &[token(" ", 0.0, 1.0)]), None);
    }

    #[test]
    fn stable_prefix_lags_by_one_completed_word() {
        assert_eq!(
            completed_stable_prefix("hello world", "hello world again"),
            "hello"
        );
    }

    #[test]
    fn stable_prefix_waits_for_punctuation_to_settle() {
        assert_eq!(completed_stable_prefix("hello world", "hello, world"), "");
        assert_eq!(
            completed_stable_prefix("hello, world", "hello, world again"),
            "hello,"
        );
    }

    #[test]
    fn stable_prefix_can_grow_beyond_one_word() {
        assert_eq!(
            completed_stable_prefix("hello brave world", "hello brave world again"),
            "hello brave"
        );
    }
}
