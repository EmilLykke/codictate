# The hviske-v5-tiny Mirror

`syvai/hviske-v5-tiny` is the Danish ASR model Codictate offers. Its Hugging Face
repository is `gated: manual`, so the app cannot download the weights on a user's
behalf. The fix is a **Mirror**: a copy Codictate hosts itself.

The Mirror is live:

**https://huggingface.co/emillykkegrann/hviske-v5-tiny-GGUF**

All five Quantizations the source repo publishes are mirrored and verified. hviske is
wired into the app . All five Quantizations appear in the browse modal
("Browse more models" in Settings), none is marked `curated`, so a user who wants Danish
opens browse and picks their own size and speed trade-off.

`scripts/mirror-hviske.ts` is what created it, and it is what you re-run if the Mirror
ever has to be rebuilt or refreshed.

## Licence position

The model is plain **CC BY-NC 4.0**. The Hugging Face `cardData` carries no
`extra_gated_prompt` and no `extra_gated_fields`, so there is no additional agreement
attached to the gate. CC BY-NC 4.0 permits non-commercial redistribution with
attribution, and Codictate is free with no paid version and no commercial use, so the
mirror fits the licence.

This is not legal advice. syvai gated the repository deliberately, so ask them first
rather than relying on the licence alone. The message that was sent is at the bottom of
this document. The Mirror keeps attribution to syvai, a link back to the original repo,
and the unchanged CC BY-NC 4.0 licence, and the files themselves are byte-for-byte
copies.

## Contents

Byte sizes as published by the Hugging Face API:

| File | Bytes | Size |
| --- | --- | --- |
| `hviske-v5-tiny-f16.gguf` | 527156128 | 502.7 MiB |
| `hviske-v5-tiny-q8_0.gguf` | 281273056 | 268.2 MiB |
| `hviske-v5-tiny-q6_k.gguf` | 243307232 | 232.0 MiB |
| `hviske-v5-tiny-q5_0.gguf` | 190292704 | 181.5 MiB |
| `hviske-v5-tiny-q4_k.gguf` | 159965920 | 152.5 MiB |

The five files total 1401995040 bytes, roughly 1.3 GiB, so a full mirroring run is not a
quick download.
Each Quantization is a separate Speech Model with its own Model ID in
`src/shared/speech-models.ts`.

## Which Quantization to recommend

**`f16`**, and the recommendation is a judgement rather than a measurement.

syvai's model card claims an identical Danish WER of **10.51 for all five
Quantizations**. Codictate has not verified that independently, and it is an unusual
claim: an identical error rate from full precision `f16` down to `q4_k` is not what
quantization normally does. `f16` is full precision and the source repo's own primary,
so it is the Quantization least likely to be the one where that claim breaks down. That
is the whole reason it is recommended over the much smaller `q4_k`. State the caveat
wherever the recommendation is made.

syvai publishes speed figures for two of the five only: roughly 39x realtime for `f16`
and roughly 56x realtime for `q4_k`, both on an M4. The three in between have no
published numbers, and Codictate has measured none of them. Danish WER is unmeasured by
Codictate for every Quantization, so no hviske entry should be marked `curated` until
that changes.

## Runtime constraint

These GGUFs load only under crispasr's `cohere` backend (`--backend cohere`).
whisper.cpp and llama.cpp cannot read them at all, which is why hviske is only possible
now that crispasr is the ASR Harness. See
[docs/adr/0002-asr-harness-abstraction.md](adr/0002-asr-harness-abstraction.md).

**Windows: backend confirmed, end-to-end run still missing.** The `cohere` backend is
compiled into the Windows binary Codictate actually ships. That was checked against the
pinned artifact: `crispasr-windows-x86_64-vulkan.zip` from CrispASR v0.8.29, sha256
matching the pin in `scripts/vendor-manifest.ts`, then inspected for strings and symbols
in `crispasr.exe` and `crispasr.dll`. Its `--backend` help lists `cohere` as an accepted
value, `--no-punctuation` documents itself as applying to `(canary, cohere)`, and the
implementation symbols are present (`CohereBackend`, `cohere_transcribe_ex`,
`cohere_context`, `cohere_build_graph_decoder`, `llm_build_cohere2_iswa`).

What is still unverified is one specific thing: **no hviske Dictation has been run on
Windows hardware.** An hviske GGUF has never been loaded and transcribed there, so Vulkan
device selection and output quality are unobserved. Anyone with a Windows machine can
close that gap with a single Danish Dictation on an hviske Speech Model.

The weights are Danish-only, so an hviske run pins the Transcription Language to Danish
rather than taking the user's setting. Translate to English is not refused: it resolves
away to a translate-capable Whisper Speech Model, which inherits neither the `cohere`
backend nor the Danish pin.

## Re-running the mirror script

```bash
# HF_TOKEN needs read access and an approved gate request on the source repo.
export HF_TOKEN=hf_...
# HF_WRITE_TOKEN needs write access to your own destination repo.
export HF_WRITE_TOKEN=hf_...

bun run scripts/mirror-hviske.ts --print-readme   # review the model card
bun run scripts/mirror-hviske.ts --dry-run        # download and stage, upload nothing
bun run scripts/mirror-hviske.ts                  # create the repo and upload
```