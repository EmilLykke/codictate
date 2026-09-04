# STT Benchmark Report

**Description:** Aggregated results from all benchmark runs

- **Date:** 2026-09-04T09:44:33.459Z
- **Hardware:** Apple M4 Max / 36 GB / macOS 26.6.2
- **Samples per dataset:** 400
- **Warmup utterances:** 3
- **ASR Harnesses:** crispasr (untagged rows), whisper-cli (rows tagged `[whisper-cli]`)
- **Combinations tested:** 43

## Summary

| Model | Disk | Min Peak RSS | Avg Peak RSS | Max Peak RSS | Transcribe Time / sec Audio | Avg Overall | Avg English | Avg Multilingual | English (clean) | English (noisy) | Spanish | Danish | Hungarian | Avg Char Accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Base q5_1 [whisper-cli] | 57 MB | 214 MB | 219 MB | 227 MB | 57 ms | 68.7% | 90.3% | 54.3% | 90.8% | 89.9% | 88.9% | 37.6% | 36.4% | N/A |
| Base q8_0 [whisper-cli] | 78 MB | 243 MB | 247 MB | 256 MB | 57 ms | 69.0% | 91.2% | 54.2% | 92.4% | 90.1% | 88.6% | 38.4% | 35.5% | N/A |
| Base q5_1 en [whisper-cli] | 57 MB | 215 MB | 217 MB | 225 MB | 58 ms | 33.7% | 92.4% | -5.3% | 92.7% | 92.1% | 3.8% | -9.6% | -10.2% | N/A |
| Base q8_0 en [whisper-cli] | 78 MB | 243 MB | 247 MB | 259 MB | 58 ms | 33.7% | 92.1% | -5.2% | 92.4% | 91.8% | 3.2% | -7.9% | -10.9% | N/A |
| Base full en [whisper-cli] | 142 MB | 330 MB | 333 MB | 340 MB | 59 ms | 33.0% | 92.4% | -6.7% | 93.1% | 91.8% | 0.8% | -7.0% | -13.8% | N/A |
| Base full [whisper-cli] | 142 MB | 330 MB | 334 MB | 343 MB | 57 ms | 69.1% | 91.2% | 54.4% | 91.8% | 90.6% | 88.4% | 39.5% | 35.3% | N/A |
| Hviske V5 Tiny F16 full | 503 MB | 595 MB | 601 MB | 604 MB | 21 ms | 88.5% | - | 88.5% | - | - | - | 88.5% | - | 93.2% |
| Hviske V5 Tiny Q4 full | 153 MB | 248 MB | 253 MB | 256 MB | **16 ms** | 88.6% | - | 88.6% | - | - | - | 88.6% | - | 93.2% |
| Hviske V5 Tiny Q5 q5_0 | 181 MB | 300 MB | 305 MB | 308 MB | 18 ms | 88.9% | - | 88.9% | - | - | - | **88.9%** | - | 93.4% |
| Hviske V5 Tiny Q6 full | 232 MB | 327 MB | 332 MB | 336 MB | 17 ms | 88.3% | - | 88.3% | - | - | - | 88.3% | - | 93.2% |
| Hviske V5 Tiny Q8 q8_0 | 268 MB | 362 MB | 368 MB | 372 MB | 18 ms | 88.5% | - | 88.5% | - | - | - | 88.5% | - | 93.2% |
| Large V1 full [whisper-cli] | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 184 ms | 89.4% | 94.2% | 86.3% | 94.7% | 93.7% | 95.8% | 80.7% | 82.2% | N/A |
| Large V2 q5_0 [whisper-cli] | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 146 ms | 91.0% | 94.9% | 88.4% | 95.3% | 94.6% | 96.1% | 83.9% | 85.3% | N/A |
| Large V2 q8_0 [whisper-cli] | 1.5 GB | 2.5 GB | 2.5 GB | 2.6 GB | 154 ms | 91.1% | 94.9% | 88.6% | 95.0% | 94.9% | 96.1% | 84.6% | 85.2% | N/A |
| Large V2 full [whisper-cli] | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 185 ms | 91.1% | 94.8% | 88.6% | 95.0% | 94.7% | 96.1% | 84.5% | 85.3% | N/A |
| Large V3 q5_0 | 1.1 GB | 1.5 GB | 1.5 GB | 1.5 GB | 99 ms | 92.3% | **96.0%** | 89.8% | **96.8%** | **95.2%** | **97.2%** | 87.1% | 85.2% | **96.0%** |
| Large V3 q5_0 [whisper-cli] | 1.1 GB | 2.0 GB | 2.0 GB | 2.0 GB | 147 ms | 92.0% | 95.2% | 89.9% | 96.5% | 94.0% | 97.0% | 87.1% | 85.5% | N/A |
| Large V3 Turbo q5_0 | 574 MB | 755 MB | 757 MB | 759 MB | 59 ms | 91.3% | 95.7% | 88.3% | 96.6% | 94.8% | 96.8% | 85.6% | 82.6% | 95.5% |
| Large V3 Turbo q5_0 [whisper-cli] | 574 MB | 798 MB | 801 MB | 805 MB | 105 ms | 91.2% | 95.0% | 88.6% | 96.2% | 93.8% | 96.8% | 85.4% | 83.5% | N/A |
| Large V3 Turbo q8_0 [whisper-cli] | 834 MB | 1.1 GB | 1.1 GB | 1.1 GB | 108 ms | 91.6% | 95.2% | 89.2% | 95.5% | 94.8% | 96.7% | 83.2% | 87.5% | N/A |
| Large V3 Turbo full [whisper-cli] | 1.5 GB | 1.9 GB | 1.9 GB | 1.9 GB | 109 ms | 91.5% | 95.1% | 89.1% | 95.4% | 94.7% | 96.7% | 83.2% | 87.4% | N/A |
| Large V3 full [whisper-cli] | 2.9 GB | 4.0 GB | 4.0 GB | 4.0 GB | 183 ms | **92.7%** | 95.0% | **91.1%** | 96.3% | 93.8% | 96.5% | 87.3% | **89.5%** | N/A |
| Medium q5_0 [whisper-cli] | 514 MB | 1.1 GB | 1.1 GB | 1.1 GB | 99 ms | 87.8% | 94.3% | 83.5% | 95.3% | 93.3% | 95.2% | 77.1% | 78.2% | N/A |
| Medium q8_0 [whisper-cli] | 785 MB | 1.4 GB | 1.4 GB | 1.4 GB | 106 ms | 87.9% | 94.2% | 83.6% | 95.0% | 93.4% | 95.2% | 77.9% | 77.9% | N/A |
| Medium English q5_0 en | 514 MB | 830 MB | 832 MB | 834 MB | 60 ms | 67.5% | 94.3% | 13.7% | 95.0% | 93.6% | 13.7% | - | - | 42.2% |
| Medium English q5_0 en [whisper-cli] | 514 MB | 1.1 GB | 1.1 GB | 1.1 GB | 96 ms | 30.9% | 94.4% | -11.4% | 95.7% | 93.1% | 9.2% | -11.4% | -32.0% | N/A |
| Medium q8_0 en [whisper-cli] | 785 MB | 1.4 GB | 1.4 GB | 1.4 GB | 103 ms | 31.0% | 94.3% | -11.2% | 95.7% | 93.0% | 10.0% | -16.3% | -27.4% | N/A |
| Medium full en [whisper-cli] | 1.5 GB | 2.1 GB | 2.1 GB | 2.1 GB | 116 ms | 32.1% | 94.6% | -9.6% | 95.7% | 93.5% | 10.8% | -13.9% | -25.6% | N/A |
| Medium full [whisper-cli] | 1.5 GB | 2.1 GB | 2.1 GB | 2.1 GB | 116 ms | 88.0% | 94.1% | 83.9% | 94.8% | 93.4% | 95.2% | 78.2% | 78.3% | N/A |
| Parakeet TDT v3 full | 500 MB | **78 MB** | **80 MB** | **86 MB** | 20 ms | 89.3% | 95.2% | 85.4% | 96.1% | 94.4% | 94.3% | 80.6% | 81.3% | 93.9% |
| Small q5_1 | 181 MB | 382 MB | 383 MB | 386 MB | 30 ms | 79.8% | 93.2% | 70.9% | 95.4% | 91.1% | 93.8% | 62.5% | 56.3% | 89.0% |
| Small q5_1 [whisper-cli] | 181 MB | 473 MB | 477 MB | 482 MB | 58 ms | 80.8% | 93.0% | 72.6% | 94.9% | 91.1% | 94.1% | 64.3% | 59.4% | N/A |
| Small q8_0 [whisper-cli] | 252 MB | 555 MB | 558 MB | 566 MB | 58 ms | 81.0% | 93.1% | 73.0% | 94.1% | 92.1% | 94.0% | 63.9% | 61.0% | N/A |
| Small English q5_1 en [whisper-cli] | 181 MB | 472 MB | 475 MB | 482 MB | 62 ms | 30.1% | 94.2% | -12.6% | 95.4% | 93.0% | 5.7% | -17.2% | -26.3% | N/A |
| Small q8_0 en [whisper-cli] | 252 MB | 555 MB | 558 MB | 568 MB | 60 ms | 31.2% | 94.0% | -10.7% | 95.3% | 92.7% | 10.1% | -19.3% | -23.0% | N/A |
| Small full en [whisper-cli] | 466 MB | 804 MB | 807 MB | 815 MB | 61 ms | 32.0% | 94.0% | -9.4% | 95.3% | 92.8% | 9.0% | -15.3% | -21.9% | N/A |
| Small full [whisper-cli] | 466 MB | 804 MB | 807 MB | 812 MB | 59 ms | 81.2% | 93.1% | 73.3% | 94.3% | 92.0% | 94.0% | 64.2% | 61.8% | N/A |
| Tiny q5_1 [whisper-cli] | **31 MB** | 151 MB | 157 MB | 165 MB | 58 ms | 56.5% | 86.5% | 36.5% | 87.1% | 86.0% | 83.5% | 14.4% | 11.7% | N/A |
| Tiny q8_0 [whisper-cli] | 42 MB | 168 MB | 174 MB | 180 MB | 57 ms | 57.6% | 87.0% | 38.0% | 87.2% | 86.8% | 85.0% | 11.2% | 17.9% | N/A |
| Tiny q5_1 en [whisper-cli] | **31 MB** | 151 MB | 157 MB | 162 MB | 59 ms | 25.2% | 88.2% | -16.7% | 88.8% | 87.5% | -1.0% | -26.0% | -23.2% | N/A |
| Tiny q8_0 en [whisper-cli] | 42 MB | 168 MB | 173 MB | 181 MB | 58 ms | 24.7% | 88.6% | -17.9% | 89.1% | 88.1% | -2.3% | -20.7% | -30.7% | N/A |
| Tiny full en [whisper-cli] | 75 MB | 218 MB | 224 MB | 228 MB | 59 ms | 26.5% | 88.4% | -14.8% | 88.9% | 87.8% | -1.2% | -18.7% | -24.4% | N/A |
| Tiny full [whisper-cli] | 75 MB | 218 MB | 224 MB | 231 MB | 57 ms | 58.0% | 87.0% | 38.7% | 87.6% | 86.4% | 85.0% | 14.2% | 16.9% | N/A |

