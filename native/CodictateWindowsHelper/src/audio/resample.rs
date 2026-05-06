use rubato::{FftFixedInOut, Resampler};

pub const RECORDING_SAMPLE_RATE: u32 = 16_000;

pub struct StreamingResampler {
    inner: StreamingResamplerInner,
}

enum StreamingResamplerInner {
    Passthrough,
    Rubato(Box<RubatoStreamingResampler>),
}

struct RubatoStreamingResampler {
    input_sample_rate: u32,
    input_frames_seen: usize,
    output_frames_emitted: usize,
    resampler: FftFixedInOut<f32>,
    pending_input: Vec<f32>,
    outbuffer: Vec<Vec<f32>>,
    frames_to_skip: usize,
}

impl StreamingResampler {
    pub fn new(input_sample_rate: u32) -> Result<Self, String> {
        if input_sample_rate == RECORDING_SAMPLE_RATE {
            return Ok(Self {
                inner: StreamingResamplerInner::Passthrough,
            });
        }

        let resampler = FftFixedInOut::<f32>::new(
            input_sample_rate as usize,
            RECORDING_SAMPLE_RATE as usize,
            1024,
            1,
        )
        .map_err(|err| format!("resampler init failed: {err}"))?;
        let frames_to_skip = resampler.output_delay();
        let outbuffer = vec![vec![0.0f32; resampler.output_frames_max()]];

        Ok(Self {
            inner: StreamingResamplerInner::Rubato(Box::new(RubatoStreamingResampler {
                input_sample_rate,
                input_frames_seen: 0,
                output_frames_emitted: 0,
                resampler,
                pending_input: Vec::new(),
                outbuffer,
                frames_to_skip,
            })),
        })
    }

    pub fn process(
        &mut self,
        samples: &[f32],
        mut emit: impl FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<(), String> {
        match &mut self.inner {
            StreamingResamplerInner::Passthrough => emit(samples),
            StreamingResamplerInner::Rubato(state) => {
                state.input_frames_seen += samples.len();
                state.pending_input.extend_from_slice(samples);

                loop {
                    let input_frames_next = state.resampler.input_frames_next();
                    if state.pending_input.len() < input_frames_next {
                        break;
                    }

                    let indata_slices: [&[f32]; 1] = [state.pending_input.as_slice()];
                    let (nbr_in, nbr_out) = state
                        .resampler
                        .process_into_buffer(&indata_slices, &mut state.outbuffer, None)
                        .map_err(|err| format!("resample failed: {err}"))?;
                    emit_resampled_output(
                        &state.outbuffer[0][..nbr_out],
                        &mut state.frames_to_skip,
                        &mut state.output_frames_emitted,
                        None,
                        &mut emit,
                    )?;
                    state.pending_input.drain(..nbr_in);
                }

                Ok(())
            }
        }
    }

    pub fn finish(
        &mut self,
        mut emit: impl FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<(), String> {
        match &mut self.inner {
            StreamingResamplerInner::Passthrough => Ok(()),
            StreamingResamplerInner::Rubato(state) => {
                let output_limit =
                    expected_output_len(state.input_frames_seen, state.input_sample_rate);

                if !state.pending_input.is_empty() {
                    let indata_slices: [&[f32]; 1] = [state.pending_input.as_slice()];
                    let (_nbr_in, nbr_out) = state
                        .resampler
                        .process_partial_into_buffer(
                            Some(&indata_slices),
                            &mut state.outbuffer,
                            None,
                        )
                        .map_err(|err| format!("resample final chunk failed: {err}"))?;
                    emit_resampled_output(
                        &state.outbuffer[0][..nbr_out],
                        &mut state.frames_to_skip,
                        &mut state.output_frames_emitted,
                        Some(output_limit),
                        &mut emit,
                    )?;
                    state.pending_input.clear();
                }

                while state.output_frames_emitted < output_limit {
                    let (_nbr_in, nbr_out) = state
                        .resampler
                        .process_partial_into_buffer(None::<&[&[f32]]>, &mut state.outbuffer, None)
                        .map_err(|err| format!("resample flush failed: {err}"))?;
                    if nbr_out == 0 {
                        break;
                    }
                    emit_resampled_output(
                        &state.outbuffer[0][..nbr_out],
                        &mut state.frames_to_skip,
                        &mut state.output_frames_emitted,
                        Some(output_limit),
                        &mut emit,
                    )?;
                }

                Ok(())
            }
        }
    }
}

fn emit_resampled_output(
    samples: &[f32],
    frames_to_skip: &mut usize,
    output_frames_emitted: &mut usize,
    output_limit: Option<usize>,
    emit: &mut impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<(), String> {
    let skip = (*frames_to_skip).min(samples.len());
    *frames_to_skip -= skip;
    if skip < samples.len() {
        let samples = &samples[skip..];
        let emit_len = output_limit
            .map(|limit| {
                limit
                    .saturating_sub(*output_frames_emitted)
                    .min(samples.len())
            })
            .unwrap_or(samples.len());
        if emit_len > 0 {
            emit(&samples[..emit_len])?;
            *output_frames_emitted += emit_len;
        }
    }
    Ok(())
}

fn expected_output_len(input_frames: usize, input_sample_rate: u32) -> usize {
    ((input_frames as f64 * RECORDING_SAMPLE_RATE as f64) / input_sample_rate as f64).round()
        as usize
}

#[cfg(test)]
pub fn resample_mono_to_recording_rate(
    samples: &[f32],
    input_sample_rate: u32,
) -> Result<Vec<f32>, String> {
    let mut out = Vec::new();
    let mut resampler = StreamingResampler::new(input_sample_rate)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_outputs_expected_length() {
        let input = vec![0.0; 48_000];
        let output = resample_mono_to_recording_rate(&input, 48_000).unwrap();
        assert_eq!(output.len(), RECORDING_SAMPLE_RATE as usize);
    }

    #[test]
    fn streaming_resampler_handles_chunk_boundaries() {
        let mut resampler = StreamingResampler::new(48_000).unwrap();
        let mut output = Vec::new();

        resampler
            .process(&vec![0.0; 10_000], |chunk| {
                output.extend_from_slice(chunk);
                Ok(())
            })
            .unwrap();
        resampler
            .process(&vec![0.0; 38_000], |chunk| {
                output.extend_from_slice(chunk);
                Ok(())
            })
            .unwrap();
        resampler
            .finish(|chunk| {
                output.extend_from_slice(chunk);
                Ok(())
            })
            .unwrap();

        assert_eq!(output.len(), RECORDING_SAMPLE_RATE as usize);
    }
}
