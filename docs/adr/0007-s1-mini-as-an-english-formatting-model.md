# S1-mini is an English Formatting Model with coverage beyond app presets

S1-mini by Superwhisper will be selectable alongside Qwen in the Formatting Model picker on macOS and Windows. The purpose is everyday cleanup of dictated prompts, including destinations outside the existing app presets. It replaces the selected Qwen model for that use; it is not an additional model pass before Qwen.

Only English transcripts are eligible. Ineligible transcripts remain unformatted rather than switching to another Formatting Model. Controls unsupported by S1-mini become unavailable while it is selected, and saved Qwen settings survive switching models.

This keeps model selection separate from the requested writing behaviour. Reusing Qwen's arbitrary instructions and JSON output contract would conceal real capability differences: S1-mini requires its documented normalization protocol. See the [upstream model documentation](https://huggingface.co/superwhisper/s1-mini-GGUF).

## Behaviour

With S1-mini selected and formatting enabled, every completed Batch Dictation receives English cleanup, regardless of the destination app. The general default is standard written English with contractions retained and automatic list formatting. Structure always uses `lists`, allowing bullets for clear enumerations of at least three items and prose otherwise. Users can choose the model's supported writing styles; matching enabled app presets refine the supported settings. An unmatched app uses the general settings. Turning formatting off disables S1-mini, including when a forced preset is saved.

Live Transcription is excluded. It inserts text while the user speaks, and rewriting already-inserted text would require a separate interaction design and native protocol change.

There is no latency acceptance target for this release. Users opt into the model and decide whether its speed and output suit them. Runtime correctness and resource safety still require validation; a small download is not a measured memory budget.

## Implementation requirements

- Offer an optional in-app model download and preserve the existing Qwen selections and settings.
- Give S1-mini its documented prompt and plain-text result contract rather than Qwen's JSON schema contract.
- Determine English eligibility for automatic-language transcription as well as explicit language settings. Preserve the transcript when language is non-English or uncertain; do not substitute a model. Language detection is imperfect, especially for short or mixed-language text.
- Treat successful empty cleanup as no text to paste, distinct from inference failure. Preserve the transcript on runtime failure, consistent with ADR-0006.
- Retain the upstream model name and distribution notices.
- Validate real inference with the pinned runtime on macOS and Windows. The opt-in `s1-inference.manual.ts` suite exercises the same runner on either platform.

The desktop implementation uses TinyLD for automatic-language eligibility and the existing bundled llama-completion runtime for generation. Real inference passed on macOS for spoken email addresses, numeric corrections and filler-only input. Windows hardware validation remains outstanding.
