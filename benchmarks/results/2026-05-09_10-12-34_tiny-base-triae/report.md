# STT Benchmark Report

- **Date:** 2026-05-09T10:12:34.798Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.4.1
- **Samples per dataset:** 50
- **Warmup utterances:** 3
- **Models tested:** 12

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | Avg Overall | Avg English | Avg Multilingual | English (clean) | English (noisy) | Spanish | Danish | Hungarian |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Base full | 142 MB | 330 MB | 334 MB | 343 MB | **57 ms** | **69.1%** | 91.2% | **54.4%** | 91.8% | 90.6% | 88.4% | **39.5%** | 35.3% |
| Base q5_1 | 57 MB | 214 MB | 219 MB | 227 MB | 57 ms | 68.7% | 90.3% | 54.3% | 90.8% | 89.9% | **88.9%** | 37.6% | **36.4%** |
| Base q8_0 | 78 MB | 243 MB | 247 MB | 256 MB | 57 ms | 69.0% | 91.2% | 54.2% | 92.4% | 90.1% | 88.6% | 38.4% | 35.5% |
| Base full en | 142 MB | 330 MB | 333 MB | 340 MB | 59 ms | 33.0% | **92.4%** | -6.7% | **93.1%** | 91.8% | 0.8% | -7.0% | -13.8% |
| Base q5_1 en | 57 MB | 215 MB | 217 MB | 225 MB | 58 ms | 33.7% | 92.4% | -5.3% | 92.7% | **92.1%** | 3.8% | -9.6% | -10.2% |
| Base q8_0 en | 78 MB | 243 MB | 247 MB | 259 MB | 58 ms | 33.7% | 92.1% | -5.2% | 92.4% | 91.8% | 3.2% | -7.9% | -10.9% |
| Tiny full | 75 MB | 218 MB | 224 MB | 231 MB | 57 ms | 58.0% | 87.0% | 38.7% | 87.6% | 86.4% | 85.0% | 14.2% | 16.9% |
| Tiny q5_1 | **31 MB** | **151 MB** | **157 MB** | 165 MB | 58 ms | 56.5% | 86.5% | 36.5% | 87.1% | 86.0% | 83.5% | 14.4% | 11.7% |
| Tiny q8_0 | 42 MB | 168 MB | 174 MB | 180 MB | 57 ms | 57.6% | 87.0% | 38.0% | 87.2% | 86.8% | 85.0% | 11.2% | 17.9% |
| Tiny full en | 75 MB | 218 MB | 224 MB | 228 MB | 59 ms | 26.5% | 88.4% | -14.8% | 88.9% | 87.8% | -1.2% | -18.7% | -24.4% |
| Tiny q5_1 en | **31 MB** | **151 MB** | **157 MB** | **162 MB** | 59 ms | 25.2% | 88.2% | -16.7% | 88.8% | 87.5% | -1.0% | -26.0% | -23.2% |
| Tiny q8_0 en | 42 MB | 168 MB | 173 MB | 181 MB | 58 ms | 24.7% | 88.6% | -17.9% | 89.1% | 88.1% | -2.3% | -20.7% | -30.7% |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Base full | 9 | 4 | 10 |
| Base q5_1 | 9 | 4 | 10 |
| Base q8_0 | 9 | 4 | 10 |
| Base full en | 9 | 1 | 1 |
| Base q5_1 en | 9 | 1 | 1 |
| Base q8_0 en | 9 | 1 | 1 |
| Tiny full | 9 | 2 | 10 |
| Tiny q5_1 | 9 | 2 | 10 |
| Tiny q8_0 | 9 | 2 | 10 |
| Tiny full en | 9 | 1 | 1 |
| Tiny q5_1 en | 9 | 1 | 1 |
| Tiny q8_0 en | 9 | 1 | 1 |

## Charts

![Accuracy Comparison](accuracy-comparison.png)

![Speed Comparison](speed-comparison.png)

