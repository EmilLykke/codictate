# Output formatting

Formatting rewrites a completed Batch Dictation before Codictate pastes it. Live Transcription bypasses formatting.

## Models

Settings offers Qwen2.5 3B, Qwen3 4B, and **S1-mini by Superwhisper**. Each is an optional local download. Selecting S1-mini replaces Qwen for cleanup; it does not add a second model pass. Existing Qwen settings remain saved when switching models.

S1-mini uses the Q4_K_M weights, approximately 484 MB (462 MiB). Its download URL is pinned to an upstream revision and verified by SHA-256. Models stay in Codictate's application-data models directory.

## S1-mini behaviour

Turn formatting on with S1-mini selected to clean completed English dictation in any destination app. The general default is standard written English with contractions retained and automatic list formatting. General controls offer the model's four writing styles. Structure always uses `lists`: clear enumerations of at least three items may become bullets, while ordinary dictation stays in prose. There is no structure selector. Matching enabled Email, Messages, Slack and Document presets adjust the supported controls; a forced preset applies its supported style across apps. Turning formatting off disables S1-mini even with a forced preset selected.

S1-mini cannot implement Qwen's arbitrary instructions. Unsupported controls are disabled while it is selected. Email mode requests the model's email layout rather than inventing custom greetings or signatures.

An explicit non-English transcription language skips S1-mini. Translate to English makes the output eligible. Automatic-language transcription, including Parakeet, requires conservative text-language detection; short, non-English or uncertain text stays unchanged. Detection is imperfect, especially for mixed-language text. Codictate never switches to another model for these cases.

A successful empty result, such as cleanup of filler-only speech, means nothing is pasted. A runtime failure preserves the transcript. There is no promised latency: users can try the model and decide whether its output and speed suit them.

## Runtime contract

S1-mini has a separate plain-text runner. Qwen retains its constrained JSON runner. S1-mini uses the exact trained system prompt, control line and empty thinking prefix with greedy decoding. Bounded chunks limit context use; a missing completion marker or failed chunk rejects the rewrite rather than pasting partial output.

The pinned llama-completion runtime strips a trailing newline from ordinary prompt files. S1-mini therefore uses binary-file input with escape processing disabled, preserving both required newlines after the thinking block. Its output must end with the runtime's EOS marker. Do not add `--log-disable`: this runtime also suppresses generated stdout with that option.

Upstream model documentation: https://huggingface.co/superwhisper/s1-mini-GGUF

Model license and attribution: `docs/licenses/s1-mini/`, copied into the app as `licenses/s1-mini/`.

## Verification

Pure protocol and routing tests run in the hermetic test suite. Real inference is opt-in and requires the pinned model already downloaded:

```sh
CODICTATE_S1_MODEL_PATH=/absolute/path/s1-mini-q4_k_m.gguf bun test ./src/bun/utils/formatting/s1-inference.manual.ts
```

Run this on both macOS and Windows to exercise each platform's bundled runtime. It covers spoken email addresses, a numeric self-correction and valid empty output. An absent environment variable skips these manual tests.