## Ratings (1-10)

| Model | Speed | Accuracy | Languages |
| --- | --- | --- | --- |
| Base q5_1 [whisper-cli] | 9 | 5 | 10 |
| Base q8_0 [whisper-cli] | 9 | 5 | 10 |
| Base q5_1 en [whisper-cli] | 9 | 1 (9 en) | 1 |
| Base q8_0 en [whisper-cli] | 9 | 1 (9 en) | 1 |
| Base full en [whisper-cli] | 8 | 1 (9 en) | 1 |
| Base full [whisper-cli] | 9 | 5 | 10 |
| Hviske V5 Tiny F16 full | 9 | 9 | 1 |
| Hviske V5 Tiny Q4 full | 10 | 9 | 1 |
| Hviske V5 Tiny Q5 q5_0 | 10 | 9 | 1 |
| Hviske V5 Tiny Q6 full | 10 | 9 | 1 |
| Hviske V5 Tiny Q8 q8_0 | 10 | 9 | 1 |
| Large V1 full [whisper-cli] | 5 | 9 | 10 |
| Large V2 q5_0 [whisper-cli] | 6 | 9 | 10 |
| Large V2 q8_0 [whisper-cli] | 6 | 9 | 10 |
| Large V2 full [whisper-cli] | 5 | 9 | 10 |
| Large V3 q5_0 | 7 | 9 | 10 |
| Large V3 q5_0 [whisper-cli] | 6 | 9 | 10 |
| Large V3 Turbo q5_0 | 8 | 9 | 10 |
| Large V3 Turbo q5_0 [whisper-cli] | 7 | 9 | 10 |
| Large V3 Turbo q8_0 [whisper-cli] | 7 | 9 | 10 |
| Large V3 Turbo full [whisper-cli] | 7 | 9 | 10 |
| Large V3 full [whisper-cli] | 5 | 10 | 10 |
| Medium q5_0 [whisper-cli] | 7 | 9 | 10 |
| Medium q8_0 [whisper-cli] | 7 | 9 | 10 |
| Medium English q5_0 en | 8 | 4 (10 en) | 1 |
| Medium English q5_0 en [whisper-cli] | 8 | 1 (10 en) | 1 |
| Medium q8_0 en [whisper-cli] | 7 | 1 (10 en) | 1 |
| Medium full en [whisper-cli] | 7 | 1 (10 en) | 1 |
| Medium full [whisper-cli] | 7 | 9 | 10 |
| Parakeet TDT v3 full | 9 | 9 | 8 |
| Small q5_1 | 9 | 7 | 10 |
| Small q5_1 [whisper-cli] | 9 | 7 | 10 |
| Small q8_0 [whisper-cli] | 8 | 7 | 10 |
| Small English q5_1 en [whisper-cli] | 8 | 1 (10 en) | 1 |
| Small q8_0 en [whisper-cli] | 8 | 1 (10 en) | 1 |
| Small full en [whisper-cli] | 8 | 1 (10 en) | 1 |
| Small full [whisper-cli] | 8 | 7 | 10 |
| Tiny q5_1 [whisper-cli] | 9 | 2 | 10 |
| Tiny q8_0 [whisper-cli] | 9 | 3 | 10 |
| Tiny q5_1 en [whisper-cli] | 8 | 1 (9 en) | 1 |
| Tiny q8_0 en [whisper-cli] | 8 | 1 (9 en) | 1 |
| Tiny full en [whisper-cli] | 8 | 1 (9 en) | 1 |
| Tiny full [whisper-cli] | 9 | 3 | 10 |

