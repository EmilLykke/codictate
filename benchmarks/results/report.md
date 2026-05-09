# STT Benchmark Report

**Description:** Aggregated results from all benchmark runs

- **Date:** 2026-05-09T18:43:45.817Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.4.1
- **Samples per dataset:** 200
- **Warmup utterances:** 3
- **Models tested:** 34

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | Avg Overall | Avg English | Avg Multilingual | English (clean) | English (noisy) | Spanish | Danish | Hungarian |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Base full | 142 MB | 330 MB | 334 MB | 343 MB | 57 ms | 69.1% | 91.2% | 54.4% | 91.8% | 90.6% | 88.4% | 39.5% | 35.3% |
| Base q5_1 | 57 MB | 214 MB | 219 MB | 227 MB | 57 ms | 68.7% | 90.3% | 54.3% | 90.8% | 89.9% | 88.9% | 37.6% | 36.4% |
| Base q8_0 | 78 MB | 243 MB | 247 MB | 256 MB | 57 ms | 69.0% | 91.2% | 54.2% | 92.4% | 90.1% | 88.6% | 38.4% | 35.5% |
| Base full en | 142 MB | 330 MB | 333 MB | 340 MB | 59 ms | 33.0% | 92.4% | -6.7% | 93.1% | 91.8% | 0.8% | -7.0% | -13.8% |
| Base q5_1 en | 57 MB | 215 MB | 217 MB | 225 MB | 58 ms | 33.7% | 92.4% | -5.3% | 92.7% | 92.1% | 3.8% | -9.6% | -10.2% |
| Base q8_0 en | 78 MB | 243 MB | 247 MB | 259 MB | 58 ms | 33.7% | 92.1% | -5.2% | 92.4% | 91.8% | 3.2% | -7.9% | -10.9% |
| Large V1 full | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 184 ms | 89.4% | 94.2% | 86.3% | 94.7% | 93.7% | 95.8% | 80.7% | 82.2% |
| Large V2 full | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 185 ms | 91.1% | 94.8% | 88.6% | 95.0% | 94.7% | 96.1% | 84.5% | 85.3% |
| Large V2 q5_0 | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 146 ms | 91.0% | 94.9% | 88.4% | 95.3% | 94.6% | 96.1% | 83.9% | 85.3% |
| Large V2 q8_0 | 1.5 GB | 2.5 GB | 2.5 GB | 2.6 GB | 154 ms | 91.1% | 94.9% | 88.6% | 95.0% | **94.9%** | 96.1% | 84.6% | 85.2% |
| Large V3 full | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 183 ms | **92.7%** | 95.0% | **91.1%** | **96.3%** | 93.8% | 96.5% | **87.3%** | **89.5%** |
| Large V3 q5_0 | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 146 ms | 92.3% | 94.9% | 90.6% | **96.3%** | 93.6% | 96.5% | 86.9% | 88.3% |
| Large V3 Turbo full | 1.5 GB | 1.9 GB | 1.9 GB | 1.9 GB | 109 ms | 91.5% | 95.1% | 89.1% | 95.4% | 94.7% | 96.7% | 83.2% | 87.4% |
| Large V3 Turbo q5_0 | 574 MB | 797 MB | 800 MB | 805 MB | 101 ms | 91.5% | 94.9% | 89.3% | 95.1% | 94.6% | **96.8%** | 84.5% | 86.5% |
| Large V3 Turbo q8_0 | 834 MB | 1.1 GB | 1.1 GB | 1.1 GB | 108 ms | 91.6% | **95.2%** | 89.2% | 95.5% | 94.8% | 96.7% | 83.2% | 87.5% |
| Medium full | 1.5 GB | 2.1 GB | 2.1 GB | 2.1 GB | 116 ms | 88.0% | 94.1% | 83.9% | 94.8% | 93.4% | 95.2% | 78.2% | 78.3% |
| Medium q5_0 | 514 MB | 1.1 GB | 1.1 GB | 1.1 GB | 99 ms | 87.8% | 94.3% | 83.5% | 95.3% | 93.3% | 95.2% | 77.1% | 78.2% |
| Medium q8_0 | 785 MB | 1.4 GB | 1.4 GB | 1.4 GB | 106 ms | 87.9% | 94.2% | 83.6% | 95.0% | 93.4% | 95.2% | 77.9% | 77.9% |
| Medium full en | 1.5 GB | 2.1 GB | 2.1 GB | 2.1 GB | 116 ms | 32.1% | 94.6% | -9.6% | 95.7% | 93.5% | 10.8% | -13.9% | -25.6% |
| Medium q5_0 en | 514 MB | 1.1 GB | 1.1 GB | 1.1 GB | 96 ms | 30.9% | 94.4% | -11.4% | 95.7% | 93.1% | 9.2% | -11.4% | -32.0% |
| Medium q8_0 en | 785 MB | 1.4 GB | 1.4 GB | 1.4 GB | 103 ms | 31.0% | 94.3% | -11.2% | 95.7% | 93.0% | 10.0% | -16.3% | -27.4% |
| Parakeet TDT v3 full | 500 MB | **78 MB** | **80 MB** | **84 MB** | **19 ms** | 89.1% | 94.2% | 85.6% | 95.7% | 92.7% | 94.4% | 78.0% | 84.5% |
| Small full | 466 MB | 804 MB | 807 MB | 812 MB | 59 ms | 81.2% | 93.1% | 73.3% | 94.3% | 92.0% | 94.0% | 64.2% | 61.8% |
| Small q5_1 | 181 MB | 473 MB | 476 MB | 481 MB | 58 ms | 80.8% | 93.5% | 72.4% | 94.5% | 92.4% | 93.8% | 63.6% | 59.8% |
| Small q8_0 | 252 MB | 555 MB | 558 MB | 566 MB | 58 ms | 81.0% | 93.1% | 73.0% | 94.1% | 92.1% | 94.0% | 63.9% | 61.0% |
| Small full en | 466 MB | 804 MB | 807 MB | 815 MB | 61 ms | 32.0% | 94.0% | -9.4% | 95.3% | 92.8% | 9.0% | -15.3% | -21.9% |
| Small q5_1 en | 181 MB | 472 MB | 475 MB | 482 MB | 62 ms | 30.1% | 94.2% | -12.6% | 95.4% | 93.0% | 5.7% | -17.2% | -26.3% |
| Small q8_0 en | 252 MB | 555 MB | 558 MB | 568 MB | 60 ms | 31.2% | 94.0% | -10.7% | 95.3% | 92.7% | 10.1% | -19.3% | -23.0% |
| Tiny full | 75 MB | 218 MB | 224 MB | 231 MB | 57 ms | 58.0% | 87.0% | 38.7% | 87.6% | 86.4% | 85.0% | 14.2% | 16.9% |
| Tiny q5_1 | **31 MB** | 151 MB | 157 MB | 165 MB | 58 ms | 56.5% | 86.5% | 36.5% | 87.1% | 86.0% | 83.5% | 14.4% | 11.7% |
| Tiny q8_0 | 42 MB | 168 MB | 174 MB | 180 MB | 57 ms | 57.6% | 87.0% | 38.0% | 87.2% | 86.8% | 85.0% | 11.2% | 17.9% |
| Tiny full en | 75 MB | 218 MB | 224 MB | 228 MB | 59 ms | 26.5% | 88.4% | -14.8% | 88.9% | 87.8% | -1.2% | -18.7% | -24.4% |
| Tiny q5_1 en | **31 MB** | 151 MB | 157 MB | 162 MB | 59 ms | 25.2% | 88.2% | -16.7% | 88.8% | 87.5% | -1.0% | -26.0% | -23.2% |
| Tiny q8_0 en | 42 MB | 168 MB | 173 MB | 181 MB | 58 ms | 24.7% | 88.6% | -17.9% | 89.1% | 88.1% | -2.3% | -20.7% | -30.7% |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Base full | 8 | 4 | 10 |
| Base q5_1 | 8 | 4 | 10 |
| Base q8_0 | 8 | 4 | 10 |
| Base full en | 8 | 1 | 1 |
| Base q5_1 en | 8 | 1 | 1 |
| Base q8_0 en | 8 | 1 | 1 |
| Large V1 full | 3 | 8 | 10 |
| Large V2 full | 3 | 8 | 10 |
| Large V2 q5_0 | 5 | 8 | 10 |
| Large V2 q8_0 | 4 | 8 | 10 |
| Large V3 full | 3 | 9 | 10 |
| Large V3 q5_0 | 5 | 9 | 10 |
| Large V3 Turbo full | 6 | 8 | 10 |
| Large V3 Turbo q5_0 | 6 | 8 | 10 |
| Large V3 Turbo q8_0 | 6 | 8 | 10 |
| Medium full | 6 | 8 | 10 |
| Medium q5_0 | 6 | 8 | 10 |
| Medium q8_0 | 6 | 8 | 10 |
| Medium full en | 6 | 1 | 1 |
| Medium q5_0 en | 7 | 1 | 1 |
| Medium q8_0 en | 6 | 1 | 1 |
| Parakeet TDT v3 full | 9 | 8 | 8 |
| Small full | 8 | 7 | 10 |
| Small q5_1 | 8 | 7 | 10 |
| Small q8_0 | 8 | 7 | 10 |
| Small full en | 8 | 1 | 1 |
| Small q5_1 en | 8 | 1 | 1 |
| Small q8_0 en | 8 | 1 | 1 |
| Tiny full | 8 | 2 | 10 |
| Tiny q5_1 | 8 | 2 | 10 |
| Tiny q8_0 | 8 | 2 | 10 |
| Tiny full en | 8 | 1 | 1 |
| Tiny q5_1 en | 8 | 1 | 1 |
| Tiny q8_0 en | 8 | 1 | 1 |

