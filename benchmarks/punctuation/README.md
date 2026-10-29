# Punctuation eval: does ekko-pnc improve hviske and Edda?

Evidence for "ekko-pnc opt-in: does it improve hviske and Edda?" (EmilLykke/codictate#85).
All 927 consumable FLEURS `da_dk` clips (manifest order, warmups skipped).

## Metric (reused by "ekko-v1-tiny + ekko-pnc: benchmark gate")

`score.py`, against FLEURS `raw_transcription` (cased, punctuated):

1. Tokens are whitespace words. Each is normalised (lowercase, every non-word character removed) only to align hypothesis to reference by Levenshtein; tokens that normalise to nothing are skipped.
2. Only **aligned, identical** words are scored, so WER differences don't leak in.
3. Per matched word: the mark after it (`.?!` = sentence end, unless the token is an abbreviation like `f.eks.`; `,` = comma) and whether its first letter is a capital.
4. Reported: sentence-end F1 (all, and mid-clip only, i.e. excluding the reference's last word), comma F1, capitalisation accuracy and F1, and doubled marks per 100 words (`,,`, `,.`, `..`).

## Variants

- `own`: raw engine output.
- `pnc`: `ekko-stt[pnc]==0.1.2` `Punctuator.__call__` on that output, exactly what the byte-parity port will do.
- `pncStrip`: the same after removing word-final `,.?!` (ekko-pnc's label set) from each word.

## Re-running

```
bun benchmarks/punctuation/dump-hyps.ts hviske-v5-tiny-q5_0 hviske.jsonl   # and edda-v0.2-q5_0
python -m venv .venv && .venv/bin/pip install "ekko-stt[pnc]==0.1.2"
.venv/bin/python -I benchmarks/punctuation/dump-tiny.py clips.jsonl tiny.jsonl   # clips.jsonl: {clipId, ref, refNorm} per line
.venv/bin/python -I benchmarks/punctuation/score.py $PWD/hviske.jsonl | python3 benchmarks/punctuation/report.py
```

`dump-hyps.ts` goes through the benchmark's `adapterFor`, so the crispasr argv is the app's (Edda on `nt-vad` with the Danish prompt). `results/*.scored.jsonl` keeps every clip's reference, `own`, `pnc` and `pncStrip` text.