## Charts (All Models)

![Accuracy Comparison](accuracy-comparison.png)

![Speed Comparison](speed-comparison.png)

![Average Accuracy](accuracy-averages.png)

![Character Accuracy](cer-comparison.png)

## Accuracy by Condition

### English (clean)

| Model | Accuracy (%) |
| --- | --- |
| Base q5_1 [whisper-cli] | 90.8% |
| Base q8_0 [whisper-cli] | 92.4% |
| Base q5_1 en [whisper-cli] | 92.7% |
| Base q8_0 en [whisper-cli] | 92.4% |
| Base full en [whisper-cli] | 93.1% |
| Base full [whisper-cli] | 91.8% |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 94.7% |
| Large V2 q5_0 [whisper-cli] | 95.3% |
| Large V2 q8_0 [whisper-cli] | 95.0% |
| Large V2 full [whisper-cli] | 95.0% |
| Large V3 q5_0 | 96.8% |
| Large V3 q5_0 [whisper-cli] | 96.5% |
| Large V3 Turbo q5_0 | 96.6% |
| Large V3 Turbo q5_0 [whisper-cli] | 96.2% |
| Large V3 Turbo q8_0 [whisper-cli] | 95.5% |
| Large V3 Turbo full [whisper-cli] | 95.4% |
| Large V3 full [whisper-cli] | 96.3% |
| Medium q5_0 [whisper-cli] | 95.3% |
| Medium q8_0 [whisper-cli] | 95.0% |
| Medium English q5_0 en | 95.0% |
| Medium English q5_0 en [whisper-cli] | 95.7% |
| Medium q8_0 en [whisper-cli] | 95.7% |
| Medium full en [whisper-cli] | 95.7% |
| Medium full [whisper-cli] | 94.8% |
| Parakeet TDT v3 full | 96.1% |
| Small q5_1 | 95.4% |
| Small q5_1 [whisper-cli] | 94.9% |
| Small q8_0 [whisper-cli] | 94.1% |
| Small English q5_1 en [whisper-cli] | 95.4% |
| Small q8_0 en [whisper-cli] | 95.3% |
| Small full en [whisper-cli] | 95.3% |
| Small full [whisper-cli] | 94.3% |
| Tiny q5_1 [whisper-cli] | 87.1% |
| Tiny q8_0 [whisper-cli] | 87.2% |
| Tiny q5_1 en [whisper-cli] | 88.8% |
| Tiny q8_0 en [whisper-cli] | 89.1% |
| Tiny full en [whisper-cli] | 88.9% |
| Tiny full [whisper-cli] | 87.6% |

