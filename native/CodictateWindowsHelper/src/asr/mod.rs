//! Windows ASR backends.

use std::process::ExitCode;

pub mod parakeet;

pub fn handle_transcribe(args: &[String]) -> ExitCode {
    parakeet::handle_transcribe(args)
}

pub fn handle_stream(args: &[String]) -> ExitCode {
    parakeet::handle_stream(args)
}
