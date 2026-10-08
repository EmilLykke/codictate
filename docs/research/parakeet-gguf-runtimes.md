# Parakeet on GGUF runtimes: crispasr, parakeet.cpp, and the current native helpers

Research note, 2026-10-08. Facts, measurements and trade-offs only. No decision is made here.

Questions:

1. What is `cstr/parakeet-tdt-0.6b-v3-GGUF`, and can crispasr (pinned v0.8.29, latest v0.8.41) run it?
2. Can any crispasr version run `RyeAI/ekko-v1-tiny`?
3. How does the current Parakeet path (FluidAudio on macOS, parakeet-rs on Windows) compare with crispasr and parakeet.cpp for `parakeet-tdt-0.6b-v3`?

Every number is labelled **measured** (run on this Mac for this note) or **documented** (taken from the cited source).

## Short answers

- **Q1.** `cstr/parakeet-tdt-0.6b-v3-GGUF` holds CrispASR's own GGUF conversions of `nvidia/parakeet-tdt-0.6b-v3`: F16, Q8_0, Q5_0 and Q4_K, all CC-BY-4.0. Its Q4_K file is what `crispasr --backend parakeet -m auto` downloads. **Both v0.8.29 and v0.8.41 run it** with `--backend parakeet` on Metal, and the transcripts are correct (measured). crispasr's `parakeet` backend decodes TDT and RNN-T, plus CTC on hybrid models. It reports native timestamps, word timestamps and native punctuation. Its backend table marks it **not** natively streaming. It does support crispasr's generic sliding-window `--stream`/`--live` mode (measured working).
- **Q2.** **No.** crispasr cannot run ekko-v1-tiny on any version or with any conversion I could find. RyeAI's parakeet.cpp-format GGUF is misread as a pure-CTC model and fails on both versions (measured). Converting the `.nemo` with crispasr's converter at `main` (13efa5c, 2026-10-08) still yields a GGUF without BatchNorm running stats. v0.8.29 then fails, and v0.8.41 prints garbage ("er", "det er af", "aften") (measured). The cause is in the source: the parakeet runtime only implements a BatchNorm conv module, and ekko uses `conv_norm_type = layer_norm`. `src/parakeet.cpp` at `main` is byte-identical to v0.8.41. No crispasr-format ekko GGUF exists on Hugging Face. **parakeet.cpp is still the only GGUF runtime that runs ekko.**
- **Q3.** The trade-offs are spelled out below. In short:
  - **Accuracy:** the GGUF runtimes beat FluidAudio's 6-bit palettized CoreML model on Hungarian and Spanish, match it on Danish, and match it on English once ITN is excluded.
  - **Speed:** FluidAudio (ANE) is fastest on whole clips. parakeet.cpp (Metal) has the lowest latency on the short buffers that Live Transcription re-decodes.
  - **Memory:** both GGUF runtimes use far more process RAM.
  - **Streaming:** no runtime streams TDT-0.6b-v3 natively. It is an offline model in all three. Codictate's Live Transcription already works by re-decoding a growing buffer, and all three runtimes can serve that from a persistent process.

## How Codictate runs Parakeet today (from the code)

- **macOS:** `native/CodictateParakeetHelper` (Swift) uses FluidAudio 0.13.6 (`Package.resolved`, revision `57551cd`) with `AsrModels.load(..., version: .v3)`. The model is `FluidInference/parakeet-tdt-0.6b-v3-coreml`: four `.mlmodelc` bundles, 461 MiB on disk. Its metadata says `storagePrecision: Mixed (Float16, Palettized (6 bits))`.
- **ITN on macOS:** `transcribe` and `transcribe-session` run NeMo ITN on the output (`NemoTextProcessing.normalizeSentence`, text-processing-rs). It is called with no language, so English rules apply to every language. Live mode skips ITN.
- **Windows:** `native/CodictateWindowsHelper` (Rust) uses parakeet-rs 0.3.5 with `ExecutionProvider::DirectML`, and falls back to CPU if DirectML fails to load (`src/asr/parakeet.rs`). The model is the fp32 `istupakov/parakeet-tdt-0.6b-v3-onnx`, whose required files total about 2.55 GB. There is no ITN on Windows.
- **Live Transcription is not true streaming on either platform.** Both helpers re-run the offline TDT model on the whole open utterance:
  - The first partial needs at least 1 s of audio, then a new partial is decoded after every ~300 ms of new audio.
  - An utterance is committed after 1.5 s of silence or when it reaches 20 s.
  - Source: `runLiveMode` in `CodictateParakeetHelper.swift`, with the same shape in `parakeet.rs`.