### English (noisy)

| Model | Accuracy (%) |
| --- | --- |
| Base q5_1 [whisper-cli] | 89.9% |
| Base q8_0 [whisper-cli] | 90.1% |
| Base q5_1 en [whisper-cli] | 92.1% |
| Base q8_0 en [whisper-cli] | 91.8% |
| Base full en [whisper-cli] | 91.8% |
| Base full [whisper-cli] | 90.6% |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 93.7% |
| Large V2 q5_0 [whisper-cli] | 94.6% |
| Large V2 q8_0 [whisper-cli] | 94.9% |
| Large V2 full [whisper-cli] | 94.7% |
| Large V3 q5_0 | 95.2% |
| Large V3 q5_0 [whisper-cli] | 94.0% |
| Large V3 Turbo q5_0 | 94.8% |
| Large V3 Turbo q5_0 [whisper-cli] | 93.8% |
| Large V3 Turbo q8_0 [whisper-cli] | 94.8% |
| Large V3 Turbo full [whisper-cli] | 94.7% |
| Large V3 full [whisper-cli] | 93.8% |
| Medium q5_0 [whisper-cli] | 93.3% |
| Medium q8_0 [whisper-cli] | 93.4% |
| Medium English q5_0 en | 93.6% |
| Medium English q5_0 en [whisper-cli] | 93.1% |
| Medium q8_0 en [whisper-cli] | 93.0% |
| Medium full en [whisper-cli] | 93.5% |
| Medium full [whisper-cli] | 93.4% |
| Parakeet TDT v3 full | 94.4% |
| Small q5_1 | 91.1% |
| Small q5_1 [whisper-cli] | 91.1% |
| Small q8_0 [whisper-cli] | 92.1% |
| Small English q5_1 en [whisper-cli] | 93.0% |
| Small q8_0 en [whisper-cli] | 92.7% |
| Small full en [whisper-cli] | 92.8% |
| Small full [whisper-cli] | 92.0% |
| Tiny q5_1 [whisper-cli] | 86.0% |
| Tiny q8_0 [whisper-cli] | 86.8% |
| Tiny q5_1 en [whisper-cli] | 87.5% |
| Tiny q8_0 en [whisper-cli] | 88.1% |
| Tiny full en [whisper-cli] | 87.8% |
| Tiny full [whisper-cli] | 86.4% |

