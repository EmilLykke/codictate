# Whisper gains a second ASR Harness (crispasr), proven in the benchmark before it reaches users

Whisper transcription was hardwired to the `whisper-cli` binary. We are introducing `crispasr` (a whisper.cpp fork that also runs Cohere ASR and Parakeet backends from a single prebuilt binary) as an alternative ASR Harness for the same Whisper Speech Engine, selectable in the benchmark harness and behind a dev-only flag in the app, but not user-selectable. Whether it replaces `whisper-cli` is decided by measured WER and RTF, not by preference.

The immediate motive is Danish accuracy: `syvai/hviske-v5-tiny` only runs under crispasr's `cohere` backend, and no whisper.cpp or llama.cpp build can load it. The secondary motive is that upstream whisper.cpp publishes no macOS CLI binary while crispasr does, so adopting it would remove the last source build from macOS dev setup.

## Considered Options

- **Add crispasr only for hviske, keep whisper-cli for Whisper.** Two ASR binaries forever, and no evidence either way about which is better.
- **Replace whisper-cli outright.** Verified as a drop-in: prebuilt `crispasr` (single arm64 binary, 16 MB) ran the existing `ggml-large-v3-turbo-q5_0.bin` with Codictate's exact flag set (`-m -t --language -f --no-prints -nt`), exit 0, identical stdout shape. But it moves the shipping transcription path onto a fast-moving v0.8.x project with essentially one maintainer, on faith.
- **Implement both, decide by benchmark (chosen).** Harness becomes a benchmark dimension, so the question is answered with WER and RTF numbers on real hardware.

## Consequences

- Harness is a first-class dimension in benchmark results: `librispeech[dataset][harness][modelId]`. Existing result files predate this and are read as `whisper-cli` at load time.
- "Already benchmarked" is a property of a (Harness, Model, dataset, language) Combination, not of a Model.
- No user-facing engine or harness picker is added. If crispasr loses, nothing user-visible has to be walked back.
- `-tr` (translate to English) is accepted by crispasr but was not confirmed equivalent to `whisper-cli`; it must be verified on the Small and Large models before crispasr could take over the shipping path.
