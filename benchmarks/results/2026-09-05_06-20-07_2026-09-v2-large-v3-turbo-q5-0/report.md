# STT Benchmark Report

**Description:** benchmark-v2 publication batch 2026-09-v2; codictate large-v3-turbo-q5_0; clips [0, 400) of the consumable range; hotkey option+z

- **Date:** 2026-09-05T06:40:41.981Z
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
| Large V3 Turbo q5_0 | **574 MB** | **768 MB** | **769 MB** | **772 MB** | **59 ms** | **91.6%** | **95.7%** | **89.2%** | **96.6%** | **94.8%** | **96.8%** | **85.6%** | **82.5%** | **95.6%** | 0 |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Large V3 Turbo q5_0 | 8 | 9 | 10 |

## Charts (All Models)

![Accuracy Comparison](accuracy-comparison.png)

![Speed Comparison](speed-comparison.png)

![Average Accuracy](accuracy-averages.png)

![Character Accuracy](cer-comparison.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Large V3 Turbo q5_0 | 96.6% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Large V3 Turbo q5_0 | 94.8% |

### Spanish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V3 Turbo q5_0 | 96.8% | 97.9% |

### Danish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V3 Turbo q5_0 | 85.6% | 93.9% |

### Hungarian

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V3 Turbo q5_0 | 82.5% | 94.7% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V3 Turbo q5_0 | 77 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V3 Turbo q5_0 | 83 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V3 Turbo q5_0 | 47 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V3 Turbo q5_0 | 53 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V3 Turbo q5_0 | 51 ms |
