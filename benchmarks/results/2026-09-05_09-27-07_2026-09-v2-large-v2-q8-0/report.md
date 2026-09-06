# STT Benchmark Report

**Description:** benchmark-v2 publication batch 2026-09-v2; codictate large-v2-q8_0; clips [0, 400) of the consumable range; hotkey option+z

- **Date:** 2026-09-05T10:07:24.525Z
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
| Large V2 q8_0 | **1.5 GB** | **2.1 GB** | **2.1 GB** | **2.1 GB** | **116 ms** | **90.9%** | **95.0%** | **88.5%** | **96.2%** | **93.6%** | **96.8%** | **84.8%** | **81.1%** | **95.3%** | 0 |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Large V2 q8_0 | 7 | 9 | 10 |

## Charts (All Models)

![Accuracy Comparison](accuracy-comparison.png)

![Speed Comparison](speed-comparison.png)

![Average Accuracy](accuracy-averages.png)

![Character Accuracy](cer-comparison.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Large V2 q8_0 | 96.2% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Large V2 q8_0 | 93.6% |

### Spanish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V2 q8_0 | 96.8% | 98.0% |

### Danish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V2 q8_0 | 84.8% | 93.3% |

### Hungarian

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Large V2 q8_0 | 81.1% | 94.3% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V2 q8_0 | 139 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V2 q8_0 | 149 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V2 q8_0 | 107 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V2 q8_0 | 104 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Large V2 q8_0 | 106 ms |
