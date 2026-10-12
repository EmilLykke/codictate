// Sums several 16 kHz mono streams into one, each placed at its start time on the file's
// timeline relative to the earliest stream.
//
// Media Foundation hands out samples from all selected streams in file order, so one stream runs
// ahead of another by at most the container's interleave. Only that difference is held here; the
// rest goes straight to the output. Nothing is emitted until every stream has started or finished,
// because only then is the earliest start known.

use super::pcm::leading_silence_frames;
use crate::audio::resample::RECORDING_SAMPLE_RATE;
use std::collections::VecDeque;

/// Frames mixed per call to `emit`, so the scratch buffer stays small.
const MIX_CHUNK_FRAMES: usize = 8_192;

pub struct StreamMixer {
    inputs: Vec<MixerInput>,
    scratch: Vec<f32>,
    aligned: bool,
}

#[derive(Default)]
struct MixerInput {
    /// Leading silence still to be mixed in ahead of `queue`.
    silence: usize,
    queue: VecDeque<f32>,
    /// The stream's first sample time, in Media Foundation's 100 ns units.
    first_timestamp: Option<i64>,
    finished: bool,
}

impl MixerInput {
    fn len(&self) -> usize {
        self.silence + self.queue.len()
    }
}

impl StreamMixer {
    pub fn new(streams: usize) -> Self {
        Self {
            inputs: (0..streams).map(|_| MixerInput::default()).collect(),
            scratch: Vec::with_capacity(MIX_CHUNK_FRAMES),
            aligned: false,
        }
    }

    /// The stream's first sample is stamped `timestamp`. Call it before the stream's first
    /// `push`; later calls are ignored.
    pub fn start(&mut self, stream: usize, timestamp: i64) {
        self.inputs[stream].first_timestamp.get_or_insert(timestamp);
    }

    pub fn push(&mut self, stream: usize, samples: &[f32]) {
        self.inputs[stream].queue.extend(samples);
    }

    /// The stream has no more samples; from here on it contributes silence.
    pub fn finish(&mut self, stream: usize) {
        self.inputs[stream].finished = true;
    }

    /// Mixes and hands on every frame that no unfinished stream can still add to. Once every
    /// stream is finished, that is everything left.
    pub fn drain<E>(&mut self, mut emit: impl FnMut(&[f32]) -> Result<(), E>) -> Result<(), E> {
        if !self.align() {
            return Ok(());
        }
        let mut ready = self.ready_frames();
        while ready > 0 {
            let frames = ready.min(MIX_CHUNK_FRAMES);
            self.scratch.clear();
            self.scratch.resize(frames, 0.0);
            for input in &mut self.inputs {
                let take = frames.min(input.len());
                let silence = take.min(input.silence);
                input.silence -= silence;
                let samples = input.queue.drain(..take - silence);
                for (mixed, sample) in self.scratch[silence..].iter_mut().zip(samples) {
                    *mixed += sample;
                }
            }
            emit(&self.scratch)?;
            ready -= frames;
        }
        Ok(())
    }

    /// Once every stream has started or finished, gives each one the leading silence that puts
    /// it at its offset from the earliest start. Returns whether that has happened.
    fn align(&mut self) -> bool {
        if self.aligned {
            return true;
        }
        let all_known = self
            .inputs
            .iter()
            .all(|input| input.first_timestamp.is_some() || input.finished);
        if !all_known {
            return false;
        }
        let first_timestamps: Vec<Option<i64>> = self
            .inputs
            .iter()
            .map(|input| input.first_timestamp)
            .collect();
        let silences = leading_silence_frames(&first_timestamps, RECORDING_SAMPLE_RATE);
        for (input, silence) in self.inputs.iter_mut().zip(silences) {
            input.silence = silence;
        }
        self.aligned = true;
        true
    }

