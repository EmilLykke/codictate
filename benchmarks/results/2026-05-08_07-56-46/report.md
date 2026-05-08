# STT Benchmark Report

- **Date:** 2026-05-08T07:56:46.176Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.4.1
- **Samples per dataset:** 200
- **Warmup utterances:** 3
- **Models tested:** 4

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | English (clean) | English (noisy) | Spanish | Danish | Hungarian |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Whisper Large | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 147 ms | 96.5% | 94.0% | 97.0% | 87.1% | 85.5% |
| Whisper Large Turbo | 574 MB | 798 MB | 801 MB | 805 MB | 105 ms | 96.2% | 93.8% | 96.8% | 85.4% | 83.5% |
| Parakeet 0.6B | 500 MB | 78 MB | 80 MB | 86 MB | 19 ms | 95.6% | 92.6% | 95.5% | 80.6% | 81.6% |
| Whisper Small | 181 MB | 473 MB | 477 MB | 482 MB | 58 ms | 94.9% | 91.1% | 94.1% | 64.3% | 59.4% |

## Charts

![Accuracy Comparison](accuracy-comparison.png)

![Accuracy vs Speed](speed-accuracy.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 96.5% |
| Whisper Large Turbo | 96.2% |
| Parakeet 0.6B | 95.6% |
| Whisper Small | 94.9% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 94.0% |
| Whisper Large Turbo | 93.8% |
| Parakeet 0.6B | 92.6% |
| Whisper Small | 91.1% |

### Spanish

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 97.0% |
| Whisper Large Turbo | 96.8% |
| Parakeet 0.6B | 95.5% |
| Whisper Small | 94.1% |

### Danish

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 87.1% |
| Whisper Large Turbo | 85.4% |
| Parakeet 0.6B | 80.6% |
| Whisper Small | 64.3% |

### Hungarian

| Model | Accuracy (%) |
| --- | --- |
| Whisper Large | 85.5% |
| Whisper Large Turbo | 83.5% |
| Parakeet 0.6B | 81.6% |
| Whisper Small | 59.4% |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 199 ms |
| Whisper Large Turbo | 165 ms |
| Parakeet 0.6B | 29 ms |
| Whisper Small | 92 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 163 ms |
| Whisper Large Turbo | 129 ms |
| Parakeet 0.6B | 24 ms |
| Whisper Small | 77 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 123 ms |
| Whisper Large Turbo | 88 ms |
| Parakeet 0.6B | 16 ms |
| Whisper Small | 47 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 139 ms |
| Whisper Large Turbo | 96 ms |
| Parakeet 0.6B | 17 ms |
| Whisper Small | 51 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Whisper Large | 141 ms |
| Whisper Large Turbo | 86 ms |
| Parakeet 0.6B | 16 ms |
| Whisper Small | 48 ms |
