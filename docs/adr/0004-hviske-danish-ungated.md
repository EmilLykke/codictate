# Danish hviske ships ungated from a Codictate-hosted Mirror, with all five Quantizations reachable through browse only

`syvai/hviske-v5-tiny` is the Danish ASR model Codictate wanted to offer, and its Hugging Face repository is `gated: manual`, so the app could never download it on a user's behalf. Codictate now hosts a **Mirror** of the GGUF weights at [`emillykkegrann/hviske-v5-tiny-GGUF`](https://huggingface.co/emillykkegrann/hviske-v5-tiny-GGUF), published and verified, carrying all five Quantizations the source repo publishes.

hviske was behind two gates while the Mirror did not exist: a `CODICTATE_ENABLE_HVISKE` env var and a source-checkout requirement. Both are deleted. hviske is a normal Speech Engine now, with no dev-only conditions, and every one of its five Quantizations is reachable from the browse modal ("Browse more models" in Settings). None of them is marked `curated`, so none appears in the main Settings model list; a user who wants Danish opens browse and picks their own size and speed trade-off. `f16` is the one this documentation recommends, and that recommendation deliberately lives in prose rather than in a `curated` flag. The reason is in Considered Options below.

## Considered Options

- **Keep the env var and source-checkout gate until Codictate has its own Danish WER numbers.** Safest sounding, and the worst option in practice: the gate meant no ordinary user could reach Danish at all, so the app collected no field signal on the one language the whole crispasr switch was motivated by, while the measurement the gate was waiting for was not actually scheduled. A gate that waits on unscheduled work is a permanent gate.
- **Curate one Quantization into the main Settings list.** Rejected because `curated` is a promise that a default was measured, and Codictate has measured nothing here. The only accuracy claim available is syvai's, and it is an unusual one (see below), so promoting any single Quantization into the main list would encode a claim we have not checked. Browse is the honest surface for a set of options none of which we have ranked ourselves.
- **Mirror only `f16` and offer nothing else.** Rejected. 502.7 MiB is a large download for a tiny model, and the size spread across the five files is more than 3x, which is exactly the kind of trade-off a user on a constrained machine should be allowed to make. The source repo publishes all five under one licence, so mirroring the full set costs nothing beyond bytes.
- **Publish the Mirror and ship all five ungated through browse (chosen).** Danish becomes reachable by any user, the trade-off is theirs, and the recommendation is stated where a caveat can be stated with it.

## The Mirror contents

Five files, byte sizes as published:

| File | Bytes | Size |
| --- | --- | --- |
| `hviske-v5-tiny-f16.gguf` | 527156128 | 502.7 MiB |
| `hviske-v5-tiny-q8_0.gguf` | 281273056 | 268.2 MiB |
| `hviske-v5-tiny-q6_k.gguf` | 243307232 | 232.0 MiB |
| `hviske-v5-tiny-q5_0.gguf` | 190292704 | 181.5 MiB |
| `hviske-v5-tiny-q4_k.gguf` | 159965920 | 152.5 MiB |

Each Quantization is a separate Speech Model with its own Model ID in `src/shared/speech-models.ts`.

## Why f16 is the recommended Quantization

syvai's model card claims an **identical Danish WER of 10.51 for all five Quantizations**. Codictate has not verified that independently, and the claim is unusual on its face: an identical error rate from full precision `f16` all the way down to `q4_k` is not what quantization normally does. It may be correct, it may be a single number copied across five rows on a model card, and we have no measurement of our own that would tell the difference.

`f16` is therefore the recommended one: it is full precision and it is the source repo's own primary, so it is the Quantization that carries the least risk of being the one where the equal-WER claim breaks down. Anyone recommending a smaller Quantization is trading on an unverified claim, and should say so. Anywhere Codictate recommends an hviske Quantization, in docs or in UI copy, that caveat travels with the recommendation.

## Runtime constraint

These GGUFs load only under crispasr's `cohere` backend (`--backend cohere`). whisper.cpp and llama.cpp cannot read them at all. hviske is therefore only possible because crispasr is the ASR Harness, and it is the concrete payoff of that switch. See `docs/adr/0002-asr-harness-abstraction.md`.

## Consequences

- hviske is its own Speech Engine id rather than another Whisper Speech Model, because its weights, its backend flag and its language support all differ from a whisper.cpp model. Engine stays distinct from ASR Harness: hviske runs on the same crispasr Harness as Whisper, with a different `--backend`.
- The weights are Danish-only, so an hviske run pins the Transcription Language to Danish rather than taking the user's setting, which may be auto or another language entirely.
- Translate to English is not refused on an hviske selection; it resolves away to a translate-capable Whisper Speech Model instead. Backend and language follow the Speech Model that actually runs, so a translate run inherits neither `--backend cohere` nor the Danish pin.
- An hviske Speech Model can be selected in AppConfig after its weights have been deleted, since the two are independent. Such a run falls back to the default Speech Model, which means a transcript in the wrong language rather than a failed Dictation.
- Retiring or replacing crispasr would take Danish with it. hviske support is downstream of the Harness decision, not independent of it.
- Codictate is now a redistribution host. The Mirror is plain CC BY-NC 4.0 with attribution to syvai, matching the source licence, and `docs/HVISKE_MIRROR.md` records the licence position and the message sent to syvai. If syvai ever objects, the Danish Speech Models stop being downloadable, so the Mirror is an ongoing relationship rather than a one-off copy.
- Re-running or refreshing the Mirror needs a Hugging Face write token, so `scripts/mirror-hviske.ts` is run by a human and never by an agent.
- **The `cohere` backend is confirmed present in the Windows build Codictate ships.** Verified against the pinned artifact itself: `crispasr-windows-x86_64-vulkan.zip` from CrispASR v0.8.29, sha256 matching the pin in `scripts/vendor-manifest.ts` exactly, then inspected for strings and symbols in `crispasr.exe` and `crispasr.dll`. The binary's own `--backend` help lists `cohere` among its accepted values (`whisper|parakeet|canary|cohere|qwen3|qwen3-1.7b|mega-asr|voxtral|voxtral4b|granite`), and it carries real implementation symbols rather than just the name in a list: a `CohereBackend` class symbol, `cohere_transcribe_ex`, `cohere_context`, `cohere_build_graph_decoder`, and the model graph builder `llm_build_cohere2_iswa`. `--no-punctuation` documents itself as applying to `(canary, cohere)`, which is not how a stub would be documented. A future reader can re-check this the same way against the same pinned asset.
- **Still unverified on Windows: no hviske Dictation has been run on Windows hardware.** The backend is present and accepts the flag; what nobody has observed is the end-to-end path, an hviske GGUF actually loading and transcribing on a real Windows machine, including Vulkan device selection and output quality. That is why `README.md` marks the Windows column untested rather than giving it a support tick. Building for both platforms in the same change is what parity requires; it does not license claiming a run nobody has made.
- Danish WER is still unmeasured by Codictate, for every Quantization. `da_dk` was not part of the Harness comparison Benchmark Run either. Until that gap is closed, no hviske Quantization should be marked `curated`, and the recommendation stays a documented judgement rather than a measured default.
