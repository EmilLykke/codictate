# STT Benchmark

Measures Word Error Rate (WER), Real-Time Factor (RTF), and peak memory (RSS) for Codictate's speech-to-text models.

## ASR Harnesses: one runnable, one archived

There is exactly one **runnable** ASR Harness, `crispasr`. `whisper-cli` was retired after the benchmark settled it (see `benchmarks/results/2026-08-17_15-15-49_crispasr-vs-whisper/`), and nothing builds it any more, so no new measurement under it is possible. `--harness whisper-cli` is rejected with an explanation rather than silently ignored.

The results in `benchmarks/results/` are frozen and are treated as read-only measured data:

| Run                                             | Harness in the file                            |
| ----------------------------------------------- | ---------------------------------------------- |
| `2026-05-08_07-56-46_main-model-comparison`     | pre-harness shape, migrated to `whisper-cli`   |
| `2026-05-09_10-12-34_tiny-base-triage`          | pre-harness shape, migrated to `whisper-cli`   |
| `2026-05-09_15-40-49_full-run-except-tiny-base` | pre-harness shape, migrated to `whisper-cli`   |
| `2026-08-17_15-15-49_crispasr-vs-whisper`       | `whisper-cli` and `crispasr`, keyed explicitly |

Those whisper-cli numbers can never be re-measured, so **two separate concepts** are kept apart in code, and conflating them again is how the archive gets silently dropped:

- **Runnable Harness** - `ASR_HARNESS_IDS` in `src/shared/asr-harness.ts`. What a new run may execute. Used for `--harness` validation and for building a run plan.
- **Archived Harness label** - `BENCHMARK_HARNESS_LABELS` in `stt/results-schema.ts`. What a Harness key in a result file may legitimately say. Append-only, and still contains `whisper-cli`. **Every read path must validate against this one**: parsing, migration, flattening, coverage, reporting, checkpoint resume, and `stt/charts.py`.

`stt/results-archive.manual.ts` reads the four real run directories and fails if any archived whisper-cli bucket stops parsing. It is pinned to those four runs, so it sits outside the default `bun test` run (hence the `.manual.ts` suffix) and CI never touches it. Run it with `bun test ./benchmarks/stt/results-archive.manual.ts`, and update its pinned run list and counts whenever a Benchmark Run is archived.