- **What a replacement runtime must provide for live mode:** fast decodes of 1 to 20 s buffers from a model that stays loaded. A cache-aware streaming API is not required.

## Method (measured)

**Machine:** Apple M4 Max (Mac16,5), 14 cores, 36 GB, macOS 26.6.2.

**Corpus (160 clips, 1709 s of audio):**
- FLEURS `da_dk`, `es_419` and `hu_hu` from `benchmarks/datasets/fleurs`: the first 40 unique sentence ids per language, first wav per id. These are 16 kHz Float32 WAVs, with 825, 1045 and 714 reference words.
- English: the first 40 LibriSpeech `test-clean` utterances in sorted id order from `benchmarks/datasets/librispeech/wav/test-clean`, 743 words.
- Resolution: one word error moves WER by about 0.10 to 0.14 pp per language.

**Scoring:**
- References are the raw FLEURS transcript or the LibriSpeech transcript.
- Both sides are NFKC-normalised, lowercased, have hyphens split, punctuation stripped, and are scored as word-level Levenshtein.
- Each configuration was run once. These are small samples, so treat a difference of a few words as noise.

**Systems:**

| Label | Runtime | Model file |
| --- | --- | --- |
| `fluid` | Codictate's vendored `CodictateParakeetHelper transcribe-session` (FluidAudio 0.13.6, ANE). Output includes ITN. | CoreML v3, 461 MiB, copied to /tmp so the app's model dir was not touched |
| `fluid-raw` | A 20-line throwaway Swift tool against FluidAudio 0.13.6 (exact pin). Same `AsrModels.load` and `AsrManager.transcribe` calls as the helper, minus ITN. It gives the raw engine output. | same |
| `crisp41-*` / `crisp29-*` | crispasr v0.8.41 / v0.8.29 macOS prebuilt release, Metal | `cstr/parakeet-tdt-0.6b-v3-GGUF` q4_k 418 MB, q8_0 674 MB, f16 1255 MB |
| `pcpp-*` | parakeet.cpp v0.6.1 `parakeet-v0.6.1-bin-macos-metal-arm64`, Metal | `mudler/parakeet-cpp-gguf` `tdt-0.6b-v3` q4_k 675 MB, q8_0 941 MB, f16 1441 MB |

**Commands:**
- crispasr: `crispasr --backend parakeet -m <gguf> -t 8 -f <wav> -nt --no-prints --lid-backend off`
- parakeet.cpp: `parakeet-cli transcribe --model <gguf> --input <wav> --threads 8`

**Modes:**
- **CLI:** one process per clip under `/usr/bin/time -l`. Wall time includes model load. RSS is the per-process maximum.
- **Warm:** one persistent process, timed per request.
  - FluidAudio: `transcribe-session` over stdin.
  - crispasr: `--server`, `POST /v1/audio/transcriptions`.
  - parakeet.cpp: `parakeet-server`, same endpoint.
  - Two warm-up requests come first. HTTP and WAV upload are included in the server timings.
- **Live-mode proxy:** warm decode latency on prefixes (1, 2, 3, 5, 8, 10, 15, 20 and 30 s) of concatenated LibriSpeech audio. Each prefix was decoded 5 times and the median is reported.

## Results

### Accuracy, WER (measured)

