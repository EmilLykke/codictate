// Decoded PCM bytes as mono f32: the format-dependent half of extract-audio, kept free of
// Media Foundation so it can be tested anywhere.

/// Media Foundation time units: 100 ns.
const MF_TICKS_PER_SECOND: u128 = 10_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleFormat {
    U8,
    I16,
    I24,
    I32,
    F32,
}

impl SampleFormat {
    /// The decoder's output, from the media type's float flag and `MF_MT_AUDIO_BITS_PER_SAMPLE`.
    pub fn from_media_type(is_float: bool, bits_per_sample: u32) -> Option<Self> {
        match (is_float, bits_per_sample) {
            (true, 32) => Some(SampleFormat::F32),
            (false, 8) => Some(SampleFormat::U8),
            (false, 16) => Some(SampleFormat::I16),
            (false, 24) => Some(SampleFormat::I24),
            (false, 32) => Some(SampleFormat::I32),
            _ => None,
        }
    }

    pub fn bytes(self) -> usize {
        match self {
            SampleFormat::U8 => 1,
            SampleFormat::I16 => 2,
            SampleFormat::I24 => 3,
            SampleFormat::I32 | SampleFormat::F32 => 4,
        }
    }

    fn read(self, bytes: &[u8]) -> f32 {
        match self {
            SampleFormat::U8 => (bytes[0] as f32 - 128.0) / 128.0,
            SampleFormat::I16 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32_768.0,
            SampleFormat::I24 => {
                // Sign-extend by placing the 24 bits at the top of an i32.
                let value = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8;
                value as f32 / 8_388_608.0
            }
            SampleFormat::I32 => {
                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32
                    / 2_147_483_648.0
            }
            SampleFormat::F32 => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcmLayout {
    pub format: SampleFormat,
    pub channels: usize,
    pub sample_rate: u32,
}

/// Appends interleaved PCM to `out` as mono, averaging the channels. A trailing partial frame,
/// which a well-formed decoder never produces, is dropped.
pub fn downmix_to_mono(bytes: &[u8], layout: PcmLayout, out: &mut Vec<f32>) {
    let sample_bytes = layout.format.bytes();
    let frame_bytes = sample_bytes * layout.channels;
    if frame_bytes == 0 {
        return;
    }
    let scale = 1.0 / layout.channels as f32;
    out.reserve(bytes.len() / frame_bytes);
    for frame in bytes.chunks_exact(frame_bytes) {
        let sum: f32 = frame
            .chunks_exact(sample_bytes)
            .map(|sample| layout.format.read(sample))
            .sum();
        out.push(sum * scale);
    }
}

/// Frames of silence, per stream, that line each stream's first sample up with the others on
/// the file's timeline, as AVFoundation's mix output does. `first_timestamps` holds each stream's
/// first sample time in 100 ns units, or `None` for a stream that produced no samples.
///
/// Only the offset from the earliest stream becomes silence. The timeline itself can start
/// anywhere: an MPEG-TS clock is often hours in, and padding from zero would prepend all of it.
pub fn leading_silence_frames(first_timestamps: &[Option<i64>], sample_rate: u32) -> Vec<usize> {
    let earliest = first_timestamps.iter().flatten().min().copied();
    first_timestamps
        .iter()
        .map(|timestamp| match (timestamp, earliest) {
            (Some(timestamp), Some(earliest)) => {
                let offset = (*timestamp as i128 - earliest as i128) as u128;
                (offset * sample_rate as u128 / MF_TICKS_PER_SECOND) as usize
            }
            _ => 0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(format: SampleFormat, channels: usize) -> PcmLayout {
        PcmLayout {
            format,
            channels,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn maps_media_types_to_sample_formats() {
        assert_eq!(
            SampleFormat::from_media_type(true, 32),
            Some(SampleFormat::F32)
        );
        assert_eq!(
            SampleFormat::from_media_type(false, 16),
            Some(SampleFormat::I16)
        );
        assert_eq!(
            SampleFormat::from_media_type(false, 24),
            Some(SampleFormat::I24)
        );
        assert_eq!(SampleFormat::from_media_type(true, 64), None);
        assert_eq!(SampleFormat::from_media_type(false, 12), None);
    }

    #[test]
    fn averages_stereo_float_to_mono() {
        let bytes: Vec<u8> = [0.5f32, -0.5, 1.0, 0.0]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut out = Vec::new();
        downmix_to_mono(&bytes, layout(SampleFormat::F32, 2), &mut out);
        assert_eq!(out, vec![0.0, 0.5]);
    }

    #[test]
    fn reads_integer_formats_at_full_scale() {
        let mut out = Vec::new();
        downmix_to_mono(&[0, 255, 128], layout(SampleFormat::U8, 1), &mut out);
        assert_eq!(out, vec![-1.0, 127.0 / 128.0, 0.0]);

        out.clear();
        let i16_bytes: Vec<u8> = [i16::MIN, 16_384]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        downmix_to_mono(&i16_bytes, layout(SampleFormat::I16, 1), &mut out);
        assert_eq!(out, vec![-1.0, 0.5]);

        out.clear();
        // -8_388_608 (minimum) and +4_194_304 (half scale) as little-endian 24-bit.
        downmix_to_mono(
            &[0x00, 0x00, 0x80, 0x00, 0x00, 0x40],
            layout(SampleFormat::I24, 1),
            &mut out,
        );
        assert_eq!(out, vec![-1.0, 0.5]);

        out.clear();
        downmix_to_mono(
            &i32::MIN.to_le_bytes(),
            layout(SampleFormat::I32, 1),
            &mut out,
        );
        assert_eq!(out, vec![-1.0]);
    }

    #[test]
    fn drops_a_trailing_partial_frame() {
        let bytes: Vec<u8> = [1000i16, 1000, 2000]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut out = Vec::new();
        downmix_to_mono(&bytes, layout(SampleFormat::I16, 2), &mut out);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn six_channels_average_to_one() {
        let bytes: Vec<u8> = [0.6f32; 6]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut out = Vec::new();
        downmix_to_mono(&bytes, layout(SampleFormat::F32, 6), &mut out);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.6).abs() < 1e-6);
    }

    /// Two hours in 100 ns units, a typical MPEG-TS start time.
    const TWO_HOURS: i64 = 2 * 60 * 60 * 10_000_000;

    #[test]
    fn a_single_late_stream_gets_no_leading_silence() {
        assert_eq!(leading_silence_frames(&[Some(TWO_HOURS)], 16_000), vec![0]);
        assert_eq!(leading_silence_frames(&[Some(0)], 16_000), vec![0]);
    }

    #[test]
    fn late_streams_are_padded_by_their_difference_only() {
        assert_eq!(
            leading_silence_frames(&[Some(TWO_HOURS + 10_000_000), Some(TWO_HOURS)], 16_000),
            vec![16_000, 0]
        );
        assert_eq!(
            leading_silence_frames(&[Some(TWO_HOURS), Some(TWO_HOURS + 5_000_000)], 44_100),
            vec![0, 22_050]
        );
    }

    #[test]
    fn streams_without_samples_get_no_silence_and_do_not_set_the_start() {
        assert_eq!(leading_silence_frames(&[], 16_000), Vec::<usize>::new());
        assert_eq!(leading_silence_frames(&[None, None], 16_000), vec![0, 0]);
        assert_eq!(
            leading_silence_frames(
                &[None, Some(TWO_HOURS), Some(TWO_HOURS + 10_000_000)],
                16_000
            ),
            vec![0, 0, 16_000]
        );
    }

    #[test]
    fn negative_and_zero_starts_are_measured_from_the_earliest() {
        assert_eq!(
            leading_silence_frames(&[Some(-5_000_000), Some(0)], 16_000),
            vec![0, 8_000]
        );
        assert_eq!(
            leading_silence_frames(&[Some(0), Some(0)], 16_000),
            vec![0, 0]
        );
        assert_eq!(
            leading_silence_frames(&[Some(i64::MIN), Some(i64::MAX)], 1),
            vec![0, (u64::MAX / 10_000_000) as usize]
        );
    }
}