![Average Accuracy](accuracy-averages.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Base full | 91.8% |
| Base q5_1 | 90.8% |
| Base q8_0 | 92.4% |
| Base full en | 93.1% |
| Base q5_1 en | 92.7% |
| Base q8_0 en | 92.4% |
| Tiny full | 87.6% |
| Tiny q5_1 | 87.1% |
| Tiny q8_0 | 87.2% |
| Tiny full en | 88.9% |
| Tiny q5_1 en | 88.8% |
| Tiny q8_0 en | 89.1% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Base full | 90.6% |
| Base q5_1 | 89.9% |
| Base q8_0 | 90.1% |
| Base full en | 91.8% |
| Base q5_1 en | 92.1% |
| Base q8_0 en | 91.8% |
| Tiny full | 86.4% |
| Tiny q5_1 | 86.0% |
| Tiny q8_0 | 86.8% |
| Tiny full en | 87.8% |
| Tiny q5_1 en | 87.5% |
| Tiny q8_0 en | 88.1% |

### Spanish

| Model | Accuracy (%) |
| --- | --- |
| Base full | 88.4% |
| Base q5_1 | 88.9% |
| Base q8_0 | 88.6% |
| Base full en | 0.8% |
| Base q5_1 en | 3.8% |
| Base q8_0 en | 3.2% |
| Tiny full | 85.0% |
| Tiny q5_1 | 83.5% |
| Tiny q8_0 | 85.0% |
| Tiny full en | -1.2% |
| Tiny q5_1 en | -1.0% |
| Tiny q8_0 en | -2.3% |

### Danish

| Model | Accuracy (%) |
| --- | --- |
| Base full | 39.5% |
| Base q5_1 | 37.6% |
| Base q8_0 | 38.4% |
| Base full en | -7.0% |
| Base q5_1 en | -9.6% |
| Base q8_0 en | -7.9% |
| Tiny full | 14.2% |
| Tiny q5_1 | 14.4% |
| Tiny q8_0 | 11.2% |
| Tiny full en | -18.7% |
| Tiny q5_1 en | -26.0% |
| Tiny q8_0 en | -20.7% |

### Hungarian

| Model | Accuracy (%) |
| --- | --- |
| Base full | 35.3% |
| Base q5_1 | 36.4% |
| Base q8_0 | 35.5% |
| Base full en | -13.8% |
| Base q5_1 en | -10.2% |
| Base q8_0 en | -10.9% |
| Tiny full | 16.9% |
| Tiny q5_1 | 11.7% |
| Tiny q8_0 | 17.9% |
| Tiny full en | -24.4% |
| Tiny q5_1 en | -23.2% |
| Tiny q8_0 en | -30.7% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base full | 120 ms |
| Base q5_1 | 120 ms |
| Base q8_0 | 119 ms |
| Base full en | 120 ms |
| Base q5_1 en | 119 ms |
| Base q8_0 en | 120 ms |
| Tiny full | 120 ms |
| Tiny q5_1 | 120 ms |
| Tiny q8_0 | 120 ms |
| Tiny full en | 120 ms |
| Tiny q5_1 en | 120 ms |
| Tiny q8_0 en | 119 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base full | 63 ms |
| Base q5_1 | 63 ms |
| Base q8_0 | 63 ms |
| Base full en | 63 ms |
| Base q5_1 en | 63 ms |
| Base q8_0 en | 63 ms |
| Tiny full | 63 ms |
| Tiny q5_1 | 63 ms |
| Tiny q8_0 | 63 ms |
| Tiny full en | 63 ms |
| Tiny q5_1 en | 63 ms |
| Tiny q8_0 en | 63 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base full | 44 ms |
| Base q5_1 | 44 ms |
| Base q8_0 | 44 ms |
| Base full en | 45 ms |
| Base q5_1 en | 45 ms |
| Base q8_0 en | 45 ms |
| Tiny full | 44 ms |
| Tiny q5_1 | 44 ms |
| Tiny q8_0 | 44 ms |
| Tiny full en | 44 ms |
| Tiny q5_1 en | 44 ms |
| Tiny q8_0 en | 44 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base full | 52 ms |
| Base q5_1 | 52 ms |
| Base q8_0 | 52 ms |
| Base full en | 55 ms |
| Base q5_1 en | 55 ms |
| Base q8_0 en | 53 ms |
| Tiny full | 53 ms |
| Tiny q5_1 | 54 ms |
| Tiny q8_0 | 53 ms |
| Tiny full en | 53 ms |
| Tiny q5_1 en | 53 ms |
| Tiny q8_0 en | 53 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base full | 47 ms |
| Base q5_1 | 47 ms |
| Base q8_0 | 47 ms |
| Base full en | 50 ms |
| Base q5_1 en | 48 ms |
| Base q8_0 en | 48 ms |
| Tiny full | 48 ms |
| Tiny q5_1 | 48 ms |
| Tiny q8_0 | 47 ms |
| Tiny full en | 52 ms |
| Tiny q5_1 en | 54 ms |
| Tiny q8_0 en | 52 ms |