### Spanish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Base q5_1 [whisper-cli] | 88.9% | N/A |
| Base q8_0 [whisper-cli] | 88.6% | N/A |
| Base q5_1 en [whisper-cli] | 3.8% | N/A |
| Base q8_0 en [whisper-cli] | 3.2% | N/A |
| Base full en [whisper-cli] | 0.8% | N/A |
| Base full [whisper-cli] | 88.4% | N/A |
| Hviske V5 Tiny F16 full | - | N/A |
| Hviske V5 Tiny Q4 full | - | N/A |
| Hviske V5 Tiny Q5 q5_0 | - | N/A |
| Hviske V5 Tiny Q6 full | - | N/A |
| Hviske V5 Tiny Q8 q8_0 | - | N/A |
| Large V1 full [whisper-cli] | 95.8% | N/A |
| Large V2 q5_0 [whisper-cli] | 96.1% | N/A |
| Large V2 q8_0 [whisper-cli] | 96.1% | N/A |
| Large V2 full [whisper-cli] | 96.1% | N/A |
| Large V3 q5_0 | 97.2% | 98.2% |
| Large V3 q5_0 [whisper-cli] | 97.0% | N/A |
| Large V3 Turbo q5_0 | 96.8% | 97.9% |
| Large V3 Turbo q5_0 [whisper-cli] | 96.8% | N/A |
| Large V3 Turbo q8_0 [whisper-cli] | 96.7% | N/A |
| Large V3 Turbo full [whisper-cli] | 96.7% | N/A |
| Large V3 full [whisper-cli] | 96.5% | N/A |
| Medium q5_0 [whisper-cli] | 95.2% | N/A |
| Medium q8_0 [whisper-cli] | 95.2% | N/A |
| Medium English q5_0 en | 13.7% | 42.2% |
| Medium English q5_0 en [whisper-cli] | 9.2% | N/A |
| Medium q8_0 en [whisper-cli] | 10.0% | N/A |
| Medium full en [whisper-cli] | 10.8% | N/A |
| Medium full [whisper-cli] | 95.2% | N/A |
| Parakeet TDT v3 full | 94.3% | 96.4% |
| Small q5_1 | 93.8% | 96.8% |
| Small q5_1 [whisper-cli] | 94.1% | N/A |
| Small q8_0 [whisper-cli] | 94.0% | N/A |
| Small English q5_1 en [whisper-cli] | 5.7% | N/A |
| Small q8_0 en [whisper-cli] | 10.1% | N/A |
| Small full en [whisper-cli] | 9.0% | N/A |
| Small full [whisper-cli] | 94.0% | N/A |
| Tiny q5_1 [whisper-cli] | 83.5% | N/A |
| Tiny q8_0 [whisper-cli] | 85.0% | N/A |
| Tiny q5_1 en [whisper-cli] | -1.0% | N/A |
| Tiny q8_0 en [whisper-cli] | -2.3% | N/A |
| Tiny full en [whisper-cli] | -1.2% | N/A |
| Tiny full [whisper-cli] | 85.0% | N/A |

### Danish

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Base q5_1 [whisper-cli] | 37.6% | N/A |
| Base q8_0 [whisper-cli] | 38.4% | N/A |
| Base q5_1 en [whisper-cli] | -9.6% | N/A |
| Base q8_0 en [whisper-cli] | -7.9% | N/A |
| Base full en [whisper-cli] | -7.0% | N/A |
| Base full [whisper-cli] | 39.5% | N/A |
| Hviske V5 Tiny F16 full | 88.5% | 93.2% |
| Hviske V5 Tiny Q4 full | 88.6% | 93.2% |
| Hviske V5 Tiny Q5 q5_0 | 88.9% | 93.4% |
| Hviske V5 Tiny Q6 full | 88.3% | 93.2% |
| Hviske V5 Tiny Q8 q8_0 | 88.5% | 93.2% |
| Large V1 full [whisper-cli] | 80.7% | N/A |
| Large V2 q5_0 [whisper-cli] | 83.9% | N/A |
| Large V2 q8_0 [whisper-cli] | 84.6% | N/A |
| Large V2 full [whisper-cli] | 84.5% | N/A |
| Large V3 q5_0 | 87.1% | 94.3% |
| Large V3 q5_0 [whisper-cli] | 87.1% | N/A |
| Large V3 Turbo q5_0 | 85.6% | 93.9% |
| Large V3 Turbo q5_0 [whisper-cli] | 85.4% | N/A |
| Large V3 Turbo q8_0 [whisper-cli] | 83.2% | N/A |
| Large V3 Turbo full [whisper-cli] | 83.2% | N/A |
| Large V3 full [whisper-cli] | 87.3% | N/A |
| Medium q5_0 [whisper-cli] | 77.1% | N/A |
| Medium q8_0 [whisper-cli] | 77.9% | N/A |
| Medium English q5_0 en | - | N/A |
| Medium English q5_0 en [whisper-cli] | -11.4% | N/A |
| Medium q8_0 en [whisper-cli] | -16.3% | N/A |
| Medium full en [whisper-cli] | -13.9% | N/A |
| Medium full [whisper-cli] | 78.2% | N/A |
| Parakeet TDT v3 full | 80.6% | 91.8% |
| Small q5_1 | 62.5% | 84.5% |
| Small q5_1 [whisper-cli] | 64.3% | N/A |
| Small q8_0 [whisper-cli] | 63.9% | N/A |
| Small English q5_1 en [whisper-cli] | -17.2% | N/A |
| Small q8_0 en [whisper-cli] | -19.3% | N/A |
| Small full en [whisper-cli] | -15.3% | N/A |
| Small full [whisper-cli] | 64.2% | N/A |
| Tiny q5_1 [whisper-cli] | 14.4% | N/A |
| Tiny q8_0 [whisper-cli] | 11.2% | N/A |
| Tiny q5_1 en [whisper-cli] | -26.0% | N/A |
| Tiny q8_0 en [whisper-cli] | -20.7% | N/A |
| Tiny full en [whisper-cli] | -18.7% | N/A |
| Tiny full [whisper-cli] | 14.2% | N/A |

