# STT Benchmark

Measures Word Error Rate (WER), Real-Time Factor (RTF), and peak memory (RSS) for Codictate's speech-to-text models.

## Prerequisites

- **ffmpeg** - `brew install ffmpeg`
- **hf** - `pip install huggingface-hub`
- **Speech models** - downloaded via the Codictate app (stored in `~/Library/Application Support/codictate/models/`)
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
# Full run: download + convert + benchmark all 4 models
bun run bench:stt

# Single model, skip download
bun run bench:stt -- --models large-v3-turbo-q5_0 --skip-download

# Subset of models + specific FLEURS languages (es, da, hu)
bun run bench:stt -- --models small-q5_1,large-v3-turbo-q5_0 --languages es_419,da_dk,hu_hu

# Limit samples per scenario (quick test run)
bun run bench:stt -- --samples 10

# Custom sample size for FLEURS subsample
bun run bench:stt -- --sample-size 100

# Regenerate report from existing results
bun run bench:stt -- --report-only
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--models` | all 4 | Comma-separated model IDs |
| `--languages` | es_419,da_dk,hu_hu | FLEURS language codes |
| `--sample-size` | 200 | Utterances per FLEURS language |
| `--samples` | all | Max utterances per scenario (caps both LibriSpeech and FLEURS) |
| `--skip-download` | false | Skip dataset download step |
| `--skip-convert` | false | Skip audio conversion step |
| `--report-only` | false | Regenerate markdown from existing stt.json |

## Output

- `benchmarks/results/stt.json` - machine-readable results with hardware metadata
- Markdown table printed to stdout

## Adding Languages

FLEURS supports 102 languages. To add a language:

1. Find the FLEURS locale code (e.g., `fr_fr`, `de_de`, `it_it`)
2. Run with `--languages` flag: `bun run bench:stt -- --languages fr_fr,de_de`

The download script fetches only the test split (not full dataset).

## Models

| ID | Engine | Size | Notes |
|----|--------|------|-------|
| `small-q5_1` | Whisper | 181 MB | Good accuracy |
| `large-v3-turbo-q5_0` | Whisper | 574 MB | Default, fast + accurate, bundled in `vendors/` |
| `large-v3-q5_0` | Whisper | 1100 MB | Most accurate |
| `parakeet-tdt-0.6b-v3` | FluidAudio | 500 MB | Fastest, macOS CoreML / Windows ONNX |

## Keeping the UI in sync

When benchmark results change, update `MODEL_STATS` in `src/mainview/components/Settings/ModelPicker.tsx` to match. The speed, accuracy, and languages bars in the model picker are derived from benchmark data and should reflect the latest results.