    fn ready_frames(&self) -> usize {
        let unfinished = self
            .inputs
            .iter()
            .filter(|input| !input.finished)
            .map(MixerInput::len)
            .min();
        unfinished.unwrap_or_else(|| self.inputs.iter().map(MixerInput::len).max().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain_all(mixer: &mut StreamMixer) -> Vec<f32> {
        let mut out = Vec::new();
        mixer
            .drain(|chunk| {
                out.extend_from_slice(chunk);
                Ok::<(), ()>(())
            })
            .unwrap();
        out
    }

    /// A mixer whose streams all start at the same time.
    fn started(streams: usize) -> StreamMixer {
        let mut mixer = StreamMixer::new(streams);
        for stream in 0..streams {
            mixer.start(stream, 0);
        }
        mixer
    }

    /// Two hours in 100 ns units, a typical MPEG-TS start time.
    const TWO_HOURS: i64 = 2 * 60 * 60 * 10_000_000;
    /// One 16 kHz frame in 100 ns units.
    const FRAME: i64 = 10_000_000 / RECORDING_SAMPLE_RATE as i64;

    #[test]
    fn one_stream_passes_through() {
        let mut mixer = started(1);
        mixer.push(0, &[0.1, 0.2, 0.3]);
        assert_eq!(drain_all(&mut mixer), vec![0.1, 0.2, 0.3]);
        mixer.finish(0);
        assert!(drain_all(&mut mixer).is_empty());
    }

    #[test]
    fn waits_for_the_slower_stream_then_sums() {
        let mut mixer = started(2);
        mixer.push(0, &[0.25, 0.25, 0.25]);
        assert!(drain_all(&mut mixer).is_empty());

        mixer.push(1, &[0.5, 0.5]);
        assert_eq!(drain_all(&mut mixer), vec![0.75, 0.75]);

        mixer.push(1, &[0.5]);
        assert_eq!(drain_all(&mut mixer), vec![0.75]);
    }

    #[test]
    fn a_finished_stream_stops_holding_back_the_rest() {
        let mut mixer = started(2);
        mixer.push(0, &[0.1, 0.1, 0.1, 0.1]);
        mixer.push(1, &[0.2]);
        assert_eq!(drain_all(&mut mixer), vec![0.1 + 0.2]);

        mixer.finish(1);
        assert_eq!(drain_all(&mut mixer), vec![0.1, 0.1, 0.1]);
    }

    #[test]
    fn everything_left_is_mixed_once_all_streams_finish() {
        let mut mixer = started(2);
        mixer.push(0, &[0.1]);
        mixer.push(1, &[0.2, 0.2, 0.2]);
        mixer.finish(1);
        assert_eq!(drain_all(&mut mixer), vec![0.1 + 0.2]);
        mixer.finish(0);
        assert_eq!(drain_all(&mut mixer), vec![0.2, 0.2]);
    }

    #[test]
    fn emits_in_bounded_chunks() {
        let mut mixer = started(1);
        mixer.push(0, &[0.0; MIX_CHUNK_FRAMES * 2 + 5]);
        let mut chunks = Vec::new();
        mixer
            .drain(|chunk| {
                chunks.push(chunk.len());
                Ok::<(), ()>(())
            })
            .unwrap();
        assert_eq!(chunks, vec![MIX_CHUNK_FRAMES, MIX_CHUNK_FRAMES, 5]);
    }

    #[test]
    fn a_late_common_start_adds_no_silence() {
        let mut mixer = StreamMixer::new(2);
        mixer.start(0, TWO_HOURS);
        mixer.push(0, &[0.1, 0.1]);
        mixer.start(1, TWO_HOURS);
        mixer.push(1, &[0.2, 0.2]);
        assert_eq!(drain_all(&mut mixer), vec![0.1 + 0.2, 0.1 + 0.2]);
    }

    #[test]
    fn a_later_stream_is_delayed_by_its_offset_from_the_earliest() {
        let mut mixer = StreamMixer::new(2);
        mixer.start(0, TWO_HOURS + 2 * FRAME);
        mixer.push(0, &[0.5, 0.5]);
        mixer.start(1, TWO_HOURS);
        mixer.push(1, &[0.25, 0.25, 0.25, 0.25]);
        assert_eq!(drain_all(&mut mixer), vec![0.25, 0.25, 0.75, 0.75]);
    }

    #[test]
    fn nothing_is_emitted_until_every_stream_has_started_or_finished() {
        let mut mixer = StreamMixer::new(2);
        mixer.start(0, TWO_HOURS + FRAME);
        mixer.push(0, &[0.5]);
        mixer.finish(0);
        assert!(drain_all(&mut mixer).is_empty());

        mixer.start(1, TWO_HOURS);
        mixer.push(1, &[0.25]);
        mixer.finish(1);
        assert_eq!(drain_all(&mut mixer), vec![0.25, 0.5]);
    }

    #[test]
    fn a_stream_with_no_samples_does_not_set_the_start() {
        let mut mixer = StreamMixer::new(2);
        mixer.finish(0);
        mixer.start(1, TWO_HOURS);
        mixer.push(1, &[0.25]);
        assert_eq!(drain_all(&mut mixer), vec![0.25]);
    }
}