| System | English (LS clean) | Danish | Spanish | Hungarian | 3 FLEURS langs pooled |
| --- | --- | --- | --- | --- | --- |
| fluid (as shipped, with ITN) | 1.75% | 19.27% | 3.83% | 18.91% | 12.93% |
| fluid-raw (no ITN) | 0.54% | 19.27% | 3.83% | 18.91% | 12.93% |
| crisp29 q4_k | 0.40% | 21.58% | 2.97% | 19.05% | 13.35% |
| crisp29 q8_0 | 0.67% | 19.03% | 2.87% | 16.25% | 11.73% |
| crisp41 q4_k | 0.54% | 21.58% | 3.06% | 18.49% | 13.24% |
| crisp41 q8_0 | 0.67% | 19.88% | 2.97% | 15.55% | 11.84% |
| crisp41 f16 | 0.67% | 19.52% | 2.97% | 15.13% | 11.61% |
| pcpp q4_k | 0.54% | 19.64% | 2.87% | 17.79% | 12.35% |
| pcpp q8_0 | 0.67% | 19.27% | 2.97% | 14.99% | 11.49% |
| pcpp f16 | 0.67% | 19.15% | 2.97% | 15.13% | 11.49% |

What the table shows:
- **ITN only affected English** on these clips. "number ten" became "number 10", "first" became "1st", and "saint" became "st". That cost +9 errors, 0.54% to 1.75%. The macOS helper's transcript, which ADR-0006 calls the Raw Transcript, is therefore post-ITN.
- **Hungarian and Spanish:** FluidAudio's CoreML model makes 135 and 40 errors, against 107 to 116 and 30 to 31 for the GGUF q8_0/f16 files.
- **Code-switching:** in at least one Spanish clip FluidAudio switched into English ("proteger the fronteras de Irak de operations hostiles andar ..."), while both GGUF runtimes transcribed it correctly. The CoreML encoder's 6-bit palettization may explain this, but I have not verified that.
- **Danish** is within about 20 words across everything except crispasr q4_k (178 errors against 157 to 164).
- **Quantization:** crispasr q4_k is the weakest GGUF quant (418 MB). mudler's q4_k is 675 MB, likely because more tensors stay at higher precision, and scores closer to its f16.
- **v0.8.29 and v0.8.41 agree** to within a few words at each quant.

### Speed (measured)

| System | CLI per clip, median (incl. load) | CLI RTF | Warm per clip, median | Warm RTF | Warm-server ready time |
| --- | --- | --- | --- | --- | --- |
| fluid-raw / fluid | n/a (session) | n/a | 66 ms | 0.0072 | 0.10 to 0.19 s load, cached |
| crisp41 q4_k | 279 ms | 0.028 | 104 ms | 0.0101 | 0.64 s (incl. warmup) |
| crisp41 q8_0 | 303 ms | 0.029 | 100 ms | 0.0099 | 0.63 s |
| crisp41 f16 | 379 ms | 0.037 | 103 ms | 0.0099 | 0.89 s |
| crisp29 q4_k | 266 ms | 0.026 | 96 ms | 0.0094 | 0.57 s |
| pcpp q4_k | 280 ms | 0.027 | 83 ms | 0.0081 | 0.40 s |
| pcpp q8_0 | 323 ms | 0.031 | 82 ms | 0.0079 | 0.38 s |
| pcpp f16 | 416 ms | 0.040 | 81 ms | 0.0079 | 0.50 s |
| crisp41 q8_0, CPU only (`--gpu-backend cpu`) | n/a | n/a | 216 ms | 0.0210 | 0.36 s |
| pcpp q8_0, CPU only (`PARAKEET_DEVICE=cpu`) | n/a | n/a | 230 ms | 0.0225 | 0.23 s |

**Cold start (measured):**
- **First load ever:** FluidAudio's first `transcribe-session` from a new model path took **51.4 s**, while CoreML compiled the model for this Mac. The throwaway tool's first load from that same path took 15.9 s. Every later load took 0.10 to 0.19 s. The helper warns about this in its own log ("first run may prepare model assets ... can take a few minutes").
- **First run of a new binary:** a freshly extracted GGUF binary took 7 to 15 s on its first run (crispasr v0.8.29 8.0 s, v0.8.41 15.0 s, parakeet-cli 7.4 s). The second run took about 0.25 s. I did not isolate the cause; it is likely first-launch checks of a new unsigned binary plus Metal pipeline setup. The app ships signed binaries, so this first-run cost may not carry over.
- **Model file not in page cache:** simulated with APFS clones, which have no cached pages. crispasr q4_k ran in 0.40 to 0.42 s and parakeet-cli q4_k in 0.30 to 0.36 s. With crispasr's Metal pipeline cache skipped as well (`CRISPASR_METAL_PIPELINE_CACHE_MAX_MB=1`) it was 0.25 s.

