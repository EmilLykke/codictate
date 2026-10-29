# ekko benchmark gate

Evidence for "ekko-v1-tiny + ekko-pnc: benchmark gate" (EmilLykke/codictate#78). Apple M4 Max, macOS, 2026-10-29.

ekko has no Speech Engine Adapter yet, so these scripts run the app path by hand, the way "ekko-v1-tiny: how to package parakeet.cpp" (#76) decided: `planVadSlices` from `vad-slices.ts` with its defaults (30 s cap), each slice written as 16 kHz mono WAV, one `parakeet-cli transcribe --json` (v0.6.1, macos-metal-arm64) per slice with `PARAKEET_ATT_CONTEXT=128`, text joined in order, word times shifted by the slice offset. GGUFs are from `RyeAI/ekko-v1-tiny` at `3658535e7b2fa98d5d9aad8114573c0fab1e6203`, sha256 checked against upstream LFS.

## Scripts

`EKKO_GATE_DIR` holds `bin/parakeet-v0.6.1-bin-macos-metal-arm64/parakeet-cli` and `model/ekko-v1-tiny-<quant>.gguf`.

- `bench.ts <quant> [metal|cpu]`: the 930 FLEURS `da_dk` clips in the order of the Edda run `2026-10-08_06-42-10_edda-v0-2-danish` (first 3 are warmups), WER and CER through the harness's own `computeWer`/`computeCer` against column 3, response time from reading the WAV to the last slice's exit, peak RSS from `/usr/bin/time -l`. Pooled like the harness: `sum(errors) / sum(reference words)`, `sum(response) / sum(audio)`.
- `long.ts <quant> <metal|cpu>`: `long-audio.manual.ts`'s Danish clips built the same way (`da_2min`, `da_5min`, `da_continuous_90s`), plus `da_60min`, plus the private 65 s dictation when present. Lost utterance = under 30% of its reference words heard in order. `startOff`/`endOff` = first/last aligned word's time minus the utterance's speech bounds (2% energy threshold, as in `long-audio.manual.ts`).
- Punctuation: `benchmarks/punctuation/score.py` from `task/ekko-pnc-opt-in-eval`, run on `results/q5_0-metal.jsonl` hypotheses with `ekko-stt[pnc]==0.1.2`.

## Results

`results/<quant>-metal.jsonl` (per clip, with word times), `results/long-{metal,cpu}/` (report and word times; the private dictation's transcript is not committed), `results/ekko-app.score.json`.
