// `extract-audio <input> <output.wav>`: turns any audio or video file Media Foundation can read
// into the 16 kHz mono 16-bit PCM WAV every Speech Engine accepts.
//
// The Windows half of native/CodictateMediaHelper (AVFoundation, macOS): the same argv, output
// format, exit codes and one-line reason on stderr, because src/bun/file-transcription/extract-audio.ts reads
// both. Every audio stream is mixed down, like the macOS helper's mix output, so a screen
// recording with a microphone track and a system-audio track is transcribed whole. Prints
// nothing on success.
//
// Exit codes:
//   0  the WAV was written
//   2  usage error
//   3  the input could not be opened or decoded as media
//   4  the input opened but has no audio track
//   5  the output could not be written, or Media Foundation itself is unavailable

#[cfg_attr(not(windows), allow(dead_code))]
mod decode;
#[cfg_attr(not(windows), allow(dead_code))]
mod mix;
#[cfg_attr(not(windows), allow(dead_code))]
mod pcm;

use crate::audio::wav::RecordingWavWriter;
use std::process::ExitCode;

const USAGE: &str = "usage: CodictateWindowsHelper extract-audio <input> <output.wav>";

#[cfg_attr(not(windows), allow(dead_code))]
/// RIFF sizes are 32-bit and the 16-bit mono header is 44 bytes: about 37 hours at 16 kHz.
const MAX_OUTPUT_SAMPLES: u64 = (u32::MAX as u64 - 36) / 2;

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub enum ExtractError {
    Usage,
    Unreadable(String),
    NoAudio,
    /// The output could not be written. Media Foundation failing to start is reported here too:
    /// either way it is this installation's fault, not the user's file.
    WriteFailed(String),
}

impl ExtractError {
    pub fn exit_code(&self) -> u8 {
        match self {
            ExtractError::Usage => 2,
            ExtractError::Unreadable(_) => 3,
            ExtractError::NoAudio => 4,
            ExtractError::WriteFailed(_) => 5,
        }
    }

    /// The single line written to stderr, which the caller shows as the reason.
    pub fn message(&self) -> String {
        match self {
            ExtractError::Usage => USAGE.to_string(),
            ExtractError::Unreadable(message) | ExtractError::WriteFailed(message) => {
                one_line(message)
            }
            ExtractError::NoAudio => "the file has no audio track".to_string(),
        }
    }
}

pub fn handle_extract_audio(args: &[String]) -> ExitCode {
    let result = parse_args(args).and_then(|(input, output)| extract_audio(input, output));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{}", err.message());
            ExitCode::from(err.exit_code())
        }
    }
}

fn parse_args(args: &[String]) -> Result<(&str, &str), ExtractError> {
    match args {
        [_, command, input, output] if command == "extract-audio" => Ok((input, output)),
        _ => Err(ExtractError::Usage),
    }
}

fn extract_audio(input: &str, output: &str) -> Result<(), ExtractError> {
    let readable = std::fs::metadata(input)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
        && std::fs::File::open(input).is_ok();
    if !readable {
        return Err(ExtractError::Unreadable(format!("cannot read {input}")));
    }
    // Media Foundation resolves the path as a URL, so hand it an absolute one.
    let input = std::path::absolute(input)
        .map_err(|_| ExtractError::Unreadable(format!("cannot read {input}")))?;
    decode::extract_audio(&input, output)
}

/// Media Foundation and Windows error text can span lines; the caller reads one.
fn one_line(message: &str) -> String {
    message.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The output WAV, refusing to grow past what a RIFF header can describe.
struct ExtractOutput {
    writer: RecordingWavWriter,
    path: String,
    samples_written: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ExtractOutput {
    fn create(path: &str) -> Result<Self, ExtractError> {
        let writer = RecordingWavWriter::create(path)
            .map_err(|_| ExtractError::WriteFailed(format!("cannot write {path}")))?;
        Ok(Self {
            writer,
            path: path.to_string(),
            samples_written: 0,
        })
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), ExtractError> {
        self.samples_written += samples.len() as u64;
        if self.samples_written > MAX_OUTPUT_SAMPLES {
            return Err(ExtractError::Unreadable(
                "the audio is too long to transcribe in one file".to_string(),
            ));
        }
        self.writer
            .write_samples(samples)
            .map_err(|err| ExtractError::WriteFailed(format!("cannot write {}: {err}", self.path)))
    }

    fn finalize(self) -> Result<(), ExtractError> {
        let path = self.path;
        self.writer
            .finalize()
            .map_err(|err| ExtractError::WriteFailed(format!("cannot write {path}: {err}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn exit_codes_match_the_macos_media_helper() {
        assert_eq!(ExtractError::Usage.exit_code(), 2);
        assert_eq!(ExtractError::Unreadable(String::new()).exit_code(), 3);
        assert_eq!(ExtractError::NoAudio.exit_code(), 4);
        assert_eq!(ExtractError::WriteFailed(String::new()).exit_code(), 5);
    }

    #[test]
    fn parses_exactly_input_and_output() {
        let full = args(&["helper", "extract-audio", "in.mp4", "out.wav"]);
        assert_eq!(parse_args(&full), Ok(("in.mp4", "out.wav")));

        for bad in [
            args(&["helper", "extract-audio"]),
            args(&["helper", "extract-audio", "in.mp4"]),
            args(&["helper", "extract-audio", "in.mp4", "out.wav", "extra"]),
            args(&["helper", "record", "in.mp4", "out.wav"]),
        ] {
            assert_eq!(parse_args(&bad), Err(ExtractError::Usage));
        }
    }

    #[test]
    fn messages_are_one_line() {
        let err = ExtractError::Unreadable("cannot decode the file:\r\n  bad header\r\n".into());
        assert_eq!(err.message(), "cannot decode the file: bad header");
        assert_eq!(
            ExtractError::NoAudio.message(),
            "the file has no audio track"
        );
        assert_eq!(ExtractError::Usage.message(), USAGE);
    }

    #[test]
    fn missing_input_is_unreadable_before_any_decoding() {
        let missing = std::env::temp_dir().join(format!(
            "codictate-extract-missing-{}.mp4",
            std::process::id()
        ));
        let err = extract_audio(&missing.to_string_lossy(), "unused.wav").unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    #[test]
    fn output_refuses_audio_a_riff_header_cannot_describe() {
        let path = std::env::temp_dir().join(format!(
            "codictate-extract-limit-{}-{:?}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_string = path.to_string_lossy().into_owned();
        let mut output = ExtractOutput::create(&path_string).unwrap();
        output.samples_written = MAX_OUTPUT_SAMPLES - 1;
        assert!(output.write(&[0.0]).is_ok());
        assert_eq!(output.write(&[0.0]).unwrap_err().exit_code(), 3);
        drop(output);
        let _ = std::fs::remove_file(path);
    }
}