### Live Transcription proxy: warm decode latency per buffer length, median ms (measured)

| System | 1 s | 2 s | 3 s | 5 s | 8 s | 10 s | 15 s | 20 s | 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fluid-raw (ANE) | 61 | 53 | 53 | 56 | 62 | 67 | 76 | 138 | 205 |
| crisp41 q8_0 (Metal) | 49 | 54 | 61 | 72 | 91 | 101 | 129 | 159 | 221 |
| crisp29 q4_k (Metal) | 45 | 52 | 57 | 66 | 84 | 95 | 124 | 156 | 222 |
| pcpp q8_0 (Metal) | 25 | 34 | 40 | 51 | 70 | 84 | 116 | 153 | 231 |
| crisp41 q8_0 (CPU) | 32 | 51 | 69 | 108 | 168 | 212 | 315 | 427 | 667 |
| pcpp q8_0 (CPU) | 27 | 50 | 70 | 112 | 179 | 227 | 341 | 471 | 703 |

**What this means for live mode:**
- Codictate re-decodes every ~300 ms of new audio, with utterances capped at 20 s. On Metal, every runtime decodes faster than that budget at every length up to 20 s.
- On CPU only, decodes exceed 300 ms from about 15 s of buffer upward. That is relevant to Windows machines without a usable GPU, but it was measured on Apple CPU cores, not x86.
- Not measured: GPU contention with the Formatting Backend. `llama-completion` also runs on Metal, while FluidAudio runs on the ANE.

### Memory (measured, `/usr/bin/time -l`)

| System | Peak RSS, CLI (median) | Peak RSS, warm server/session |
| --- | --- | --- |
| fluid / fluid-raw | n/a | 95 MB, footprint 47 MB; 512 MB on the first (compiling) load |
| crisp41 q4_k / q8_0 / f16 | 679 / 953 / 1585 MB | 749 / 1035 / 1689 MB |
| crisp29 q4_k / q8_0 | 657 / 928 MB | 725 MB (q4_k) |
| pcpp q4_k / q8_0 / f16 | 1330 / 1836 / 2791 MB | 1395 / 1926 / 2926 MB |
| crisp41 q8_0 CPU / pcpp q8_0 CPU | n/a | 1314 / 1388 MB |

**Caveat:** FluidAudio's process RSS probably does not include memory CoreML/ANE holds outside the process. Its 95 MB is not directly comparable to the GGUF numbers. The app's own label is "80 MB RAM" (`src/shared/speech-models.ts`).

### Sizes

| Item | macOS arm64 | Windows x64 |
| --- | --- | --- |
| Current helper | `CodictateParakeetHelper` 6.5 MB, ITN statically linked (measured) | `CodictateWindowsHelper` plus ONNX Runtime/DirectML (not measured) |
| Current model download | CoreML, 461 MiB on disk (measured); app label says 500 MB | fp32 ONNX, about 2.55 GB of required files (documented, HF API sizes) |
| crispasr v0.8.41 | `crispasr` 21.8 MB + `libc2pa_c.dylib` 17.9 MB (measured), already vendored for Whisper/hviske | `vulkan.zip` 38.7 MB, `cpu.zip` 8.9 MB, `cpu-legacy.zip` 8.4 MB (documented, release assets) |
| crispasr v0.8.29 (pinned) | 18.6 MB + 17.9 MB (measured) | `vulkan.zip` 34.2 MB (documented) |
| parakeet.cpp v0.6.1 | `parakeet-cli` 3.6 MB, `parakeet-server` 3.3 MB, system frameworks only (measured) | `win-vulkan` zip 36.2 MB, `win-cpu` zip 1.8 MB (documented); issue #68 reports the exe sizes as 60 MB and 2.4 MB |
| GGUF models | cstr: 418 / 674 / 1255 MB (q4_k / q8_0 / f16). mudler: 675 / 941 / 1441 MB (q4_k / q8_0 / f16); q6_k (813 MB) and q5_k (742 MB) also exist | same files |

### GGUF format compatibility (measured)

