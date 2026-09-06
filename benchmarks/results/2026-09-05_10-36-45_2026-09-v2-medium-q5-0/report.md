# STT Benchmark Report

**Description:** benchmark-v2 publication batch 2026-09-v2; codictate medium-q5_0; clips [0, 400) of the consumable range; hotkey option+z

- **Date:** 2026-09-05T10:57:33.830Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.6.2
- **Pooled unique scored clips per dataset:** 400
- **Sample selection:** `--to 400` (topped every dataset up to depth 400)
- **Warmup utterances:** 3
- **ASR Harness:** crispasr
- **Combinations tested:** 1

> Response times are not measured the same way for both products: Codictate is timed at the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste.

Accuracy and speed are **pooled**: `sum(errors) / sum(references)` and `sum(response time) / sum(audio)`. An unweighted mean of per-dataset rates is a different number and is never published. Leaves with no denominator are skipped, never counted as zero.

Speed comes from `speedV2` - the provenance-filtered v2 measurement - and a leaf that has none is shown as `(legacy)`, from `meanRTF`. The two are different measurements (`meanRTF` is session wall clock over audio, over every scored Sample) and neither ever stands in for the other.

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | Pooled Overall | Pooled English | Pooled Multilingual | English (clean) | English (noisy) | Spanish | Danish | Hungarian | Pooled Char Accuracy | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Medium q5_0 | **514 MB** | **872 MB** | **873 MB** | **875 MB** | **60 ms** | **87.7%** | **94.5%** | **83.7%** | **96.0%** | **92.9%** | **96.2%** | **78.0%** | **72.5%** | **93.6%** | 0 |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Medium q5_0 | 8 | 9 | 10 |

## Charts (All Models)

![Accuracy Comparison](accuracy-comparison.png)

![Speed Comparison](speed-comparison.png)

![Average Accuracy](accuracy-averages.png)

![Character Accuracy](cer-comparison.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Medium q5_0 | 96.0% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Medium q5_0 | 92.9% |

### Spanish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Medium q5_0 | 96.2% | 97.7% |

### Danish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Medium q5_0 | 78.0% | 90.8% |

### Hungarian

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Medium q5_0 | 72.5% | 91.6% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Medium q5_0 | 73 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Medium q5_0 | 76 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Medium q5_0 | 49 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Medium q5_0 | 57 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Medium q5_0 | 56 ms |
