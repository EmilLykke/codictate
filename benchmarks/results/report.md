# STT Benchmark Report

- **Date:** 2026-05-07T19:32:31.350Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.4.1
- **Samples per dataset:** 200
- **Warmup utterances:** 3
- **Models tested:** 4

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | English (clean) | English (noisy) | Spanish | Danish | Hungarian |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Whisper Large | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 146 ms | 97.7% | 93.8% | 96.0% | 85.8% | 91.9% |
| Whisper Large Turbo | 574 MB | 797 MB | 801 MB | 806 MB | 99 ms | 95.5% | 93.8% | 96.9% | 83.0% | 87.5% |
| Parakeet 0.6B | 2.5 GB | 77 MB | 80 MB | 87 MB | 18 ms | 98.9% | 88.5% | 97.4% | 80.2% | 91.9% |
| Whisper Small | 181 MB | 473 MB | 477 MB | 482 MB | 56 ms | 95.5% | 89.4% | 93.8% | 64.2% | 63.2% |

## Charts

![Accuracy Comparison](accuracy-comparison.png)

![Accuracy vs Speed](speed-accuracy.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 97.7% |
| Whisper Large Turbo | 95.5% |
| Parakeet 0.6B | 98.9% |
| Whisper Small | 95.5% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 93.8% |
| Whisper Large Turbo | 93.8% |
| Parakeet 0.6B | 88.5% |
| Whisper Small | 89.4% |

### Spanish

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 96.0% |
| Whisper Large Turbo | 96.9% |
| Parakeet 0.6B | 97.4% |
| Whisper Small | 93.8% |

### Danish

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 85.8% |
| Whisper Large Turbo | 83.0% |
| Parakeet 0.6B | 80.2% |
| Whisper Small | 64.2% |

### Hungarian

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 91.9% |
| Whisper Large Turbo | 87.5% |
| Parakeet 0.6B | 91.9% |
| Whisper Small | 63.2% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 277 ms |
| Whisper Large Turbo | 224 ms |
| Parakeet 0.6B | 41 ms |
| Whisper Small | 138 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 129 ms |
| Whisper Large Turbo | 89 ms |
| Parakeet 0.6B | 18 ms |
| Whisper Small | 51 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 118 ms |
| Whisper Large Turbo | 76 ms |
| Parakeet 0.6B | 15 ms |
| Whisper Small | 46 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 146 ms |
| Whisper Large Turbo | 105 ms |
| Parakeet 0.6B | 17 ms |
| Whisper Small | 56 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 148 ms |
| Whisper Large Turbo | 88 ms |
| Parakeet 0.6B | 16 ms |
| Whisper Small | 46 ms |
