# crispasr is the shipping ASR Harness for the Whisper Speech Engine; whisper-cli stays vendored only as the fallback when crispasr cannot be resolved

Whisper transcription used to be hardwired to the `whisper-cli` binary. ASR Harness became a real abstraction so that `crispasr` (a whisper.cpp fork that also runs Cohere ASR and Parakeet backends from a single prebuilt binary) could be measured against it on the same Speech Models and the same audio. That benchmark has run. crispasr is now the Harness that executes Whisper for users: it is faster on every Benchmark Combination measured, uses less peak memory on every Speech Model measured, and is within measurement noise on accuracy. `whisper-cli` is not retired, but it has exactly one job left. It is the degrade target if the crispasr binary cannot be resolved, so Dictation keeps working rather than failing outright. Nothing else routes to it: `DEFAULT_ASR_HARNESS` is `crispasr`, and every Dictation, Translate to English included, runs on whatever Harness is resolved.

Two motives predate the numbers and still stand. The first is Danish accuracy: `syvai/hviske-v5-tiny` only loads under crispasr's `cohere` backend, and no whisper.cpp or llama.cpp build can read those weights. The second is packaging: upstream whisper.cpp publishes no macOS CLI asset, so `whisper-cli` costs a local cmake build of roughly 3 to 5 minutes on a fresh clone, while crispasr ships a prebuilt macOS arm64 binary (16 MB, one binary plus one dylib) and a prebuilt Windows Vulkan build. See `docs/adr/0001-vendor-binary-sourcing.md`.

## Considered Options

- **Add crispasr only for hviske, keep whisper-cli for Whisper.** Two ASR Vendor Binaries on the transcription path forever, with no evidence about which one should run the common case.
- **Replace whisper-cli on faith.** crispasr is a drop-in for Codictate's exact flag set (`-m -t --language -f --no-prints -nt`), confirmed by running the vendored binary against the repo's existing `ggml-large-v3-turbo-q5_0.bin`: correct Danish transcript, exit 0, same stdout shape. But adopting it without measurement would have moved the shipping transcription path onto a fast-moving v0.8.x project with essentially one maintainer, on nothing but a smoke test.
- **Make Harness a benchmark dimension and decide on the numbers (chosen).** Harness joined (Speech Model, dataset, language) as a coordinate of a Benchmark Combination, both Harnesses were run over the same corpus, and the switch was made on the result rather than on preference.

## The measured evidence

Benchmark Run `crispasr-vs-whisper`, on an Apple M4 Max with 36 GB RAM running macOS 26.5.1. Three Speech Models (`large-v3-q5_0`, `large-v3-turbo-q5_0`, `medium.en-q5_0`) across three datasets (LibriSpeech `test-clean`, LibriSpeech `test-other`, FLEURS `es_419`), giving nine Harness-to-Harness comparisons. **17 scored utterances per Benchmark Combination** (20 Samples, first 3 discarded as warmup).

**Speed.** crispasr was faster in **9 of 9** comparisons. Median speedup **1.58x** on RTF, range 1.36x to 1.80x. This is the clearest result in the run: it is unanimous, and the margin is far wider than anything 17 utterances could manufacture.

**Peak RSS**, averaged per Speech Model:

| Speech Model | whisper-cli | crispasr | Change |
| --- | --- | --- | --- |
| `large-v3-q5_0` | 1990 MB | 1505 MB | -24% |
| `medium.en-q5_0` | 1124 MB | 833 MB | -26% |
| `large-v3-turbo-q5_0` | 802 MB | 738 MB | -8% |

The two larger footprints drop by about a quarter, which matters on 8 and 16 GB machines where Whisper competes with the Formatting Backend for memory. Turbo, already the smallest, gains least.

**Accuracy**, mean WER across all nine comparisons:

| Harness | Mean WER |
| --- | --- |
| whisper-cli | 4.68% |
| crispasr | 4.78% |

The gap is **0.11pp**. Per (Speech Model, dataset) pair the record is: crispasr better on 2, tied on 3, worse on 3.

That result should be read as **parity, not as a small regression**, and the reason is the sample depth. At 17 scored utterances per Benchmark Combination, one extra word error moves WER by roughly 1pp. A 0.11pp mean difference is an order of magnitude below the resolution of the measurement, so the correct claim is that this run did not distinguish the two Harnesses on accuracy. It is not evidence that crispasr is very slightly worse, and it is not evidence that it is equal either. Anyone who needs a real accuracy verdict has to re-run at a much larger Sample count.

