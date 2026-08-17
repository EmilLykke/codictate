# crispasr is the only ASR Harness for the Whisper Speech Engine; whisper-cli is retired

Whisper transcription used to be hardwired to the `whisper-cli` binary. ASR Harness became a real abstraction so that `crispasr` (a whisper.cpp fork that also runs Cohere ASR and Parakeet backends from a single prebuilt binary) could be measured against it on the same Speech Models and the same audio. That benchmark has run, crispasr won it, and the abstraction has now collapsed back to one option. `whisper-cli` is retired: it is gone from the Harness list, gone from the app bundle, and gone from the build. There is exactly one Harness, `crispasr`, and it executes every Dictation, Translate to English included.

Two motives predate the numbers and still stand. The first is Danish accuracy: `syvai/hviske-v5-tiny` only loads under crispasr's `cohere` backend, and no whisper.cpp or llama.cpp build can read those weights. That payoff has shipped, see `docs/adr/0004-hviske-danish-ungated.md`. The second is packaging: upstream whisper.cpp publishes no macOS CLI asset, so `whisper-cli` cost a local cmake build of roughly 3 to 5 minutes on every fresh clone and every CI run. With it retired, `scripts/pre-build.ts` builds no ASR binary from source at all: `crispasr` and `llama-completion` both arrive as pinned prebuilt archives, sha256 verified. See `docs/adr/0001-vendor-binary-sourcing.md`.

## Considered Options

- **Add crispasr only for hviske, keep whisper-cli for Whisper.** Two ASR Vendor Binaries on the transcription path forever, with no evidence about which one should run the common case.
- **Replace whisper-cli on faith.** crispasr is a drop-in for Codictate's exact flag set (`-m -t --language -f --no-prints -nt`), confirmed by running the vendored binary against the repo's existing `ggml-large-v3-turbo-q5_0.bin`: correct Danish transcript, exit 0, same stdout shape. But adopting it without measurement would have moved the shipping transcription path onto a fast-moving v0.8.x project with essentially one maintainer, on nothing but a smoke test.
- **Make Harness a benchmark dimension and decide on the numbers (chosen for the switch).** Harness joined (Speech Model, dataset, language) as a coordinate of a Benchmark Combination, both Harnesses were run over the same corpus, and the switch was made on the result rather than on preference.
- **Keep whisper-cli vendored as a degrade path.** This is what the previous revision of this ADR chose, and it was wrong. A Harness that only runs when the primary one fails to resolve is a Harness nobody ever exercises, so it is untested by construction and least trustworthy exactly when it is needed. It also kept its full cost: the cmake build in every clone and CI run, a second flag contract, a second entitlements plist, a second signing target, and a whisper.cpp source build sitting in the tree against the plain intent of ADR 0001. All of that to insure against a failure mode (an unresolvable Vendor Binary in a signed bundle) that is a packaging bug we would have to fix anyway.
- **Retire whisper-cli outright (chosen for the end state).** One Harness, one flag contract, no source build. If the crispasr binary cannot be resolved, Dictation fails loudly instead of silently transcribing more slowly. That is a real cost, recorded below.

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

That result should be read as **parity, not as a small regression, and not as a crispasr accuracy win either**, and the reason is the sample depth. At 17 scored utterances per Benchmark Combination, one extra word error moves WER by roughly 1pp. A 0.11pp mean difference is an order of magnitude below the resolution of the measurement, so the correct claim is that this run did not distinguish the two Harnesses on accuracy. Anyone who needs a real accuracy verdict has to re-run at a much larger Sample count, and can now only do so for crispasr.

The decision therefore rests on speed and memory, where the signal is unambiguous, plus the strategic argument below. It does not rest on the WER column.

## Why crispasr rather than a faster whisper-cli

Beyond the benchmark, crispasr is a single binary carrying 107 compiled backends. One of them is `cohere`, the only runtime that can load the `syvai/hviske-v5-tiny` Danish GGUF weights; neither whisper.cpp nor llama.cpp can read them. Adopting crispasr as the Whisper Harness turned "add a new ASR model family" from "vendor another Vendor Binary, with its own flag contract, packaging, signing and platform matrix" into "pass `--backend`". Danish hviske support shipped on exactly that mechanism, which is the concrete payoff. That is the durable reason to put crispasr on the shipping path, and it would have been worth doing at speed parity.

## What retiring whisper-cli costs

Two costs, both accepted deliberately rather than argued away.