### Hungarian

| Model | Word Accuracy (%) | Char Accuracy (%) |
| --- | --- | --- |
| Base q5_1 [whisper-cli] | 36.4% | N/A |
| Base q8_0 [whisper-cli] | 35.5% | N/A |
| Base q5_1 en [whisper-cli] | -10.2% | N/A |
| Base q8_0 en [whisper-cli] | -10.9% | N/A |
| Base full en [whisper-cli] | -13.8% | N/A |
| Base full [whisper-cli] | 35.3% | N/A |
| Hviske V5 Tiny F16 full | - | N/A |
| Hviske V5 Tiny Q4 full | - | N/A |
| Hviske V5 Tiny Q5 q5_0 | - | N/A |
| Hviske V5 Tiny Q6 full | - | N/A |
| Hviske V5 Tiny Q8 q8_0 | - | N/A |
| Large V1 full [whisper-cli] | 82.2% | N/A |
| Large V2 q5_0 [whisper-cli] | 85.3% | N/A |
| Large V2 q8_0 [whisper-cli] | 85.2% | N/A |
| Large V2 full [whisper-cli] | 85.3% | N/A |
| Large V3 q5_0 | 85.2% | 95.4% |
| Large V3 q5_0 [whisper-cli] | 85.5% | N/A |
| Large V3 Turbo q5_0 | 82.6% | 94.7% |
| Large V3 Turbo q5_0 [whisper-cli] | 83.5% | N/A |
| Large V3 Turbo q8_0 [whisper-cli] | 87.5% | N/A |
| Large V3 Turbo full [whisper-cli] | 87.4% | N/A |
| Large V3 full [whisper-cli] | 89.5% | N/A |
| Medium q5_0 [whisper-cli] | 78.2% | N/A |
| Medium q8_0 [whisper-cli] | 77.9% | N/A |
| Medium English q5_0 en | - | N/A |
| Medium English q5_0 en [whisper-cli] | -32.0% | N/A |
| Medium q8_0 en [whisper-cli] | -27.4% | N/A |
| Medium full en [whisper-cli] | -25.6% | N/A |
| Medium full [whisper-cli] | 78.3% | N/A |
| Parakeet TDT v3 full | 81.3% | 93.5% |
| Small q5_1 | 56.3% | 85.7% |
| Small q5_1 [whisper-cli] | 59.4% | N/A |
| Small q8_0 [whisper-cli] | 61.0% | N/A |
| Small English q5_1 en [whisper-cli] | -26.3% | N/A |
| Small q8_0 en [whisper-cli] | -23.0% | N/A |
| Small full en [whisper-cli] | -21.9% | N/A |
| Small full [whisper-cli] | 61.8% | N/A |
| Tiny q5_1 [whisper-cli] | 11.7% | N/A |
| Tiny q8_0 [whisper-cli] | 17.9% | N/A |
| Tiny q5_1 en [whisper-cli] | -23.2% | N/A |
| Tiny q8_0 en [whisper-cli] | -30.7% | N/A |
| Tiny full en [whisper-cli] | -24.4% | N/A |
| Tiny full [whisper-cli] | 16.9% | N/A |

## Speed by Condition

### English (clean)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base q5_1 [whisper-cli] | 120 ms |
| Base q8_0 [whisper-cli] | 119 ms |
| Base q5_1 en [whisper-cli] | 119 ms |
| Base q8_0 en [whisper-cli] | 120 ms |
| Base full en [whisper-cli] | 120 ms |
| Base full [whisper-cli] | 120 ms |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 338 ms |
| Large V2 q5_0 [whisper-cli] | 242 ms |
| Large V2 q8_0 [whisper-cli] | 263 ms |
| Large V2 full [whisper-cli] | 341 ms |
| Large V3 q5_0 | 123 ms |
| Large V3 q5_0 [whisper-cli] | 199 ms |
| Large V3 Turbo q5_0 | 78 ms |
| Large V3 Turbo q5_0 [whisper-cli] | 165 ms |
| Large V3 Turbo q8_0 [whisper-cli] | 228 ms |
| Large V3 Turbo full [whisper-cli] | 228 ms |
| Large V3 full [whisper-cli] | 340 ms |
| Medium q5_0 [whisper-cli] | 158 ms |
| Medium q8_0 [whisper-cli] | 202 ms |
| Medium English q5_0 en | 63 ms |
| Medium English q5_0 en [whisper-cli] | 156 ms |
| Medium q8_0 en [whisper-cli] | 207 ms |
| Medium full en [whisper-cli] | 228 ms |
| Medium full [whisper-cli] | 227 ms |
| Parakeet TDT v3 full | 25 ms |
| Small q5_1 | 36 ms |
| Small q5_1 [whisper-cli] | 92 ms |
| Small q8_0 [whisper-cli] | 120 ms |
| Small English q5_1 en [whisper-cli] | 120 ms |
| Small q8_0 en [whisper-cli] | 121 ms |
| Small full en [whisper-cli] | 121 ms |
| Small full [whisper-cli] | 120 ms |
| Tiny q5_1 [whisper-cli] | 120 ms |
| Tiny q8_0 [whisper-cli] | 120 ms |
| Tiny q5_1 en [whisper-cli] | 120 ms |
| Tiny q8_0 en [whisper-cli] | 119 ms |
| Tiny full en [whisper-cli] | 120 ms |
| Tiny full [whisper-cli] | 120 ms |

