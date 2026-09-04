# STT Benchmark

Measures Word Error Rate (WER), Real-Time Factor (RTF), and peak memory (RSS) for Codictate's speech-to-text models.

## ASR Harnesses: one runnable, one archived

There is exactly one **runnable** ASR Harness, `crispasr`. `whisper-cli` was retired after the benchmark settled it (see `benchmarks/results/2026-08-17_15-15-49_crispasr-vs-whisper/`), and nothing builds it any more, so no new measurement under it is possible. `--harness whisper-cli` is rejected with an explanation rather than silently ignored.

The results in `benchmarks/results/` are frozen and are treated as read-only measured data:

| Run                                             | Harness in the file                            |
| ----------------------------------------------- | ---------------------------------------------- |
| `2026-05-08_07-56-46_main-model-comparison`     | pre-harness shape, migrated to `whisper-cli`   |
| `2026-05-09_10-12-34_tiny-base-triage`          | pre-harness shape, migrated to `whisper-cli`   |
| `2026-05-09_15-40-49_full-run-except-tiny-base` | pre-harness shape, migrated to `whisper-cli`   |
| `2026-08-17_15-15-49_crispasr-vs-whisper`       | `whisper-cli` and `crispasr`, keyed explicitly |

Those whisper-cli numbers can never be re-measured, so **two separate concepts** are kept apart in code, and conflating them again is how the archive gets silently dropped:

- **Runnable Harness** - `ASR_HARNESS_IDS` in `src/shared/asr-harness.ts`. What a new run may execute. Used for `--harness` validation and for building a run plan.
- **Archived Harness label** - `BENCHMARK_HARNESS_LABELS` in `stt/results-schema.ts`. What a Harness key in a result file may legitimately say. Append-only, and still contains `whisper-cli`. **Every read path must validate against this one**: parsing, migration, flattening, coverage, reporting, checkpoint resume, and `stt/charts.py`.

`stt/results-archive.manual.ts` reads the real run directories and fails if any archived whisper-cli bucket stops parsing, or if the sample cursors derived from them move. It is pinned to the seven runs that exist today, so it sits outside the default `bun test` run (hence the `.manual.ts` suffix) and CI never touches it. Run it with `bun test ./benchmarks/stt/results-archive.manual.ts`, and update its pinned run list and counts whenever a Benchmark Run is archived.

