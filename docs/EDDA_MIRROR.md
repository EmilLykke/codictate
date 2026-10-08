# The Edda v0.2 Mirror

`danish-foundation-models/edda-v0.2` is a Danish full fine-tune of
`openai/whisper-large-v3-turbo` by the Alexandra Institute, released under Apache-2.0. It is
ungated, but it ships fp16 safetensors only, which no ASR Harness reads. So Codictate
converts it to whisper.cpp GGML itself and hosts the result: a **Mirror** of its own
conversion rather than a byte copy, unlike the hviske Mirror.

The Mirror is live:

**https://huggingface.co/emillykkegrann/edda-v0.2-GGML**

`scripts/mirror-edda.ts` builds and uploads it, and is what you re-run if it ever has to be
rebuilt.

## Contents

| File | Bytes | Size | sha256 |
| --- | --- | --- | --- |
| `ggml-edda-v0.2-f16.bin` | 1624575439 | 1549 MiB | `5a2b2ccf…e629d9` |
| `ggml-edda-v0.2-q8_0.bin` | 874208239 | 834 MiB | `93b2a565…30b716` |
| `ggml-edda-v0.2-q5_0.bin` | 574061359 | 547 MiB | `75bd9abd…0add1` |

The full hashes are pinned in `src/shared/speech-models.ts`, and `model-manager.ts` checks
each download against them before installing it. The Mirror also carries the Apache-2.0
`LICENSE`, Whisper's MIT notice as `LICENSE-whisper`, and a `NOTICE` with the attribution
and the modification statement (the same files as `docs/licenses/edda/`).

## How it is built

From the source repo at revision `98ec5eee028b111a19733890fe32ea65267b662b`:

1. **Tokenizer files.** CrispASR's `models/convert-h5-to-ggml.py` reads `vocab.json` and
   `added_tokens.json`, which Edda does not ship. Both are derived from its `tokenizer.json`
   and come out identical to `openai/whisper-large-v3-turbo`'s.
2. **Convert** to GGML f16 with that script from CrispASR v0.8.29, plus an `openai/whisper`
   checkout for `mel_filters.npz`.
3. **Quantize** to q8_0 and q5_0 with `crispasr-legacy-quantize`, built from the CrispASR
   v0.8.29 source. The prebuilt `crispasr-quantize` in the release only reads GGUF and
   refuses Whisper GGML (`invalid magic characters: 'lmgg'`).

Because `added_tokens.json` is present, the files carry the 1,609 special-token strings in
their vocabulary. whisper.cpp's own conversions leave those for the runtime to generate.
That is the whole difference from a stock conversion, 20,164 bytes of header: a community
q5_0 built with whisper.cpp's tools (`Angel-Freak/edda-v0.2-ggml`) is exactly that much
smaller. The tensors are unchanged and crispasr loads both.

## Measurements

The Benchmark Run `2026-10-08_06-42-10_edda-v0-2-danish` measured all three on every
consumable FLEURS `da_dk` clip: 927 scored, 3 warmup, Apple M4 Max, crispasr default
backend, `--language da`.

| Quantization | Disk | Avg peak RSS | ms / sec audio | Danish WER | Danish CER |
| --- | --- | --- | --- | --- | --- |
| `f16` | 1549 MiB | 1884 MB | 74 ms | 7.51% | 4.44% |
| `q8_0` | 834 MiB | 1098 MB | 57 ms | 7.52% | 4.42% |
| `q5_0` | 547 MiB | 787 MB | 53 ms | 7.53% | 4.40% |

On the same 927 clips (the pooled aggregate), hviske v5 tiny q5_0 scores 11.31% and
large-v3-turbo-q5_0 13.89%.
The Quantization does not move accuracy, so **`q5_0`** is the one to recommend: the
smallest and fastest, at the same WER. It is slower and larger than hviske (53 vs 18 ms per
second of audio, 787 vs 327 MB average peak RSS), which is the price of a third fewer errors
(1,494 vs 2,245 word errors over 19,846 reference words).

None is marked `curated`. A Danish-only Speech Model belongs in the browse modal, as with
hviske.

## Runtime

Ordinary whisper.cpp GGML on crispasr's default Whisper backend, so Edda is a Whisper Speech
Model (`engine: 'whisper_cpp'`) and needs no backend pin. What is pinned is the language:
`supportedTranscriptionLanguageIds: ['da']` makes `pinnedTranscriptionLanguageId` send
`--language da` whatever the user's setting, and `translationSupport: false` keeps Translate
to English unavailable while an Edda model is selected.

**Windows: tested by hand.** The maintainer ran Edda on Windows hardware on 2026-10-08 and
reported it working. That was a manual check, not a Benchmark Run, so there are no Windows
speed or memory figures. The Windows crispasr binary runs the same Whisper backend every
stock Whisper Speech Model uses there.

## Licence position

Apache-2.0 from the Alexandra Institute, with Whisper's MIT notice for the base model; see
`docs/licenses/edda/` and the NOTICE at the repo root. Edda's training data includes CoRal,
whose licence the same institute grants. Whether CoRal's use restrictions still reach a
model the licensor itself released under Apache-2.0 is an interpretation, not a settled
fact, and is tracked on the Danish models map along with the FTSpeech terms. This is not
legal advice.

## Re-running the mirror script

```bash
# HF_WRITE_TOKEN needs write access to the destination namespace.
read -s HF_WRITE_TOKEN && export HF_WRITE_TOKEN
# A Python with torch, transformers and numpy, for the converter.
export EDDA_PYTHON=/path/to/python

bun run scripts/mirror-edda.ts --print-readme   # review the model card
bun run scripts/mirror-edda.ts --dry-run        # build, verify sha256, stage; upload nothing
bun run scripts/mirror-edda.ts                  # create the repo and upload
```

The script stops if any artifact differs from the sha256 the catalog pins. A rebuild that
produces different bytes is a new conversion: update `sha256` and `downloadSizeMB` in
`src/shared/speech-models.ts` and re-benchmark in the same change.
