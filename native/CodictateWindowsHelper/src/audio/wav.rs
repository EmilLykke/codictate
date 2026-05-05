use super::resample::RECORDING_SAMPLE_RATE;
use std::fs::File;
use std::io::BufWriter;

pub struct RecordingWavWriter {
    writer: hound::WavWriter<BufWriter<File>>,
}

impl RecordingWavWriter {
    pub fn create(path: &str) -> Result<Self, String> {
        let writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 1,
                sample_rate: RECORDING_SAMPLE_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|err| format!("failed to create wav: {err}"))?;

        Ok(Self { writer })
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<(), String> {
        for sample in samples {
            let sample = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            self.writer
                .write_sample(sample)
                .map_err(|err| format!("failed to write wav sample: {err}"))?;
        }
        Ok(())
    }

    pub fn finalize(self) -> Result<(), String> {
        self.writer
            .finalize()
            .map_err(|err| format!("finalize failed: {err}"))
    }
}

#[cfg(test)]
pub fn write_recording_wav(path: &str, samples: &[f32]) -> Result<(), String> {
    let mut writer = RecordingWavWriter::create(path)?;
    writer.write_samples(samples)?;
    writer.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_uses_recording_format() {
        let path = std::env::temp_dir().join(format!(
            "codictate-wav-test-{}-{:?}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_string = path.to_string_lossy().into_owned();

        write_recording_wav(&path_string, &[0.0, 0.5, -0.5]).unwrap();
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, RECORDING_SAMPLE_RATE);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);

        let _ = std::fs::remove_file(path);
    }
}
