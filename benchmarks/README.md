# STT Benchmark

Measures Word Error Rate (WER), Real-Time Factor (RTF), and peak memory (RSS) for Codictate's speech-to-text models.

## Prerequisites

- **ffmpeg** - `brew install ffmpeg`
- **hf** - `pip install huggingface-hub`
- **Speech models** - auto-downloaded by the benchmark runner, or via the Codictate app (stored in `~/Library/Application Support/codictate/models/`)
- **Vendor binaries** - `bun run build:native` or `bun run scripts/pre-build.ts`

## Datasets

| Dataset | Language | Purpose |
|---------|----------|---------|
| [LibriSpeech](https://www.openslr.org/12) test-clean | English | Standard WER benchmark (comparable to published numbers) |
| [LibriSpeech](https://www.openslr.org/12) test-other | English | Harder/noisier speakers |
| [FLEURS](https://huggingface.co/datasets/google/fleurs) test split | es, da, hu (expandable) | Multilingual WER |

LibriSpeech downloads automatically. FLEURS downloads via `hf`.

## Usage

```bash
# Full run: download + convert + benchmark all models
bun run bench:stt -- --description "Full benchmark of all models"

# Named run (results saved as 2026-05-09_12-00-00_tiny-base-triage)
bun run bench:stt -- --name tiny-base-triage --description "Triage tiny and base model families" --models tiny,tiny-q5_1,base,base-q5_1 --samples 50

# Single model, skip download
bun run bench:stt -- --description "Test turbo model" --models large-v3-turbo-q5_0 --skip-download

# Subset of models + specific FLEURS languages (es, da, hu)
bun run bench:stt -- --description "Multilingual comparison" --models small-q5_1,large-v3-turbo-q5_0 --languages es_419,da_dk,hu_hu

# Quick test run with fewer samples
bun run bench:stt -- --description "Quick smoke test" --samples 10

# Regenerate reports + charts for all runs
bun run bench:stt -- --report-only
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--description` | **required** | Goal/context for this benchmark run (stored in stt.json, shown in report) |
| `--models` | all | Comma-separated model IDs (all 34 models if omitted) |
| `--name` | **required** | Slug appended to results directory, used as URL path on website |
| `--samples` | 200 | Max utterances per dataset/language |
| `--languages` | es_419,da_dk,hu_hu | FLEURS language codes |
| `--skip-download` | false | Skip dataset and model download step |
| `--skip-convert` | false | Skip audio conversion step |
| `--report-only` | false | Regenerate markdown from existing stt.json |

## Output

- `benchmarks/results/<timestamp>_<name>/stt.json` - machine-readable results with hardware metadata
- `benchmarks/results/<timestamp>_<name>/report.md` - markdown report with charts
- `benchmarks/results/<timestamp>_<name>/*.png` - chart images
- Markdown table printed to stdout

## Adding Languages

FLEURS supports 102 languages. To add a language:

1. Find the FLEURS locale code (e.g., `fr_fr`, `de_de`, `it_it`)
2. Run with `--languages` flag: `bun run bench:stt -- --languages fr_fr,de_de`

The download script fetches only the test split (not full dataset).

## Models

34 models supported (33 Whisper + 1 Parakeet). Curated defaults:

| ID | Engine | Size | Notes |
|----|--------|------|-------|
| `small-q5_1` | Whisper | 181 MB | Good accuracy |
| `large-v3-turbo-q5_0` | Whisper | 574 MB | Default, fast + accurate, bundled in `vendors/` |
| `large-v3-q5_0` | Whisper | 1100 MB | Most accurate |
| `parakeet-tdt-0.6b-v3` | FluidAudio | 500 MB | Fastest, macOS CoreML / Windows ONNX |

Extended models span tiny through large-v3 in full/q5/q8 quantizations, with multilingual and English-only (.en) variants. Full catalog defined in `src/shared/speech-models.ts`. Missing models are auto-downloaded when benchmarking.

## Keeping the UI in sync

Run `bun benchmarks/stt/generate-ratings.ts` after benchmarking to regenerate `src/shared/model-ratings.ts`. The speed, accuracy, and languages bars in the model picker are derived from this file.