- **crispasr and parakeet.cpp GGUFs are mutually incompatible.**
  - crispasr v0.8.41 given mudler's `tdt-0.6b-v3-q4_k.gguf` auto-routes it to `fastconformer-ctc`, then fails with `compute_logits failed`.
  - parakeet.cpp given cstr's q4_k fails with `failed to load model`.
- **Using one runtime for both models:** each runtime needs its own conversions. Only parakeet.cpp can load both TDT-0.6b-v3 and ekko.

## Feature comparison

| | FluidAudio helper (macOS) | parakeet-rs helper (Windows) | crispasr | parakeet.cpp |
| --- | --- | --- | --- | --- |
| Native streaming for TDT-0.6b-v3 | No (offline model). FluidAudio ships `SlidingWindowAsrManager`; Codictate does not use it | No | No (`streaming` column is `-` for `parakeet` in `--list-backends`) | No. `--stream` refuses: "requires a cache-aware streaming model" (measured) |
| Re-decode or sliding-window live mode | Yes, Codictate's own loop | Yes, Codictate's own loop | Built-in `--stream` / `--mic` / `--live`, JSON `partial`/`final` events, WebSocket in server mode (`docs/streaming.md`). Measured working with `--backend parakeet`: partials every 500 ms | Not built in for TDT. A persistent process is needed: `parakeet-server` (README: "one model, one request at a time, WAV only ... treat it as an example") or the C API (`libparakeet`, ABI 10) |
| True streaming models available | Parakeet EOU 120M (English), Nemotron streaming (documented, FluidAudio README) | n/a | `nemotron` backend has `streaming = Y` | `parakeet_realtime_eou_120m-v1` (English) and `nemotron-3.5-asr-streaming-0.6b` (40+ locales, OpenMDW-1.1) via `--stream` (documented) |
| Punctuation and capitalization | Model-native (measured) | Model-native | Model-native (measured) | Model-native (measured) |
| ITN | Yes, English rules on every language | No | No ITN flag found in `--help` | None documented |
| Timestamps | Not used | Sentences mode used internally | Native TDT word timestamps | `--timestamps` / `--json`, word and token |
| Languages | 25 European (same model) | 25 | 25 | 25 |
| Windows GPU | n/a | DirectML, CPU fallback | Vulkan, CUDA 12/12.6/13, CPU (AVX2+FMA) and CPU-legacy prebuilts | Vulkan, CUDA, CPU prebuilts. GPU backends are not exercised in CI (README Limits) |
| Language ID | Not needed | Not needed | Without `-l`, crispasr runs a whisper-tiny LID pass and auto-downloads `ggml-tiny.bin` (77 MB) to `~/.cache/crispasr`. `--lid-backend off` disables it. Output text was identical with LID off and with `-l da` (measured) | None |
| Licence (runtime) | Apache-2.0 | MIT | MIT | MIT |
| Licence (weights) | CC-BY-4.0 | CC-BY-4.0 | CC-BY-4.0 | `tdt-0.6b-v3` from NVIDIA CC-BY-4.0; the repo is mixed per model |
| Release cadence | v0.13.6 pinned; latest v0.17.7 (2026-10-08); 12 releases since 2026-07-07; 2975 stars | 0.3.5 pinned; latest 0.3.8 (2026-09-23); 406 stars | 15 releases v0.8.27 to v0.8.41 between 2026-08-10 and 2026-10-02; 738 stars; essentially one maintainer (ADR-0002) | 11 releases v0.1.0 (2026-05-30) to v0.6.1 (2026-10-07), about monthly; 833 stars; LocalAI team |

## Trade-offs and risks (no recommendation)

- **Accuracy.** On this corpus the GGUF runtimes at q8_0/f16 make fewer errors than the shipped CoreML model in Hungarian (about 20 to 28 fewer words of 714) and Spanish (about 9 fewer of 1045), and the same in Danish and English. Low quants narrow or reverse this, especially crispasr q4_k on Danish. One run of 40 clips per language, so small gaps are noise.
- **Speed.** FluidAudio on the ANE is fastest per whole clip (66 ms against 81 to 104 ms warm) and flattest up to 15 s. parakeet.cpp on Metal is fastest on short buffers (1 to 8 s), which is most of what live mode decodes. Every option on Metal fits the 300 ms re-decode budget up to 20 s. CPU-only does not, beyond about 15 s.
- **Memory.** This is the biggest measured cost of moving.
  - crispasr q4_k uses about 0.7 GB RSS, q8_0 about 1.0 GB, and f16 about 1.6 GB.
  - parakeet.cpp uses about 1.3 to 2.9 GB, which is 2 to 3 times the file size on Metal and 1.4 GB on CPU.
  - Compare FluidAudio's 95 MB in-process. That number undercounts, see the caveat above.