**There is no degrade path left.** If the crispasr Vendor Binary cannot be resolved (missing from the bundle, quarantined, unsigned, broken by an OS update), Dictation fails loudly. It does not fall back to a slower transcription; there is nothing to fall back to. The reasoning is that a silent degrade to an unexercised binary is worse than an error a user can report, and that an unresolvable Vendor Binary is a packaging defect that has to be fixed at the source rather than papered over at runtime.

**The whisper-cli baseline can no longer be re-measured.** Everything the comparison run did not cover is now permanently uncovered: Danish (`da_dk` was never in the Benchmark Run at all, despite Danish being the motivating language), the small and tiny Speech Models (only `q5_0` Quantizations were tested, all medium or large), and Windows (crispasr there is a separate Vulkan build with no numbers of its own). Those gaps can still be measured for crispasr, but never again against whisper-cli. The archived results under `benchmarks/results/` stay readable as the historical record and are frozen: the binary that produced those numbers is no longer in the tree.

## Consequences

- crispasr is the sole shipping transcription path, which means a fast-moving v0.8.x single-maintainer project sits in the critical path of the app's core feature with nothing behind it. This is a knowingly accepted risk, not an oversight. It is pinned to v0.8.29 and sha256 verified, so a bad upstream release cannot reach users without an explicit pin bump.
- **Translate to English runs on crispasr like any other Dictation; there is no translate-specific pin.** An earlier revision of this ADR claimed `-tr` was unverified under crispasr and routed Translate to `whisper-cli` for that reason. Both claims were wrong and are retracted, and the constant that briefly carried the pin has been deleted.
- **The turbo misdiagnosis, recorded so nobody repeats it.** The evidence for the retracted claim was a `large-v3-turbo-q5_0` test that came back Danish instead of English. The observation was real, the conclusion was not: turbo is a transcribe-only distillation that cannot translate at all, and `whisper-cli` returned Danish on that same Speech Model too. It was the wrong Speech Model for the test, never a crispasr defect. Anyone re-checking `-tr` must use a translate-capable Speech Model or they will reproduce the same wrong verdict.
- **`-tr` was measured before the retirement.** Re-run on `ggml-large-v3-q5_0.bin`, which is translate-capable, with identical flag sets on both Harnesses (`-m -t --language -f --no-prints -nt -tr`) over 5 FLEURS Samples in Danish and Spanish. crispasr produced English on every Sample. One Spanish Sample was character-identical across the two Harnesses; the Danish ones differ only as ordinary decoding variance ("All are a part of the society" against "All are part of the society", must against should, and one Sample where crispasr dropped "polar" from "polar light"). That is the same magnitude as the WER differences this ADR already accepts elsewhere.
- **The translate Speech Model swap is a Speech Model concern, not a Harness concern.** `resolveTranslateModelId()` in `src/shared/whisper-models.ts` is untouched by this decision: when Translate to English is requested, Codictate swaps to a translate-capable Speech Model (Small or Large), because turbo cannot translate at all. That swap is what makes Translate to English work.
- Backend and language follow the Speech Model that actually runs, not the one the user selected. An hviske run passes `--backend cohere` and pins Danish; a Translate to English request on an hviske selection resolves away to a translate-capable Whisper Speech Model, which inherits neither the backend nor the pin. None of that is a Harness concern; it is the same binary either way.
- The build got shorter and simpler. No whisper.cpp source download, no cmake configure, no 3 to 5 minute compile, one less entitlements plist and one less signing target on the ASR side. cmake is no longer part of a normal macOS or Windows dev setup.
- Harness is still a dimension in benchmark results (`librispeech[dataset][harness][modelId]`), because the archives need it to stay readable. It is a dimension with one live value.
- "Already benchmarked" is a property of a (Harness, Speech Model, dataset, language) Benchmark Combination, not of a Speech Model. That is why the switch invalidated the earlier numbers instead of inheriting them.
- Harness stays internal and was never exposed to end users. There is no Harness picker, and there is no longer an override env var either. The whole switch was invisible in the UI: users on the Whisper Speech Engine kept the same Speech Model list and the same settings, and simply got faster transcription with a smaller memory footprint.
- Walking the decision back is no longer cheap. There is no settings migration and no user-visible surface to unwind, but reverting means restoring a deleted source build, giving up the speed and memory wins, and losing the `cohere` backend and therefore all Danish hviske support with it.