### English (noisy)

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base q5_1 [whisper-cli] | 63 ms |
| Base q8_0 [whisper-cli] | 63 ms |
| Base q5_1 en [whisper-cli] | 63 ms |
| Base q8_0 en [whisper-cli] | 63 ms |
| Base full en [whisper-cli] | 63 ms |
| Base full [whisper-cli] | 63 ms |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 190 ms |
| Large V2 q5_0 [whisper-cli] | 149 ms |
| Large V2 q8_0 [whisper-cli] | 157 ms |
| Large V2 full [whisper-cli] | 191 ms |
| Large V3 q5_0 | 129 ms |
| Large V3 q5_0 [whisper-cli] | 163 ms |
| Large V3 Turbo q5_0 | 81 ms |
| Large V3 Turbo q5_0 [whisper-cli] | 129 ms |
| Large V3 Turbo q8_0 [whisper-cli] | 120 ms |
| Large V3 Turbo full [whisper-cli] | 121 ms |
| Large V3 full [whisper-cli] | 191 ms |
| Medium q5_0 [whisper-cli] | 97 ms |
| Medium q8_0 [whisper-cli] | 108 ms |
| Medium English q5_0 en | 82 ms |
| Medium English q5_0 en [whisper-cli] | 98 ms |
| Medium q8_0 en [whisper-cli] | 108 ms |
| Medium full en [whisper-cli] | 124 ms |
| Medium full [whisper-cli] | 125 ms |
| Parakeet TDT v3 full | 28 ms |
| Small q5_1 | 37 ms |
| Small q5_1 [whisper-cli] | 77 ms |
| Small q8_0 [whisper-cli] | 65 ms |
| Small English q5_1 en [whisper-cli] | 65 ms |
| Small q8_0 en [whisper-cli] | 64 ms |
| Small full en [whisper-cli] | 65 ms |
| Small full [whisper-cli] | 64 ms |
| Tiny q5_1 [whisper-cli] | 63 ms |
| Tiny q8_0 [whisper-cli] | 63 ms |
| Tiny q5_1 en [whisper-cli] | 63 ms |
| Tiny q8_0 en [whisper-cli] | 63 ms |
| Tiny full en [whisper-cli] | 63 ms |
| Tiny full [whisper-cli] | 63 ms |

### Spanish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base q5_1 [whisper-cli] | 44 ms |
| Base q8_0 [whisper-cli] | 44 ms |
| Base q5_1 en [whisper-cli] | 45 ms |
| Base q8_0 en [whisper-cli] | 45 ms |
| Base full en [whisper-cli] | 45 ms |
| Base full [whisper-cli] | 44 ms |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 142 ms |
| Large V2 q5_0 [whisper-cli] | 118 ms |
| Large V2 q8_0 [whisper-cli] | 127 ms |
| Large V2 full [whisper-cli] | 146 ms |
| Large V3 q5_0 | 81 ms |
| Large V3 q5_0 [whisper-cli] | 123 ms |
| Large V3 Turbo q5_0 | 47 ms |
| Large V3 Turbo q5_0 [whisper-cli] | 88 ms |
| Large V3 Turbo q8_0 [whisper-cli] | 83 ms |
| Large V3 Turbo full [whisper-cli] | 84 ms |
| Large V3 full [whisper-cli] | 142 ms |
| Medium q5_0 [whisper-cli] | 84 ms |
| Medium q8_0 [whisper-cli] | 84 ms |
| Medium English q5_0 en | 46 ms |
| Medium English q5_0 en [whisper-cli] | 73 ms |
| Medium q8_0 en [whisper-cli] | 71 ms |
| Medium full en [whisper-cli] | 89 ms |
| Medium full [whisper-cli] | 90 ms |
| Parakeet TDT v3 full | 17 ms |
| Small q5_1 | 24 ms |
| Small q5_1 [whisper-cli] | 47 ms |
| Small q8_0 [whisper-cli] | 45 ms |
| Small English q5_1 en [whisper-cli] | 47 ms |
| Small q8_0 en [whisper-cli] | 45 ms |
| Small full en [whisper-cli] | 47 ms |
| Small full [whisper-cli] | 45 ms |
| Tiny q5_1 [whisper-cli] | 44 ms |
| Tiny q8_0 [whisper-cli] | 44 ms |
| Tiny q5_1 en [whisper-cli] | 44 ms |
| Tiny q8_0 en [whisper-cli] | 44 ms |
| Tiny full en [whisper-cli] | 44 ms |
| Tiny full [whisper-cli] | 44 ms |