- **Live Transcription.** No runtime offers native streaming for TDT-0.6b-v3, so moving keeps the current re-decode design.
  - **crispasr** has a ready-made re-decode stream loop and a server, but a different shape from Codictate's:
    - a rolling 10 s window by default (`--stream-length`);
    - finals re-decoded after 800 ms of silence;
    - its own microphone capture.
  - **parakeet.cpp** would need a persistent process. Its `parakeet-server` is labelled an example, so in practice that means a Codictate-authored wrapper over the C API.
- **ITN.** Neither GGUF runtime does ITN. ITN currently lives inside the macOS helper as a Rust static library, so removing the helper raises where ITN would run. Windows already has none, so the platforms differ today.
- **Packaging.**
  - crispasr is already vendored, sha256-pinned, and v0.8.29 already runs the cstr GGUF. Using it for Parakeet adds no binary, but it does add a hidden auto-download (whisper-tiny LID) unless `--lid-backend off` or `-l` is passed.
  - parakeet.cpp is about to be vendored for ekko anyway (issue #68), so its marginal binary cost is also small.
  - Either path drops the 2.55 GB Windows ONNX download in favour of a 0.4 to 1.4 GB GGUF.
- **GPU contention.** GGUF Parakeet would share the Metal GPU (and on Windows, the Vulkan GPU) with `llama-completion`. FluidAudio uses the ANE. Not measured.
- **Maintenance.**
  - crispasr ships about twice a week and is effectively one maintainer.
  - parakeet.cpp is young, ships about monthly, and its GPU backends are not in CI.
  - Codictate's FluidAudio pin is 4 minor versions behind, and its parakeet-rs pin is 3 patch versions behind.
- **Not measured.**
  - Windows anything.
  - Energy and thermals.
  - True first-launch cost of signed binaries.
  - Live mode end to end with a microphone.
  - crispasr's `--stream` quality against Codictate's loop.
  - FluidAudio's newer releases, including its Parakeet Ultra CoreML models.
  - parakeet.cpp `ultra`/`redux` and q5_k/q6_k files.
  - Nemotron 3.5 streaming.

## Sources

- crispasr: GitHub releases v0.8.29 and v0.8.41 (asset lists via `gh release view`); `--help` and `--list-backends` of both binaries.
- crispasr docs at tag v0.8.41: `docs/streaming.md`, `docs/server.md`, `docs/environment-variables.md`, `docs/troubleshooting.md`, `docs/performance.md`.
- crispasr source: `src/parakeet.cpp` (identical at v0.8.41 and `main` 13efa5c), `src/crispasr_model_registry.cpp` line 94 (the `-m auto` default is the cstr q4_k file), `models/convert-parakeet-to-gguf.py` at `main`.
- `https://huggingface.co/cstr/parakeet-tdt-0.6b-v3-GGUF` README, and the HF API file sizes for it, `mudler/parakeet-cpp-gguf`, `istupakov/parakeet-tdt-0.6b-v3-onnx` and `RyeAI/ekko-v1-tiny`.
- parakeet.cpp: README and `docs/capi.md` at v0.6.1, release v0.6.1 assets, `parakeet-cli --help`, `parakeet-cli info`.
- FluidAudio: README at `main`, GitHub releases. parakeet-rs: crates.io versions.
- Codictate:
  - `native/CodictateParakeetHelper/Sources/CodictateParakeetHelper/CodictateParakeetHelper.swift`, `Package.resolved`
  - `native/CodictateWindowsHelper/src/asr/parakeet.rs`, `Cargo.toml`
  - `src/shared/speech-models.ts`, `src/bun/utils/whisper/model-manager.ts`, `scripts/vendor-manifest.ts`
  - issue #68