## Charts (All Models)

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
| Large V1 full | 94.7% |
| Large V2 full | 95.0% |
| Large V2 q5_0 | 95.3% |
| Large V2 q8_0 | 95.0% |
| Large V3 full | 96.3% |
| Large V3 q5_0 | 96.3% |
| Large V3 Turbo full | 95.4% |
| Large V3 Turbo q5_0 | 95.1% |
| Large V3 Turbo q8_0 | 95.5% |
| Medium full | 94.8% |
| Medium q5_0 | 95.3% |
| Medium q8_0 | 95.0% |
| Medium full en | 95.7% |
| Medium q5_0 en | 95.7% |
| Medium q8_0 en | 95.7% |
| Parakeet TDT v3 full | 95.7% |
| Small full | 94.3% |
| Small q5_1 | 94.5% |
| Small q8_0 | 94.1% |
| Small full en | 95.3% |
| Small q5_1 en | 95.4% |
| Small q8_0 en | 95.3% |
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
| Large V1 full | 93.7% |
| Large V2 full | 94.7% |
| Large V2 q5_0 | 94.6% |
| Large V2 q8_0 | 94.9% |
| Large V3 full | 93.8% |
| Large V3 q5_0 | 93.6% |
| Large V3 Turbo full | 94.7% |
| Large V3 Turbo q5_0 | 94.6% |
| Large V3 Turbo q8_0 | 94.8% |
| Medium full | 93.4% |
| Medium q5_0 | 93.3% |
| Medium q8_0 | 93.4% |
| Medium full en | 93.5% |
| Medium q5_0 en | 93.1% |
| Medium q8_0 en | 93.0% |
| Parakeet TDT v3 full | 92.7% |
| Small full | 92.0% |
| Small q5_1 | 92.4% |
| Small q8_0 | 92.1% |
| Small full en | 92.8% |
| Small q5_1 en | 93.0% |
| Small q8_0 en | 92.7% |
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
| Large V1 full | 95.8% |
| Large V2 full | 96.1% |
| Large V2 q5_0 | 96.1% |
| Large V2 q8_0 | 96.1% |
| Large V3 full | 96.5% |
| Large V3 q5_0 | 96.5% |
| Large V3 Turbo full | 96.7% |
| Large V3 Turbo q5_0 | 96.8% |
| Large V3 Turbo q8_0 | 96.7% |
| Medium full | 95.2% |
| Medium q5_0 | 95.2% |
| Medium q8_0 | 95.2% |
| Medium full en | 10.8% |
| Medium q5_0 en | 9.2% |
| Medium q8_0 en | 10.0% |
| Parakeet TDT v3 full | 94.4% |
| Small full | 94.0% |
| Small q5_1 | 93.8% |
| Small q8_0 | 94.0% |
| Small full en | 9.0% |
| Small q5_1 en | 5.7% |
| Small q8_0 en | 10.1% |
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
| Large V1 full | 80.7% |
| Large V2 full | 84.5% |
| Large V2 q5_0 | 83.9% |
| Large V2 q8_0 | 84.6% |
| Large V3 full | 87.3% |
| Large V3 q5_0 | 86.9% |
| Large V3 Turbo full | 83.2% |
| Large V3 Turbo q5_0 | 84.5% |
| Large V3 Turbo q8_0 | 83.2% |
| Medium full | 78.2% |
| Medium q5_0 | 77.1% |
| Medium q8_0 | 77.9% |
| Medium full en | -13.9% |
| Medium q5_0 en | -11.4% |
| Medium q8_0 en | -16.3% |
| Parakeet TDT v3 full | 78.0% |
| Small full | 64.2% |
| Small q5_1 | 63.6% |
| Small q8_0 | 63.9% |
| Small full en | -15.3% |
| Small q5_1 en | -17.2% |
| Small q8_0 en | -19.3% |
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
| Large V1 full | 82.2% |
| Large V2 full | 85.3% |
| Large V2 q5_0 | 85.3% |
| Large V2 q8_0 | 85.2% |
| Large V3 full | 89.5% |
| Large V3 q5_0 | 88.3% |
| Large V3 Turbo full | 87.4% |
| Large V3 Turbo q5_0 | 86.5% |
| Large V3 Turbo q8_0 | 87.5% |
| Medium full | 78.3% |
| Medium q5_0 | 78.2% |
| Medium q8_0 | 77.9% |
| Medium full en | -25.6% |
| Medium q5_0 en | -32.0% |
| Medium q8_0 en | -27.4% |
| Parakeet TDT v3 full | 84.5% |
| Small full | 61.8% |
| Small q5_1 | 59.8% |
| Small q8_0 | 61.0% |
| Small full en | -21.9% |
| Small q5_1 en | -26.3% |
| Small q8_0 en | -23.0% |
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
| Large V1 full | 338 ms |
| Large V2 full | 341 ms |
| Large V2 q5_0 | 242 ms |
| Large V2 q8_0 | 263 ms |
| Large V3 full | 340 ms |
| Large V3 q5_0 | 242 ms |
| Large V3 Turbo full | 228 ms |
| Large V3 Turbo q5_0 | 181 ms |
| Large V3 Turbo q8_0 | 228 ms |
| Medium full | 227 ms |
| Medium q5_0 | 158 ms |
| Medium q8_0 | 202 ms |
| Medium full en | 228 ms |
| Medium q5_0 en | 156 ms |
| Medium q8_0 en | 207 ms |
| Parakeet TDT v3 full | 36 ms |
| Small full | 120 ms |
| Small q5_1 | 120 ms |
| Small q8_0 | 120 ms |
| Small full en | 121 ms |
| Small q5_1 en | 120 ms |
| Small q8_0 en | 121 ms |
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
| Large V1 full | 190 ms |
| Large V2 full | 191 ms |
| Large V2 q5_0 | 149 ms |
| Large V2 q8_0 | 157 ms |
| Large V3 full | 191 ms |
| Large V3 q5_0 | 142 ms |
| Large V3 Turbo full | 121 ms |
| Large V3 Turbo q5_0 | 105 ms |
| Large V3 Turbo q8_0 | 120 ms |
| Medium full | 125 ms |
| Medium q5_0 | 97 ms |
| Medium q8_0 | 108 ms |
| Medium full en | 124 ms |
| Medium q5_0 en | 98 ms |
| Medium q8_0 en | 108 ms |
| Parakeet TDT v3 full | 21 ms |
| Small full | 64 ms |
| Small q5_1 | 65 ms |
| Small q8_0 | 65 ms |
| Small full en | 65 ms |
| Small q5_1 en | 65 ms |
| Small q8_0 en | 64 ms |
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
| Large V1 full | 142 ms |
| Large V2 full | 146 ms |
| Large V2 q5_0 | 118 ms |
| Large V2 q8_0 | 127 ms |
| Large V3 full | 142 ms |
| Large V3 q5_0 | 120 ms |
| Large V3 Turbo full | 84 ms |
| Large V3 Turbo q5_0 | 83 ms |
| Large V3 Turbo q8_0 | 83 ms |
| Medium full | 90 ms |
| Medium q5_0 | 84 ms |
| Medium q8_0 | 84 ms |
| Medium full en | 89 ms |
| Medium q5_0 en | 73 ms |
| Medium q8_0 en | 71 ms |
| Parakeet TDT v3 full | 15 ms |
| Small full | 45 ms |
| Small q5_1 | 45 ms |
| Small q8_0 | 45 ms |
| Small full en | 47 ms |
| Small q5_1 en | 47 ms |
| Small q8_0 en | 45 ms |
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
| Large V1 full | 172 ms |
| Large V2 full | 171 ms |
| Large V2 q5_0 | 136 ms |
| Large V2 q8_0 | 145 ms |
| Large V3 full | 169 ms |
| Large V3 q5_0 | 140 ms |
| Large V3 Turbo full | 99 ms |
| Large V3 Turbo q5_0 | 99 ms |
| Large V3 Turbo q8_0 | 99 ms |
| Medium full | 102 ms |
| Medium q5_0 | 97 ms |
| Medium q8_0 | 99 ms |
| Medium full en | 115 ms |
| Medium q5_0 en | 102 ms |
| Medium q8_0 en | 104 ms |
| Parakeet TDT v3 full | 17 ms |
| Small full | 52 ms |
| Small q5_1 | 52 ms |
| Small q8_0 | 52 ms |
| Small full en | 58 ms |
| Small q5_1 en | 62 ms |
| Small q8_0 en | 56 ms |
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
| Large V1 full | 174 ms |
| Large V2 full | 174 ms |
| Large V2 q5_0 | 146 ms |
| Large V2 q8_0 | 148 ms |
| Large V3 full | 173 ms |
| Large V3 q5_0 | 145 ms |
| Large V3 Turbo full | 91 ms |
| Large V3 Turbo q5_0 | 88 ms |
| Large V3 Turbo q8_0 | 88 ms |
| Medium full | 107 ms |
| Medium q5_0 | 95 ms |
| Medium q8_0 | 95 ms |
| Medium full en | 98 ms |
| Medium q5_0 en | 89 ms |
| Medium q8_0 en | 91 ms |
| Parakeet TDT v3 full | 16 ms |
| Small full | 52 ms |
| Small q5_1 | 50 ms |
| Small q8_0 | 49 ms |
| Small full en | 52 ms |
| Small q5_1 en | 52 ms |
| Small q8_0 en | 52 ms |
| Tiny full | 48 ms |
| Tiny q5_1 | 48 ms |
| Tiny q8_0 | 47 ms |
| Tiny full en | 52 ms |
| Tiny q5_1 en | 54 ms |
| Tiny q8_0 en | 52 ms |