The decision therefore rests on speed and memory, where the signal is unambiguous, plus the strategic argument below. It does not rest on the WER column.

## Why crispasr rather than a faster whisper-cli

Beyond the benchmark, crispasr is a single binary carrying 107 compiled backends. One of them is `cohere`, the only runtime that can load the `syvai/hviske-v5-tiny` Danish GGUF weights; neither whisper.cpp nor llama.cpp can read them. Adopting crispasr as the Whisper Harness turns "add a new ASR model family" from "vendor another Vendor Binary, with its own flag contract, packaging, signing and platform matrix" into "pass `--backend`". That is the durable reason to put it on the shipping path, and it would have been worth doing at speed parity.

## Consequences

- crispasr is on the shipping transcription path, which means a fast-moving v0.8.x single-maintainer project now sits in the critical path of the app's core feature. This is a knowingly accepted risk, not an oversight. It is pinned to v0.8.29 and sha256 verified, so a bad upstream release cannot reach users without an explicit pin bump.
- **Translate to English runs on the resolved Harness like any other Dictation; there is no translate-specific pin.** An earlier revision of this ADR claimed `-tr` was unverified under crispasr and routed Translate to `whisper-cli` for that reason. Both claims were wrong and are retracted, and the constant that briefly carried the pin has been deleted. A translate run now resolves the same crispasr binary as a plain run and still passes `-tr`.
- **The turbo misdiagnosis, recorded so nobody repeats it.** The evidence for the retracted claim was a `large-v3-turbo-q5_0` test that came back Danish instead of English. The observation was real, the conclusion was not: turbo is a transcribe-only distillation that cannot translate at all, and `whisper-cli` returns Danish on that same Speech Model too. It was the wrong Speech Model for the test, never a crispasr defect. Anyone re-checking `-tr` must use a translate-capable Speech Model or they will reproduce the same wrong verdict.
- **`-tr` is now measured.** Re-run on `ggml-large-v3-q5_0.bin`, which is translate-capable, with identical flag sets on both Harnesses (`-m -t --language -f --no-prints -nt -tr`) over 5 FLEURS Samples in Danish and Spanish. crispasr produced English on every Sample. One Spanish Sample was character-identical across the two Harnesses; the Danish ones differ only as ordinary decoding variance ("All are a part of the society" against "All are part of the society", must against should, and one Sample where crispasr dropped "polar" from "polar light"). That is the same magnitude as the WER differences this ADR already accepts elsewhere.
- **The translate Speech Model swap is a Speech Model concern, not a Harness concern.** `resolveTranslateModelId()` in `src/shared/whisper-models.ts` is untouched by this decision: when Translate to English is requested, Codictate swaps to a translate-capable Speech Model (Small or Large), because turbo cannot translate under either Harness. That swap, not the Harness choice, is what makes Translate to English work at all.
- One narrow translate restriction survives, and it has nothing to do with Harness choice: an hviske run (`--backend cohere`) combined with Translate to English throws, because that backend's translate support is unverified and the weights are Danish-only.
- `whisper-cli` stays vendored, and therefore still source-built on macOS, for the fallback path alone. Retiring it would mean accepting that an unresolvable crispasr binary breaks Dictation outright.
- Harness is a first-class dimension in benchmark results: `librispeech[dataset][harness][modelId]`. Result files that predate the dimension are read as `whisper-cli` at load time.
- "Already benchmarked" is a property of a (Harness, Speech Model, dataset, language) Benchmark Combination, not of a Speech Model. Switching Harness invalidates prior numbers rather than inheriting them.
- Harness stays internal and is never exposed to end users. There is no Harness picker, and the switch is invisible in the UI: users on the Whisper Speech Engine keep the same Speech Model list and the same settings, and simply get faster transcription with a smaller memory footprint.
- Because Harness is internal, walking the decision back is a code change with no settings migration and no user-visible surface to unwind. It is no longer free, though: reverting means giving up the speed and memory wins, and it means the `cohere` backend, and therefore any Danish hviske support, goes away with it.
- **Still unmeasured, and not claimed either way by this ADR:** Danish beyond the 5 translate Samples above (`da_dk` was not part of the Benchmark Run at all, despite Danish being the motivating language, and 5 spot-checked translate Samples are not a WER measurement), small and tiny Speech Models (only `q5_0` Quantizations were tested, all medium or large), and Windows, where crispasr is a separate Vulkan build with no numbers at all. The Windows adoption rides on the macOS result plus platform parity, not on its own evidence.