In reports and charts, rows from the shipping Harness carry a bare Model ID and every other archived Harness is tagged, so archived rows read as `Large V3 q5_0 [whisper-cli]`. A run spanning more than one Harness also gets an **ASR Harnesses** line in the report header naming which Harness the untagged rows came from. Parakeet and hviske ignore the selected Harness (their own helper, and crispasr's pinned `cohere` backend) and are always recorded under the Harness that actually produced them.

## Sample selection: the cursor

`--samples N` means **N clips this Speech Model has not been measured on before**, accumulated across runs. It is a delta, not a slice. Three runs of `--samples 400` measure clips 1-400, then 401-800, then 801-1200, so a long benchmark can be done in sessions and never repeats work.

Everything below follows from one fact: each dataset's manifest is a **deterministic ordered list**. `seededShuffle(..., 42)` in `scripts/build-manifests.ts` fixes the order, so "which clips has this Combination seen" is fully described by an integer offset into that list. No per-clip identity is stored, because none is needed - and the harness never kept any.

### The warmup reservation

The first **3 entries of every dataset's ordered manifest are reserved permanently**. They are replayed at the start of every (Speech Model, dataset) session so the model is warm, they are never scored, and they never advance the cursor. Warmups still run for every model in a multi-model run - that is what they are for - and for a checkpoint resume too, which is a fresh cold process.

Before the cursor existed, warmups came off the head of the requested slice, so every session would have burned three fresh clips warming up and scored the rest. That is what the reservation stops.

Consumable indices therefore start at manifest entry 3: cursor 0 is `manifest[3]`. The pools are 2617 and 2936 consumable clips for LibriSpeech `test-clean` / `test-other`, and 905 / 927 / 902 for FLEURS `es_419` / `da_dk` / `hu_hu`.

### Where the cursor comes from

It is **derived, never hand-maintained**. Every leaf in every run's `stt.json` records the range it measured:

```json
"sampleRange": {
  "startIndex": 397,
  "endIndex": 797,
  "manifestFingerprint": "905:c3fd7a9081e6bef6"
}
```

`[startIndex, endIndex)` is a half-open range of *consumable* indices, so `endIndex - startIndex` equals the leaf's `utteranceCount`. The cursor for one (Harness bucket, Speech Model, dataset) is the **deepest `endIndex` across every run whose fingerprint matches the manifest on disk**. `loadCoverage` in `stt/coverage.ts` does the scan and caches it to `benchmarks/.cache/results-scan.json`, keyed by each `stt.json`'s size and mtime; the run directories stay the source of truth and deleting the cache only costs a rescan.

The root aggregate `benchmarks/results/stt.json` is deliberately **not** read, exactly as coverage already ignored it. It is a merge of leaves that are already counted, so reading it would double-count them.

The cursor is per Speech Model, never global. Every model walks the same ordered list from the start, so a model at 800 and a model at 400 are compared on the same first 400 clips rather than on disjoint slices.

### The manifest fingerprint, and why a mismatch is fatal

The fingerprint is `<count>:<first 16 hex of sha256>` over the ordered clip ids joined by newlines, taken over the **whole** list including the reserved warmups. The count is in the token because it is the part a human can check by eye, and a pool that gained or lost clips is the likeliest cause of a mismatch.

If a stored fingerprint for a selected dataset is not the fingerprint on disk, **the run refuses to start**:

```
Error: the ordered clip list for "hu_hu" has changed since it was last measured.
  recorded ordering: 905:c3fd7a9081e6bef6  (2026-09-04_08-28-52_curated-400-wispr-comparison)
  ordering on disk:  902:1f0c4b7a9d2e5831
```

An offset into a list that has changed is not a shallower measurement of the same sample - it points at clips nobody chose. Restarting the cursor from zero would silently re-measure some clips and claim a depth over others, which is why this is fatal rather than a warning. Fix the dataset so the ordering matches, or archive those runs and re-derive the cursors deliberately.

### The plan preview

Every run prints its whole plan before transcribing anything, per model and dataset, because a delta is destructive by default:

```
--- Plan: 400 new clips per dataset (--samples, a delta from each cursor) ---
  [large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)

  400 clips to transcribe across 1 combination
```

`--plan-only` prints exactly that and exits, downloading nothing and writing nothing, so it is safe to run while another benchmark is in flight.

### Exhaustion

A dataset with fewer clips left than asked for runs what remains, records the true depth, and **continues to the next dataset**. Nothing throws and nothing wraps around:

```
  [large-v3-q5_0] hu_hu: cursor 850 -> 902 (clips 851-902 of 902 consumable, 52 of 400 requested - dataset exhausted, 0 remaining after)
  [large-v3-q5_0] hu_hu: cursor 902 -> 902 (nothing left: all 902 consumable clips measured)
```

### Running a corpus in sessions

Suppose you want `small-q5_1` and `large-v3-q5_0` measured on 1200 FLEURS Hungarian clips, an evening at a time.

```bash
# Session 1. Both models start wherever the archive left them - large-v3-q5_0 at 397 from
# the September run, small-q5_1 at 0 under crispasr - so check before committing an evening:
bun run bench:stt -- --plan-only --models small-q5_1,large-v3-q5_0 --splits none --languages hu_hu --samples 400
#   [small-q5_1]    hu_hu: cursor 0   -> 400 (clips 1-400   of 902 consumable, 502 remaining after)
#   [large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)

bun run bench:stt -- --name hu-session-1 --description "Hungarian, first 400 each" \
  --models small-q5_1,large-v3-q5_0 --splits none --languages hu_hu --samples 400

# Session 2. Same command, new name. Each model continues from its own cursor; neither
# re-transcribes a clip from session 1.
bun run bench:stt -- --name hu-session-2 --description "Hungarian, next 400 each" \
  --models small-q5_1,large-v3-q5_0 --splits none --languages hu_hu --samples 400

# Levelling up instead of adding on: bring both to exactly 800, whatever they are at now.
# Idempotent, so if the session dies at 03:00 you paste the same line again.
bun run bench:stt -- --name hu-to-800 --description "Hungarian, both models to 800" \
  --models small-q5_1,large-v3-q5_0 --splits none --languages hu_hu --to 800
```

An interrupted session leaves a `checkpoint.json`, the Run Plans under `_v2/`, and no `stt.json`. Finish it by **naming its run id**:

```bash
bun run bench:stt -- --resume 2026-09-04_08-17-28_hu-session-1
```

An orchestrator driving this as a batch stage finds that run id from the `batchId` its Run
Plan records (`--batch`), rather than re-issuing `--name`.

The run id is the directory name under `benchmarks/results/`, not the `--name` slug. Re-running the same `--name` no longer resumes - it is refused as a collision, with the `--resume` command to paste - because a name is not a run identity: two runs can share one, the interrupted one is not necessarily the newest, and the previous behaviour ("pick up the latest unfinished run") resumed whichever run it found regardless of which one the operator meant.

A resume **re-reads the Run Plan** each Combination was started with and rebuilds nothing from flags, so every selection-changing flag is refused by name: `--from --to --samples --limit --clips-per-dataset --dataset --datasets --languages --splits --model --models --seed --smoke`. (`--batch` and `--out` are deliberately allowed: they name the batch and the report location, not the clips.) It replays each Combination's reserved warmups - a resumed process is a fresh cold process - and re-transcribes **no** completed scored clip, including one recorded as `failed`: a recorded failure is a measurement, and re-running it would either double-count it or overwrite a real observation with a luckier one. Re-measuring on purpose is a new run with `--from`.

A completed run's name is still refused, and a completed run cannot be resumed.

### Re-measuring clips already measured: `--from`

`--samples` and `--to` can only ever push a cursor forward, which is what makes them safe and what makes them useless for one job: **verifying a fix in isolation**. If a timing change moves Hungarian WER from 22.9% to 21.4%, the cursor guarantees the second measurement used *different clips*, so the difference could be the fix or could be the sample.

`--from N` is the answer. It is an **explicit start index into the consumable range**, overriding every cursor for that run only. Index 0 is the first clip after the 3 reserved warmups, so `--from 0` starts at `manifest[3]`.

```bash
# Re-measure the same 400 clips this model was already measured on
bun run bench:stt -- --name verify-timing-fix --description "Re-measure clips 1-400 to isolate the timing fix" \
  --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --samples 400
```

**`--from` needs a depth flag.** `--from N --samples M` measures M clips starting at N; `--from N --to M` measures from N up to depth M. `--from 0 --samples 400` and `--from 0 --to 400` name the identical 400 clips. `--from` on its own is rejected rather than defaulting: it names a start and no end, and inventing one would pick a depth nobody asked for on the one path that re-spends clips.

It is refused in four cases, each a separate message:

| Refused | Why |
| --- | --- |
| a negative index | `--from` is an index, not a count; `0` is legal and `-1` is not |
| an index at or past a dataset's consumable count | Clamping is what makes it dangerous: `--from 5000` on the 902-clip `hu_hu` pool would measure nothing and record depth 902. The message names the dataset and its count |
| combined with `--resume` | A resume re-reads the Run Plan its run was started with, and `--from` would select different clips than that plan - and than the fingerprint recorded beside the Samples. Refused by name, along with the other twelve selection-changing flags |
| combined with the interactive picker | The picker only offers a delta from each cursor and overwrites the depth, so a typed `--from` would rewind a range nobody selected on screen. Pass `--models` (or `--no-tui`) to use `--from` |

**The plan preview makes a rewind impossible to miss.** It is not the ordinary line with different numbers: the arrow runs backwards, the flag is named beside the cursor it overrode, and the clips about to be spent a second time are counted out.

```
--- Plan: 400 clips per dataset from consumable index 0 (--from 0 --samples 400; the cursors are ignored for this run) ---
  [large-v3-q5_0] hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)

  REWIND: 1 combination will re-measure clips it has already been measured on. Nothing is deleted and no cursor moves backwards; the same clips are simply run again.

  400 clips to transcribe across 1 combination
```

Compare the same command without `--from`, which is the shape every other run prints:

```
--- Plan: 400 new clips per dataset (--samples, a delta from each cursor) ---
  [large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)

  400 clips to transcribe across 1 combination
```

**A rewind never lowers a cursor.** The cursor is the deepest `endIndex` across every run, so a rewound run is recorded exactly like any other and the maximum does the rest. Re-measuring `[0, 400)` over a cursor of 397 leaves it at **400**; re-measuring `[0, 200)` leaves it at **397**, untouched. The earlier run is not rewritten and nothing subtracts. `--from` starting *past* a cursor is not a rewind but is flagged too, as a `GAP`, because it would record a depth over clips nobody transcribed:

```
  [large-v3-q5_0] hu_hu: GAP --from 500 starts past cursor 397 (clips 501-600 of 902 consumable, leaving clips 398-500 unmeasured; cursor stays 397 because the prefix has a hole, deepest measured end 600)
```

**A gap does not advance the cursor.** The cursor is the length of the **contiguous** measured prefix, so `[0, 397)` plus `[500, 600)` is a cursor of 397 and a *deepest measured end* of 600 - two numbers, reported separately, because "measured 600 deep" over a list where 103 clips were never transcribed is a published claim about clips nobody has heard. The deepest measured end is a diagnostic: it never feeds continuation, aggregation, coverage or a published depth.

#### Worked example: verifying a fix by re-measuring the same range

`large-v3-q5_0` sits at cursor 397 on `hu_hu` from the September run, which scored 22.93% WER. A timing fix lands. To attribute a change to the fix rather than to a different sample:

```bash
# 1. Read off exactly which clips will be spent, and spend nothing.
bun run bench:stt -- --plan-only --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --to 397
#   [large-v3-q5_0] hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-397 of 902 consumable, 397 of them already measured; cursor ends at 397, never lower than 397)

# 2. Re-measure the identical 397 clips. --to 397 rather than --samples 397 so the range
#    matches the recorded one exactly, whatever the cursor happens to be.
bun run bench:stt -- --name hu-after-timing-fix --description "Clips 1-397 again, after the timing fix" \
  --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --to 397

# 3. Both runs now carry sampleRange {startIndex: 0, endIndex: 397} against the same
#    fingerprint, so the two WERs are the same 397 clips and the delta is the fix.
#    The cursor is still 397: nothing was consumed and nothing was lost.
bun run bench:stt -- --plan-only --models large-v3-q5_0 --splits none --languages hu_hu --samples 400
#   [large-v3-q5_0] hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)
```

Two runs at equal depth are a real case downstream: the website's benchmark reader gives an **equal-depth tie to the newer `runDate`**, so the re-measured run is the one that renders. `--aggregate` here does the same.

### Migrating the archive, and one deliberate hole

`sampleRange` was backfilled onto the seven archived runs by:

```bash
bun run benchmarks/scripts/backfill-sample-ranges.ts          # dry run
bun run benchmarks/scripts/backfill-sample-ranges.ts --write
```

The arithmetic: old sampling was `entries.slice(0, samples)` with the first `config.warmupCount` entries transcribed but not scored, and those are the same entries the cursor now reserves - so a leaf recording `utteranceCount: N` consumed consumable entries `[0, N)`. It is verified per leaf, not trusted: the recount for the ordering the run used must divide the recorded `wer` into a whole number of errors, and must equal the `referenceWords` already on the leaf. 196 of 296 leaves were filled that way, every one reconciling exactly.

**The other 100 leaves got no range on purpose.** LibriSpeech was drawn in filesystem-traversal order until d8b91ee ("use seeded shuffle for both", 2026-05-09), and three runs predate it:

- `2026-05-08_07-56-46_main-model-comparison`
- `2026-05-09_10-12-34_tiny-base-triage`
- `2026-05-09_15-40-49_full-run-except-tiny-base`

For those runs' `test-clean` and `test-other` leaves, `utteranceCount` maps to no offset in the seeded ordering - the clips they scored are scattered through today's list. Writing a range would claim those Combinations had measured clips they have never seen, which is unfixable; leaving the cursor at 0 only costs re-measurement. So **those (Speech Model, LibriSpeech split) cursors stay at 0 and will re-measure some clips they have already been scored on once.** The pools are 2620 and 2939 clips, so the waste is bounded and correctness is unaffected. FLEURS in those same three runs backfilled normally, and so did everything in the August and September runs - including the whisper-cli bucket of `2026-08-17_15-15-49_crispasr-vs-whisper`, which ran *after* d8b91ee and therefore does carry LibriSpeech cursors at 17.

A leaf with no `sampleRange` contributes nothing to any cursor. That is the rule the migration relies on, so never infer a depth from `utteranceCount`.

The coverage badge in the TUI shows both numbers, because they can legitimately disagree: `✓ measured 47, cursor 0` is a Combination that was measured 47 clips deep in an ordering nobody can index.

## Prerequisites

- **ffmpeg** - `brew install ffmpeg`
- **hf** - `pip install huggingface-hub`
- **Speech models** - auto-downloaded by the benchmark runner, or via the Codictate app (stored in `~/Library/Application Support/codictate/models/`)
- **Vendor binaries** - `bun run build:native` or `bun run scripts/pre-build.ts`

## Datasets

| Dataset                                                            | Language                | Purpose                                                  |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| [LibriSpeech](https://www.openslr.org/12) test-clean               | English                 | Standard WER benchmark (comparable to published numbers) |
| [LibriSpeech](https://www.openslr.org/12) test-other               | English                 | Harder/noisier speakers                                  |
| [FLEURS](https://huggingface.co/datasets/google/fleurs) test split | es, da, hu (expandable) | Multilingual WER                                         |

LibriSpeech downloads automatically. FLEURS downloads via `hf`.

## Usage

```bash
# Full run: download + convert + benchmark all models
bun run bench:stt -- --name full-run --description "Full benchmark of all models"

# Named run (results saved as 2026-05-09_12-00-00_tiny-base-triage)
bun run bench:stt -- --name tiny-base-triage --description "Triage tiny and base model families" --models tiny,tiny-q5_1,base,base-q5_1 --samples 50

# Single model, skip download
bun run bench:stt -- --name turbo-only --description "Test turbo model" --models large-v3-turbo-q5_0 --skip-download

# Subset of models + specific FLEURS languages (es, da, hu)
bun run bench:stt -- --name multilingual --description "Multilingual comparison" --models small-q5_1,large-v3-turbo-q5_0 --languages es_419,da_dk,hu_hu

# FLEURS only, no LibriSpeech - the only honest way to run a Danish-pinned model
bun run bench:stt -- --name hviske-danish --description "hviske on Danish only" --models hviske-v5-tiny-q5_0 --splits none --languages da_dk

# Quick test run with fewer samples
bun run bench:stt -- --name smoke --description "Quick smoke test" --samples 10

# See exactly which clips a run would measure, and run nothing
bun run bench:stt -- --plan-only --models large-v3-q5_0 --splits none --languages hu_hu --samples 400

# Add 400 more clips per dataset to whatever each model has already been measured on
bun run bench:stt -- --name deeper --description "Another 400 clips per dataset" --models small,small-q5_1 --samples 400

# Top every selected model up to depth 800, no matter where it started. Safe to re-run
bun run bench:stt -- --name to-800 --description "Every curated model to 800 clips" --models small-q5_1,large-v3-q5_0 --to 800

# Re-measure the SAME 400 clips a model was already measured on, to verify a fix in
# isolation. The only flag that can re-spend clips; the plan preview says REWIND
bun run bench:stt -- --name verify-timing-fix --description "Re-measure clips 1-400 to isolate the timing fix" --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --samples 400

# Benchmark all models, free disk space as each model finishes
bun run bench:stt -- --name full-run --description "All models, cleanup after" --offload-models

# Benchmark new models without re-downloading datasets
bun run bench:stt -- --name new-models --description "Test new quantizations" --models large-v3-q8_0,medium-q8_0 --skip-download --skip-convert

# Regenerate reports + charts for all runs
bun run bench:stt -- --report-only
```

## The same command in both harnesses

Two repositories measure the same clips against the same ordered manifests: the app's own harness here, and `dictation-product-benchmark` next door. The flags line up on purpose, so one command shape works in both.

| | `dictation-product-benchmark` (one external product) | `codictate` (its own Speech Models) |
| --- | --- | --- |
| entry point | `bun run benchmark -- ...` | `bun run benchmark -- ...`, or the original `bun run bench:stt -- ...` |
| preview, run nothing | `--dry-run` | `--plan-only` |
| depth as a delta | `--samples N` | `--samples N` |
| depth as a target | `--to N` | `--to N` |
| explicit start index | `--from N` | `--from N` |
| dataset choice | `--datasets test-clean,hu_hu` | `--splits test-clean` and `--languages hu_hu` |
| run name | `--name <slug>`, required for a new run | `--name <slug>`, required unless `--plan-only` |
| free-text note | `--configuration-note` or `--description` | `--description` or `--configuration-note` |
| model choice | none: the product is the subject | `--models <ids>`; omitting it opens the interactive picker |

Both spellings of the note flag are accepted in both repositories, so neither has to be retyped. Two differences are real and stay:

- **`codictate` requires the note, `dictation-product-benchmark` does not.** `codictate` writes it to `description` in `stt.json`, and the website renders that string as the run page's `<title>`, its meta and OpenGraph description, and the page lede. A blank one would publish a run page whose `<title>` opens on the separator with nothing in front of it, and an empty meta description, so it stays required rather than defaulted. `--plan-only` needs neither `--name` nor `--description`.
- **`codictate` has an interactive picker, `dictation-product-benchmark` has nothing to pick.** A multi-model harness offers a model list when `--models` is absent; a single-product harness has one subject. `--from` is refused on the picker path in `codictate`, because the picker only offers a delta from each cursor and would overwrite a typed depth.

### Re-measure the same 400 clips I already measured

```bash
# dictation-product-benchmark
bun run benchmark -- --name verify-timing-fix \
  --description "Re-measure clips 1-400 to isolate the timing fix" \
  --datasets hu_hu --from 0 --samples 400

# codictate
bun run benchmark -- --name verify-timing-fix \
  --description "Re-measure clips 1-400 to isolate the timing fix" \
  --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --samples 400
```

Both print the same rewind line, differing only in the model prefix `codictate` needs:

```
  hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
  [large-v3-q5_0] hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
```

Add `--plan-only` (here) or `--dry-run` (`dictation-product-benchmark`) to see that line and spend nothing.

## CLI Flags

| Flag               | Default            | Description                                                                                                     |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--harness`        | `crispasr`         | Comma-separated runnable ASR Harnesses. Only `crispasr` is runnable; a retired Harness is rejected, not ignored |
| `--name`           | **required**       | Slug appended to results directory, used as URL path on website                                                 |
| `--description`    | **required**       | Goal/context for this benchmark run (stored in stt.json, shown in report). `--configuration-note` is an accepted alias, so a command written for `dictation-product-benchmark` runs here unchanged. Not required by `--plan-only` |
| `--models`         | all                | Comma-separated model IDs (all 34 models if omitted)                                                            |
| `--samples`        | 200                | **A delta.** Clips per dataset this model has *not* been measured on yet. Mutually exclusive with `--to`         |
| `--to`             | -                  | **A target depth.** Run whatever is needed to reach depth N per dataset; a no-op where it is already reached     |
| `--from`           | -                  | **An explicit start index** into the consumable range, overriding every cursor for this run only. Index 0 is the first clip after the 3 reserved warmups. Needs `--samples` or `--to`; refused with a resume or the interactive picker. See [`--from`](#re-measuring-clips-already-measured---from) |
| `--plan-only`      | false              | Print the plan preview and exit. Downloads nothing, converts nothing, writes nothing                            |
| `--splits`         | all                | LibriSpeech splits (`test-clean,test-other`). `none` selects no LibriSpeech at all                              |
| `--languages`      | es_419,da_dk,hu_hu | FLEURS language codes. `none` selects no FLEURS at all                                                          |
| `--skip-download`  | false              | Skip dataset and model download step                                                                            |
| `--skip-convert`   | false              | Skip audio conversion step                                                                                      |
| `--offload-models` | false              | Delete downloaded models from disk after all benchmarks complete                                                |
| `--report-only`    | false              | Regenerate markdown from existing stt.json                                                                      |
| `--aggregate`      | false              | Merge every run's stt.json into `results/stt.json` and write the combined report at the results root            |
| `--resume`         | -                  | **A run id**, i.e. the directory name under `benchmarks/results/`. Finishes that run from the Run Plans it was started with. Refuses every selection-changing flag by name. See [the resume section](#running-a-corpus-in-sessions) |
| `--batch`          | -                  | The publication batch this run is a stage of. Recorded on each Run Plan and run record as `batchId`, which is how an orchestrator finds the run id it has to resume. Allowed on a resume |
| `--out`            | -                  | **An absolute directory.** An isolated results tree for this whole invocation - run directory, plans, records, checkpoint, report, charts, *and* the cursor scan and coverage it reads. Allowed on a resume |

An unknown flag now **stops the run** instead of being ignored: `--form 5` used to run with
every default in place, and the typo was invisible until the plan preview.

### `--out`: an isolated results tree

`--out /abs/path` relocates everything this invocation reads and writes. Both halves
matter: a run that wrote elsewhere but still read the production cursor would consume
production clips, which is the harm. So a run under `--out` starts from cursor 0 inside its
own tree, and is invisible to the production cursor, `--aggregate`, coverage and the
website unless something is pointed at it.

That is what makes SPEC §8's smoke exclusion enforceable here. Before it, five rehearsal
clips per dataset landed in `benchmarks/results/` as ordinary **completed** v2 records, fed
`pooledV2Leaves` and `poolSamples`, and advanced the very cursor the production batch would
then measure from.

A relative `--out` is refused rather than resolved: it would mean two different directories
depending on which shell typed it, and one of them is the production tree.

`--report-only` and `--aggregate` read whichever tree they are pointed at, defaulting to
`benchmarks/results/`.

`--skip-existing` **has been removed.** It skipped a whole (Harness, Speech Model, dataset) Combination that already had results at the requested depth, which was the closest thing to a cursor this benchmark had. The cursor replaces it exactly: nothing is ever re-run, so there is nothing to skip. Passing it now fails with that explanation rather than being silently ignored.

`--splits none` and `--languages none` are how a language-pinned Speech Model gets benchmarked on only the language it can decode: `hviske-v5-tiny-q5_0` transcribes as Danish whatever it is handed, so an English LibriSpeech split measures Danish decoding of English speech rather than the model. Run it with `--splits none --languages da_dk`, which writes a legal empty `librispeech: {}` into `stt.json`. Passing `none` to both is rejected - there would be nothing to benchmark.

`--aggregate` walks the run directories in chronological order, but **depth wins over recency**: a Benchmark Combination already merged at 200 utterances is kept when a later, shallower run only measured it at 20, so the aggregate never publishes the noisier number. A rejected result prints a `[WARN]` line naming the dataset, Harness, Model ID and both utterance counts, and the total number of rejections is printed at the end of the merge. Equal depth goes to the newer run.

## Output

- `benchmarks/results/<timestamp>_<name>/stt.json` - machine-readable results with hardware metadata. `config.sampleSize` is the **pooled unique scored clips** behind the run, not a claimed range width: a depth is only a depth if a Sample stands behind every clip of it. `config.sampleSelection` records the flag that was given, and each leaf carries its own `sampleRange`, its `wordErrors` and a pooled `speedV2` summary
- `benchmarks/results/<timestamp>_<name>/_v2/<dataset>__<harness>__<model>.plan.json` - the immutable **Run Plan**: the ordered clipIds this Combination selected, its reserved warmups, and the v2 fingerprint over the selection. Written once, before the first clip, and re-read by `--resume`
- `benchmarks/results/<timestamp>_<name>/_v2/<dataset>__<harness>__<model>.run.json` - the v2 **run record**: one `SampleMeasurementV2` per clip (`clipId`, `responseMs`, `wordErrors`, `referenceWords`, `isWarmup`, `overhead.timingRegime`), plus an explicit `status` of `completed` or `incomplete`. Rewritten atomically after **every scored clip**, so a killed run loses nothing. **Only completed records** feed the cursor, aggregation, coverage or publication - an incomplete one contributes nothing, not even the clips it finished
- `benchmarks/results/<timestamp>_<name>/report.md` - markdown report with charts
- `benchmarks/results/<timestamp>_<name>/*.png` - chart images
- Markdown table printed to stdout

### Pooling accuracy across datasets

Each result leaf carries `referenceWords` - the denominator its `wer` was divided by -
and `referenceChars` alongside any `cer`. Combine datasets by pooling:

```
pooled WER = sum(wordErrors) / sum(referenceWords)
```

An unweighted mean of per-dataset WERs is a different number and is not the accuracy of
the combined sample, so never publish one. The report, the ratings and `stt/charts.py` all
pool now - `benchmarks/stt/report.test.ts` pins a deliberately unbalanced two-dataset
fixture where the pooled answer is 11.5% and the averaged one 30.0%, and
`python3 benchmarks/stt/charts.py --self-check` (also `bun run bench:charts:check`) asserts
the same arithmetic on the Python side.

### Two speed numbers per leaf, and only one of them is publishable

Every v2 leaf carries both, they mean different things, and neither is ever substituted
for the other:

| field | meaning | published? |
| --- | --- | --- |
| `speedV2.wallRtf` | `responseMsPerAudioSec / 1000` over the **successful, speed-compatible** Samples - the provenance-filtered v2 measurement | yes, and only this |
| `meanRTF`, `totalWallSec`, `totalAudioSec` | **legacy v1**: session wall clock over audio, over **all** scored Samples, unfiltered | no, and shown tagged `(legacy)` where nothing else exists |

The legacy fields keep their v1 definition exactly, because every leaf in
`benchmarks/results/` carries them that way and can never be re-measured - redefining them
in place would make the archive incomparable to every new run, silently, since the field
name does not change. `dictation-product-benchmark` keeps the same v1 definition.

`speedV2.wallRtf` is read directly wherever one leaf's speed is shown (`report.ts` and
`charts.py` both go through the contract's no-fallback accessor, `publishableWallRtf`), and
the cross-condition figure pools `speedV2.responseMs / speedV2.audioDurationSec` - the same
pair, with the same inclusion rule, in both surfaces. An absent `wallRtf` means **"no
publishable v2 speed"**; it never means "use `meanRTF`". A row with none is drawn empty, or
labelled `(legacy)` from an explicitly legacy code path.

Samples withheld from the v2 ratio for want of timing provenance are counted in
`speedV2.speedExcludedCount` and **reported out loud** in the report header, the summary
cell and the chart caption - a bucket whose every Sample was withheld renders as `N/A`,
and without the count that reads as "never measured" rather than "measured and withheld". `wer * referenceWords` is the error count and
is always a whole number, which also makes any leaf checkable.

The denominators are optional on read, because the archived runs were written before the
field existed. Fill them in without re-running a model:

```bash
bun run benchmarks/scripts/backfill-reference-words.ts          # dry run
bun run benchmarks/scripts/backfill-reference-words.ts --write
```

It recounts the scored slice of each dataset at each depth and refuses to write a count
that does not divide the recorded rate into whole errors. Two sample orderings are tried,
because LibriSpeech was drawn in filesystem-traversal order until d8b91ee (2026-05-09) and
the three May runs predate the seeded shuffle; the ordering used is named in the output
whenever it is not the current one. That detection lives in `scripts/sample-ordering.ts`,
shared with `scripts/backfill-sample-ranges.ts` so the two migrations cannot disagree about
which ordering a run used.

## Adding Languages

FLEURS supports 102 languages. To add a language:

1. Find the FLEURS locale code (e.g., `fr_fr`, `de_de`, `it_it`)
2. Run with `--languages` flag: `bun run bench:stt -- --languages fr_fr,de_de`

The download script fetches only the test split (not full dataset).

## Models

34 models supported (33 Whisper + 1 Parakeet). Curated defaults:

| ID                     | Engine     | Size    | Notes                                           |
| ---------------------- | ---------- | ------- | ----------------------------------------------- |
| `small-q5_1`           | Whisper    | 181 MB  | Good accuracy                                   |
| `large-v3-turbo-q5_0`  | Whisper    | 574 MB  | Default, fast + accurate, bundled in `vendors/` |
| `large-v3-q5_0`        | Whisper    | 1100 MB | Most accurate                                   |
| `parakeet-tdt-0.6b-v3` | FluidAudio | 500 MB  | Fastest, macOS CoreML / Windows ONNX            |

Extended models span tiny through large-v3 in full/q5/q8 quantizations, with multilingual and English-only (.en) variants. Full catalog defined in `src/shared/speech-models.ts`. Missing models are auto-downloaded when benchmarking.

## Keeping the UI in sync

Run `bun benchmarks/stt/generate-ratings.ts` after benchmarking to regenerate `src/shared/model-ratings.ts`. The speed, accuracy, and languages bars in the model picker are derived from this file.

Ratings come from one ASR Harness, the shipping one by default, because they describe what users get. The script now refuses to write rather than emit a partial ratings file, which matters for the archive: the aggregate at `benchmarks/results/stt.json` measured 33 whisper Speech Models under whisper-cli and nothing under crispasr, so rating from it by default would have blanked all 33 bars in the model picker. Name the archived Harness to do it on purpose:

```bash
# Fails loudly, listing the 33 Speech Models that would be dropped
bun benchmarks/stt/generate-ratings.ts benchmarks/results/stt.json

# Rates from the archived whisper-cli measurements, with a warning
bun benchmarks/stt/generate-ratings.ts benchmarks/results/stt.json --harness=whisper-cli
```

The ratings currently shipping in `src/shared/model-ratings.ts` are whisper-cli measurements. Replacing them with crispasr numbers needs a full crispasr run across all 34 Speech Models, which has not happened yet - only 3 were covered by the comparison run.