In reports and charts, rows from the shipping Harness carry a bare Model ID and every other archived Harness is tagged, so archived rows read as `Large V3 q5_0 [whisper-cli]`. A run spanning more than one Harness also gets an **ASR Harnesses** line in the report header naming which Harness the untagged rows came from. Parakeet and hviske ignore the selected Harness (their own helper, and crispasr's pinned `cohere` backend) and are always recorded under the Harness that actually produced them.

## Prerequisites

- **ffmpeg** - `brew install ffmpeg`
- **hf** - `pip install huggingface-hub`
- **Speech models** - auto-downloaded by the benchmark runner, or via the Codictate app (stored in `~/Library/Application Support/codictate/models/`)
- **Vendor binaries** - `bun run build:native` or `bun run scripts/pre-build.ts`

## Datasets

| Dataset                                                            | Language                | Purpose                                                  |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| [LibriSpeech](https://www.openslr.org/12) test-clean               | English                 | Standard WER benchmark (comparable to published numbers) |
| [LibriSpeech](https://www.openslr.org/12) test-other               | English                 | Harder/noisier speakers                                  |
| [FLEURS](https://huggingface.co/datasets/google/fleurs) test split | es, da, hu (expandable) | Multilingual WER                                         |

LibriSpeech downloads automatically. FLEURS downloads via `hf`.

## Usage

```bash
# Full run: download + convert + benchmark all models
bun run bench:stt -- --name full-run --description "Full benchmark of all models"

# Named run (results saved as 2026-05-09_12-00-00_tiny-base-triage)
bun run bench:stt -- --name tiny-base-triage --description "Triage tiny and base model families" --models tiny,tiny-q5_1,base,base-q5_1 --samples 50

# Single model, skip download
bun run bench:stt -- --name turbo-only --description "Test turbo model" --models large-v3-turbo-q5_0 --skip-download

# Subset of models + specific FLEURS languages (es, da, hu)
bun run bench:stt -- --name multilingual --description "Multilingual comparison" --models small-q5_1,large-v3-turbo-q5_0 --languages es_419,da_dk,hu_hu

# FLEURS only, no LibriSpeech - the only honest way to run a Danish-pinned model
bun run bench:stt -- --name hviske-danish --description "hviske on Danish only" --models hviske-v5-tiny-q5_0 --splits none --languages da_dk

# Quick test run with fewer samples
bun run bench:stt -- --name smoke --description "Quick smoke test" --samples 10

# Continue a previous run - only benchmark models not yet in stt.json
bun run bench:stt -- --name small-medium --description "Add small and medium models" --models small,small-q5_1,medium,medium-q5_1 --skip-existing

# Benchmark all models, free disk space as each model finishes
bun run bench:stt -- --name full-run --description "All models, cleanup after" --offload-models

# Combine both: skip already-benchmarked models and offload when done
bun run bench:stt -- --name full-run --description "Continue full run, free disk" --skip-existing --offload-models

# Benchmark new models without re-downloading datasets
bun run bench:stt -- --name new-models --description "Test new quantizations" --models large-v3-q8_0,medium-q8_0 --skip-download --skip-convert --skip-existing

# Regenerate reports + charts for all runs
bun run bench:stt -- --report-only
```

## CLI Flags

| Flag               | Default            | Description                                                                                                     |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--harness`        | `crispasr`         | Comma-separated runnable ASR Harnesses. Only `crispasr` is runnable; a retired Harness is rejected, not ignored |
| `--name`           | **required**       | Slug appended to results directory, used as URL path on website                                                 |
| `--description`    | **required**       | Goal/context for this benchmark run (stored in stt.json, shown in report)                                       |
| `--models`         | all                | Comma-separated model IDs (all 34 models if omitted)                                                            |
| `--samples`        | 200                | Max utterances per dataset/language                                                                             |
| `--splits`         | all                | LibriSpeech splits (`test-clean,test-other`). `none` selects no LibriSpeech at all                              |
| `--languages`      | es_419,da_dk,hu_hu | FLEURS language codes. `none` selects no FLEURS at all                                                          |
| `--skip-download`  | false              | Skip dataset and model download step                                                                            |
| `--skip-convert`   | false              | Skip audio conversion step                                                                                      |
| `--skip-existing`  | false              | Load latest stt.json and skip model/dataset combos already benchmarked                                          |
| `--offload-models` | false              | Delete downloaded models from disk after all benchmarks complete                                                |
| `--report-only`    | false              | Regenerate markdown from existing stt.json                                                                      |
| `--aggregate`      | false              | Merge every run's stt.json into `results/stt.json` and write the combined report at the results root            |

`--splits none` and `--languages none` are how a language-pinned Speech Model gets benchmarked on only the language it can decode: `hviske-v5-tiny-q5_0` transcribes as Danish whatever it is handed, so an English LibriSpeech split measures Danish decoding of English speech rather than the model. Run it with `--splits none --languages da_dk`, which writes a legal empty `librispeech: {}` into `stt.json`. Passing `none` to both is rejected - there would be nothing to benchmark.

`--aggregate` walks the run directories in chronological order, but **depth wins over recency**: a Benchmark Combination already merged at 200 utterances is kept when a later, shallower run only measured it at 20, so the aggregate never publishes the noisier number. A rejected result prints a `[WARN]` line naming the dataset, Harness, Model ID and both utterance counts, and the total number of rejections is printed at the end of the merge. Equal depth goes to the newer run.

## Output

- `benchmarks/results/<timestamp>_<name>/stt.json` - machine-readable results with hardware metadata
- `benchmarks/results/<timestamp>_<name>/report.md` - markdown report with charts
- `benchmarks/results/<timestamp>_<name>/*.png` - chart images
- Markdown table printed to stdout

### Pooling accuracy across datasets

Each result leaf carries `referenceWords` - the denominator its `wer` was divided by -
and `referenceChars` alongside any `cer`. Combine datasets by pooling:

```
pooled WER = sum(wer * referenceWords) / sum(referenceWords)
```

An unweighted mean of per-dataset WERs is a different number and is not the accuracy of
the combined sample, so never publish one. `wer * referenceWords` is the error count and
is always a whole number, which also makes any leaf checkable.

The denominators are optional on read, because the archived runs were written before the
field existed. Fill them in without re-running a model:

```bash
bun run benchmarks/scripts/backfill-reference-words.ts          # dry run
bun run benchmarks/scripts/backfill-reference-words.ts --write
```

It recounts the scored slice of each dataset at each depth and refuses to write a count
that does not divide the recorded rate into whole errors. Two sample orderings are tried,
because LibriSpeech was drawn in filesystem-traversal order until d8b91ee (2026-05-09) and
the three May runs predate the seeded shuffle; the ordering used is named in the output
whenever it is not the current one.

## Adding Languages

FLEURS supports 102 languages. To add a language:

1. Find the FLEURS locale code (e.g., `fr_fr`, `de_de`, `it_it`)
2. Run with `--languages` flag: `bun run bench:stt -- --languages fr_fr,de_de`

The download script fetches only the test split (not full dataset).

## Models

34 models supported (33 Whisper + 1 Parakeet). Curated defaults:

| ID                     | Engine     | Size    | Notes                                           |
| ---------------------- | ---------- | ------- | ----------------------------------------------- |
| `small-q5_1`           | Whisper    | 181 MB  | Good accuracy                                   |
| `large-v3-turbo-q5_0`  | Whisper    | 574 MB  | Default, fast + accurate, bundled in `vendors/` |
| `large-v3-q5_0`        | Whisper    | 1100 MB | Most accurate                                   |
| `parakeet-tdt-0.6b-v3` | FluidAudio | 500 MB  | Fastest, macOS CoreML / Windows ONNX            |

Extended models span tiny through large-v3 in full/q5/q8 quantizations, with multilingual and English-only (.en) variants. Full catalog defined in `src/shared/speech-models.ts`. Missing models are auto-downloaded when benchmarking.

## Keeping the UI in sync

Run `bun benchmarks/stt/generate-ratings.ts` after benchmarking to regenerate `src/shared/model-ratings.ts`. The speed, accuracy, and languages bars in the model picker are derived from this file.

Ratings come from one ASR Harness, the shipping one by default, because they describe what users get. The script now refuses to write rather than emit a partial ratings file, which matters for the archive: the aggregate at `benchmarks/results/stt.json` measured 33 whisper Speech Models under whisper-cli and nothing under crispasr, so rating from it by default would have blanked all 33 bars in the model picker. Name the archived Harness to do it on purpose:

```bash
# Fails loudly, listing the 33 Speech Models that would be dropped
bun benchmarks/stt/generate-ratings.ts benchmarks/results/stt.json

# Rates from the archived whisper-cli measurements, with a warning
bun benchmarks/stt/generate-ratings.ts benchmarks/results/stt.json --harness=whisper-cli
```

The ratings currently shipping in `src/shared/model-ratings.ts` are whisper-cli measurements. Replacing them with crispasr numbers needs a full crispasr run across all 34 Speech Models, which has not happened yet - only 3 were covered by the comparison run.