### Danish

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base q5_1 [whisper-cli] | 52 ms |
| Base q8_0 [whisper-cli] | 52 ms |
| Base q5_1 en [whisper-cli] | 55 ms |
| Base q8_0 en [whisper-cli] | 53 ms |
| Base full en [whisper-cli] | 55 ms |
| Base full [whisper-cli] | 52 ms |
| Hviske V5 Tiny F16 full | 21 ms |
| Hviske V5 Tiny Q4 full | 16 ms |
| Hviske V5 Tiny Q5 q5_0 | 18 ms |
| Hviske V5 Tiny Q6 full | 17 ms |
| Hviske V5 Tiny Q8 q8_0 | 18 ms |
| Large V1 full [whisper-cli] | 172 ms |
| Large V2 q5_0 [whisper-cli] | 136 ms |
| Large V2 q8_0 [whisper-cli] | 145 ms |
| Large V2 full [whisper-cli] | 171 ms |
| Large V3 q5_0 | 92 ms |
| Large V3 q5_0 [whisper-cli] | 139 ms |
| Large V3 Turbo q5_0 | 54 ms |
| Large V3 Turbo q5_0 [whisper-cli] | 96 ms |
| Large V3 Turbo q8_0 [whisper-cli] | 99 ms |
| Large V3 Turbo full [whisper-cli] | 99 ms |
| Large V3 full [whisper-cli] | 169 ms |
| Medium q5_0 [whisper-cli] | 97 ms |
| Medium q8_0 [whisper-cli] | 99 ms |
| Medium English q5_0 en | - |
| Medium English q5_0 en [whisper-cli] | 102 ms |
| Medium q8_0 en [whisper-cli] | 104 ms |
| Medium full en [whisper-cli] | 115 ms |
| Medium full [whisper-cli] | 102 ms |
| Parakeet TDT v3 full | 19 ms |
| Small q5_1 | 28 ms |
| Small q5_1 [whisper-cli] | 51 ms |
| Small q8_0 [whisper-cli] | 52 ms |
| Small English q5_1 en [whisper-cli] | 62 ms |
| Small q8_0 en [whisper-cli] | 56 ms |
| Small full en [whisper-cli] | 58 ms |
| Small full [whisper-cli] | 52 ms |
| Tiny q5_1 [whisper-cli] | 54 ms |
| Tiny q8_0 [whisper-cli] | 53 ms |
| Tiny q5_1 en [whisper-cli] | 53 ms |
| Tiny q8_0 en [whisper-cli] | 53 ms |
| Tiny full en [whisper-cli] | 53 ms |
| Tiny full [whisper-cli] | 53 ms |

### Hungarian

| Model | Transcribe Time / sec Audio |
| --- | --- |
| Base q5_1 [whisper-cli] | 47 ms |
| Base q8_0 [whisper-cli] | 47 ms |
| Base q5_1 en [whisper-cli] | 48 ms |
| Base q8_0 en [whisper-cli] | 48 ms |
| Base full en [whisper-cli] | 50 ms |
| Base full [whisper-cli] | 47 ms |
| Hviske V5 Tiny F16 full | - |
| Hviske V5 Tiny Q4 full | - |
| Hviske V5 Tiny Q5 q5_0 | - |
| Hviske V5 Tiny Q6 full | - |
| Hviske V5 Tiny Q8 q8_0 | - |
| Large V1 full [whisper-cli] | 174 ms |
| Large V2 q5_0 [whisper-cli] | 146 ms |
| Large V2 q8_0 [whisper-cli] | 148 ms |
| Large V2 full [whisper-cli] | 174 ms |
| Large V3 q5_0 | 93 ms |
| Large V3 q5_0 [whisper-cli] | 141 ms |
| Large V3 Turbo q5_0 | 52 ms |
| Large V3 Turbo q5_0 [whisper-cli] | 86 ms |
| Large V3 Turbo q8_0 [whisper-cli] | 88 ms |
| Large V3 Turbo full [whisper-cli] | 91 ms |
| Large V3 full [whisper-cli] | 173 ms |
| Medium q5_0 [whisper-cli] | 95 ms |
| Medium q8_0 [whisper-cli] | 95 ms |
| Medium English q5_0 en | - |
| Medium English q5_0 en [whisper-cli] | 89 ms |
| Medium q8_0 en [whisper-cli] | 91 ms |
| Medium full en [whisper-cli] | 98 ms |
| Medium full [whisper-cli] | 107 ms |
| Parakeet TDT v3 full | 17 ms |
| Small q5_1 | 28 ms |
| Small q5_1 [whisper-cli] | 48 ms |
| Small q8_0 [whisper-cli] | 49 ms |
| Small English q5_1 en [whisper-cli] | 52 ms |
| Small q8_0 en [whisper-cli] | 52 ms |
| Small full en [whisper-cli] | 52 ms |
| Small full [whisper-cli] | 52 ms |
| Tiny q5_1 [whisper-cli] | 48 ms |
| Tiny q8_0 [whisper-cli] | 47 ms |
| Tiny q5_1 en [whisper-cli] | 54 ms |
| Tiny q8_0 en [whisper-cli] | 52 ms |
| Tiny full en [whisper-cli] | 52 ms |
| Tiny full [whisper-cli] | 48 ms |
