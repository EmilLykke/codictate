# The benchmark-v2 contract

Two repositories measure the same clips and publish one comparison. `codictate` measures
its own Speech Models through its Speech Engine Adapter; `dictation-product-benchmark`
measures Wispr Flow through its user interface, because a shipped product cannot be
called. A third, `codicate-releases`, reads what they write.

Nothing in that arrangement fails loudly. Two harnesses can disagree about which clip a
number belongs to, about whether an interrupted run counts, about whether a rerun replaces
or adds, and about what "median response time" means, and every one of those disagreements
produces a plausible number and no error. This document is the agreement that stops them,
and `benchmarks/contract/` is the executable half of it: pure modules, no filesystem, no
clock, no globals, so both repositories can run the same code over injected data.

Read this first. Change this when a rule changes.

| | |
| --- | --- |
| Canonical code | `benchmarks/contract/` (`index.ts` is the public surface; its export set is pinned by `index.test.ts` rather than counted in prose) |
| Golden fixtures | `benchmarks/contract/fixtures/fingerprint-v2.json`, copied verbatim to `dictation-product-benchmark/tests/fixtures/` |
| v1 cursor and fingerprint | `benchmarks/stt/sample-cursor.ts` - still live, still different, never compared |
| v1 result shape | `benchmarks/stt/results-schema.ts` |

## Clip identity

A **clipId** is the audio file's corpus-relative POSIX path, relative to
`<codictate>/benchmarks/datasets`:

```
fleurs/da_dk/audio/test/12149430079508542992.wav
librispeech/wav/test-clean/1272-128104-0000.wav
```

It was chosen rather than invented. `portableAudioPath()` in
`dictation-product-benchmark/src/portable-paths.ts` already writes exactly this string
into every committed external run record, to keep the measuring machine out of the file,
and `benchmarks/scripts/build-manifests.ts` already builds the absolute paths it is
relative to. A third spelling would have to be reconciled with both.

- `\` normalises to `/`; a leading `./` or `/` is stripped; **interior `/./` and repeated
  slashes collapse**; a trailing slash goes. Every accepted spelling of one path has to
  become one string, or the same clip pools as two - which halves a measured depth and
  raises no error anywhere. Interior segments were *not* collapsed until this was found,
  and they were wrong identically in all three repositories, so nothing disagreed loudly
  enough to notice.
- `..` is refused, not resolved. A `..` means the caller built the path against a
  different root, and resolving it produces a plausible id for a clip outside the corpus.
- **Leading or trailing whitespace is refused, not trimmed** - on the whole string or on
  any segment. Deliberately the opposite of the usual advice: a POSIX file name may
  legitimately begin or end with a space, so trimming would either make a real file
  unaddressable or silently merge two genuinely different clips. A space *inside* a
  segment is a legal name and is left alone. Only the caller knows which it has, so the
  caller is made to say.
- A path outside the datasets root is refused. `portableAudioPath` falls back to the bare
  file name there, which is right for a readable record and wrong for identity: a bare
  `1272-128104-0000.wav` pools as a different clip from the same file named properly, so
  one clip gets counted twice.

### FLEURS identity is TSV column 1

FLEURS `test.tsv` columns are `id, file_name, raw_transcription, transcription,
num_samples, gender`. **Identity is column index 1, `file_name`.** Column 0 is a
*sentence* id, and FLEURS records several speakers per sentence, so it repeats:

| locale | recordings | distinct column-0 values |
| --- | --- | --- |
| `da_dk` | 930 | 350 |
| `es_419` | 908 | 348 |
| `hu_hu` | 905 | 348 |

Measured 2026-09-04 and asserted in `benchmarks/contract/fleurs-identity.manual.ts`.
Keying identity on column 0 collapses 930 Danish clips to 350: two thirds of a run reads
as duplicate measurements of clips already done, a resume skips them, and a pool keeps one
recording per sentence and discards the rest. The run finishes, the WER looks plausible,
and nothing anywhere says 580 clips were never transcribed.

Column 0 survives as `sentenceId` on the Sample, which is the right key for "did the model
get this *sentence* right across speakers". It is never identity, never a dedup key and
never a fingerprint input.

LibriSpeech utterance ids are already unique, and the clipId is still the relative wav
path: one derivation for both corpora means the pooling and resume code never asks which
dataset a clipId came from.

## Fingerprint v2

```ts
fingerprintV2(clipIds) = sha256(["benchmark-v2", ...uniqueInOrder(clipIds)].join("\n"))
                           .slice(0, 16)   // lowercase hex
```

No trailing newline, no JSON, no sorting. Each of those is load-bearing:

- **Plain text, not JSON**, because two JSON serialisers agree on the value and not on the
  bytes, and this value is compared across two repositories.
- **No sorting**, because plan order is what the fingerprint identifies. `["b","a"]` and
  `["a","b"]` are different plans over the same clips and must fingerprint differently.
- **De-duplicated, first occurrence kept**, so a fingerprint recomputed from a pooled clip
  set equals the plan's fingerprint. A plan itself is asserted duplicate-free separately.
- **16 hex characters**, because this is an equality token read aloud in error messages,
  not a signature. Same truncation as the v1 `manifestFingerprint`.

### The on-disk shape

```json
"fingerprintV2": { "version": "benchmark-v2", "value": "d28f996584b02f28" }
```

**Both repositories write exactly this.** The field name and the embedded version each
catch a different mistake. The field name is never `fingerprint`, so a v1
`manifestFingerprint` and a v2 fingerprint cannot land in the same slot and be compared as
strings. The embedded `version` travels with the value, which matters because a
fingerprint gets passed around detached from its record - inside a Run Plan, in an error
message, in a stage report - and a bare 16-hex string carries no clue which algorithm
produced it. A v3 gets a new field name *and* a new version string.

### It is not the v1 manifest fingerprint

| | v1 `manifestFingerprint` | v2 `fingerprintV2` |
| --- | --- | --- |
| shape | `905:0f1e2d3c4b5a6978` | `{ version, value }` |
| covers | a dataset's whole ordered pool, warmups included | the clips one plan measures |
| answers | "do my stored integer offsets still index into this list" | "did these two runs measure the same clips in the same order" |

Both stay live. They are never compared, and a v1 fingerprint field stays readable
forever.

**There are two mutually incomparable v1 formats, not one.** Codictate writes
`<count>:<16 hex>` (`3:efdb04c4041c2ba1`); `dictation-product-benchmark` writes
`sha256:<64 hex>` (`sha256:966cacb8b651...`). Each is a legacy ordering token for its own
repository's manifests. No v1 token is ever compared to the other repository's v1 token,
and neither is ever compared to a v2 fingerprint. Recorded in
`v1-leaf.ts::V1_FINGERPRINT_FORMATS`, because a comment asserting a single v1 format is how
someone eventually writes the comparison.

### Golden parity fixtures

`benchmarks/contract/fixtures/fingerprint-v2.json` holds seven cases with values computed
here and copied verbatim to `dictation-product-benchmark/tests/fixtures/`. The external
harness **asserts** against them and must never recompute or overwrite them: a fixture
that regenerates its own expectation cannot detect a parity bug, which is the only bug
these fixtures exist to find. A disagreement is a real defect to report, not a value to
update.

```
empty                    223d0698c3a11acc
single                   598545a60238693a
order-matters-a          6a4aee3d67640368
order-matters-b          fe6e1a10333a02a4
dedup                    fe6e1a10333a02a4   == order-matters-b
unicode                  6d715bef704237f2
real-fleurs-da-first-5   d28f996584b02f28
```

`real-fleurs-da-first-5` is column 1 of the first five `da_dk/test.tsv` data rows **in the
file's natural on-disk order**, not in the seeded shuffle order a Benchmark Run uses. The
shuffle (`seededShuffle(entries, 42)` in `benchmarks/scripts/build-manifests.ts`) is a
Codictate implementation detail and not part of this contract, and the fixture has to be
reproducible in the other repository with `head -5 test.tsv | cut -f2`. `da_dk/test.tsv`
has no header row, so row 1 is the first data row.

## Selection, resume and continuation

A **Run Plan** is written before the first clip and is immutable, in the type and at
runtime:

```
{ runId, batchId?, datasetId, harness, model, fromIndex, toIndex,
  orderedClipIds, warmupClipIds, fingerprintV2, createdAt }
```

`fromIndex` and `toIndex` are half-open indices into the dataset's ordered **consumable**
list - warmups excluded - the same space `SampleRange` uses in v1. A range past the end of
the pool is refused rather than clamped: by the time a plan is built the range is decided,
and a clamped plan fingerprints a selection nobody asked for. This is deliberately
stricter than `planRange` in `benchmarks/stt/sample-cursor.ts`, which turns an operator's
*demand* into a range and has to be forgiving.

**A plan read off disk is validated before it is trusted**, by the one canonical guard -
`isRunPlan`, `runPlanComplaints` and the asserting `assertRunPlanOnDisk(value, runId?)`.
Two hand-rolled validators is the drift that produced this defect class in the first
place, so both repositories use these.

The checks are semantic, not just structural, because every one of them is a way for a
plan to be well-typed and still wrong:

| refused | why |
| --- | --- |
| empty `orderedClipIds` | a zero-length list is what a truncated file looks like, and a plan naming no clips cannot be resumed |
| duplicate clipIds | the adapter would be invoked twice on one clip and the run would claim a depth it does not have |
| `fingerprintV2` not matching `fingerprintV2(orderedClipIds)` | the load-bearing one - a plan whose fingerprint no longer describes its own list lets a pooled read agree with a run it never matched |
| a v1-shaped or unversioned fingerprint | `<count>:<hex>` answers a different question and is never compared to a v2 value |
| `toIndex - fromIndex !== orderedClipIds.length` | the indices point somewhere the clips do not, so every cursor derived from them is wrong |
| a clip that is both warmed and scored | the model would be measured on a clip it had just seen |
| empty `runId`/`datasetId`/`harness`/`model`/`createdAt` | a plan that cannot say what it is cannot be resumed |
| a `runId` argument that disagrees with the plan's own | the wrong file was opened - a resume names its run and never settles for one that looks close enough |

**The on-disk plan is immutable, so a complaint never means "repair it".** It means the
file was edited, or truncated mid-write, or built against a corpus that has since moved.
Any of the three makes the recorded Samples unattributable, because the clip list they
were measured against is not the clip list on disk. Refusing is the only safe answer -
the same reasoning `manifestFingerprintConflicts` already uses for a changed v1 ordering.
Every complaint is reported at once, because a hand-edited plan usually has more than one.

A **zero-clip** plan is legal in memory and illegal on disk. In memory it is the honest
value for "this stage has nothing left to run"; on disk it is indistinguishable from a
half-written file. A stage with nothing to measure does not get a plan file written for it.

**Resume is explicit.** It loads the original plan by run id. It never searches for the
latest unfinished run, because the failure mode of that search is silent: it resumes the
wrong run and files a partial numerator against clips it never saw. Every
selection-changing flag is refused by name:

```
--from --to --samples --limit --clips-per-dataset
--dataset --datasets --languages --splits
--model --models --seed --smoke
```

Both repositories' spellings are on one list, so a command written for either harness is
refused by either. `--batch` and `--out` are deliberately **not** on it: `--batch` names
the batch whose stages are being resumed rather than the clips a stage measures, and the
orchestrator passes it on every invocation including the resuming ones; `--out` moves where
a report is written, not what was measured.

The check runs on the argv tokens, not on a parsed options object. A parser fills in
defaults, and once it has, "the operator passed `--samples 200`" is indistinguishable from
"`--samples` defaulted to 200".

**Overlap blocks a new run.** Starting a run that shares any clipId with a *compatible
incomplete* run fails with an error naming the incomplete run id and telling the operator
to resume or discard it. Two processes measuring one clip write two measurements of it, and
the newest-wins rule below would then decide which counts by timestamp - a coin flip
dressed as a policy. Overlap is computed on clipId **sets**, never on index ranges: two
plans over two datasets can share an index range and no clips.

**Warmups always replay.** Each resumed process replays its plan's whole warmup list,
whatever the records say, because it starts against a cold model. They are marked
`isWarmup: true` in the record, and excluded from `sampleCount`, from aggregation and from
the completed-scored-clip set. The exclusion has to hold in both directions:
completed-clip filtering that treated warmups as scored would stop them replaying, and
pooling that kept them would score the same three clips in every session of every run. A
clip can never be both warmed and scored by one plan.

**A completed scored clip is never re-transcribed** - including one whose recorded status
is `timeout` or `failed`. A recorded failure is a measurement: it is counted in
`failureCount`, and re-running it would either double-count it or overwrite a real
observation with a luckier one. Re-measuring on purpose is a new run with an explicit start
index, never a resume.

**Checkpoint atomically after every scored clip**: write `<file>.tmp` in the same
directory, `fsync` if available, then `rename` over the target. No batching. A batched
checkpoint is how a killed run loses clips it had already paid for.

## Cursor, maxMeasuredEnd, sampleCount

Three numbers that are easy to confuse and mean different things.

- **`cursor`** is the length of the **contiguous measured prefix** of the ordered plan. A
  gap does **not** advance it. Clips 0-99 and 200-299 measured is a cursor of 100, because
  "measured 300 deep" over a list where 100 clips were never transcribed is a published
  claim about clips nobody has heard. This is the only number that may be published as a
  depth, and the only one that feeds continuation.
- **`maxMeasuredEnd`** is one past the last measured clip, gaps included. **Not a cursor.**
  It exists because the two disagreeing is the useful signal - `cursor 100,
  maxMeasuredEnd 300` says a run died in the middle - and it never feeds aggregation,
  staging or a published depth.
- **`sampleCount`** is the number of **pooled unique scored clips**. Never a sum of slice
  sizes: a 4-clip run and an overlapping 3-clip run make 5 samples, not 7.

**Only completed runs count.** An incomplete run contributes nothing to the cursor, to
aggregation, to coverage, to staging or to publication - not even the clips it did finish.
It has not been checked against its plan, its last checkpoint may predate its last clip,
and it is a resume source rather than a measurement. `status: "completed" | "incomplete"`
is explicit on the record and never inferred from a sample count, because a run killed
after its last clip and before its footer has every Sample and is still not completed.

## Harness identity

Two harnesses take measurements, and the word "harness" means two different things in this
repository. Both senses were typed `string`, so they were assignable to each other.

| sense | values | where |
| --- | --- | --- |
| **Measuring Harness** - what ran the benchmark | `codictate`, `wispr-flow` | `RunRecordV2.harness`, `compatibilityKey`, `benchmarks/contract/harness.ts` |
| **ASR Harness** - the binary that executes a Speech Engine inside Codictate | `crispasr`, retired `whisper-cli` | `RecordedRange.harness`, the v1 results tree, ADR-0002 |

`RunRecordV2.harness` is now the closed union `MeasuringHarness`, so `harness: "crispasr"`
is a type error rather than a measurement filed under a harness that never ran it.

**The external product has two spellings, and every consumer must accept both.** A v2
record says `wispr-flow`; the v1 results tree keys leaves by ASR Harness label and an
external product has none, so its flattened leaf says `external-product`
(`V1_EXTERNAL_PRODUCT_LABEL`). An earlier version of the website reader knew only the
second while the external harness wrote the first, and the consequence was not an error:
the both-products test was effectively false forever, so the instrumentation-asymmetry
sentence never rendered on the one surface that shows both products. Use
`harness.ts::spansBothProducts` or `timing.ts::requiresAsymmetryLabel`; never compare
harness strings by hand.

## Pooling

Pooling **buckets** by compatibility, then keys by `clipId` inside each bucket.

```
compatibilityKey = (schemaVersion, harness, model, datasetId)
```

- **Within a bucket**, the **newest completed** measurement of a clip wins. Newest is
  `completedAt ?? startedAt`; ties break on the lexicographically greater `runId`. The
  tiebreak is determinism, not preference - two runs finishing in the same millisecond
  must pool to the same answer on every machine, or two readers publish two numbers from
  one archive. Replacement inside a bucket is the ordinary rerun case and is **never an
  error**.
- **Across buckets, nothing competes.** A `clipId` is dataset-scoped and deliberately
  **not** harness- or model-scoped: Wispr Flow and Codictate `large-v3-q5_0` both measure
  `fleurs/da_dk/audio/test/12149430079508542992.wav`, because measuring the same clips
  with both products is the whole point of the publication batch. Two measurements of one
  clip by two products are two facts, and there is no sense in which one is newer than the
  other. Treating that as a conflict - the first cut of this module threw on it - fails on
  the first pooled read of exactly the data this project exists to produce.
- **Disjoint continuations pool**: the union of the clips, in one bucket.
- **An overlapping rerun replaces only the matching clipIds.** The earlier run's other
  clips survive. This is what per-Sample records buy: v1's `--aggregate` could only keep
  the deeper leaf and discard the other run entirely, because an aggregate leaf has no
  clips to intersect.
- A **mislabelled `datasetId`** separates into its own bucket rather than silently joining
  the wrong series.
- A v1 aggregate leaf is skipped on its schema version. **A v1 leaf is never reinterpreted
  as v2 per-clip measurements** - there is no inverse.

`poolSamples(runs)` therefore returns `{ buckets, skippedRuns }`, buckets sorted by `key`,
each carrying its identity fields, its `samples`, its `replaced` list and its contributing
`runIds`.

A pool has no plan order. It spans runs with different orderings, and any order derived
from the inputs would change with the read order of a directory, so pooled samples come
back sorted by `clipId`. Order comes from a Run Plan; sums do not need one.

**Cross-dataset pooling happens above the buckets.** Pooled WER over `da_dk` plus `hu_hu`
for one Speech Model is `pooledWer(seriesSamples(result, series))`: the accuracy functions
take *leaves*, so the buckets' error counts and reference counts add up by construction.
`seriesSamples` flattens across dataset buckets of one `(harness, model)` only - safe
because a clipId carries its corpus, so two dataset buckets of one series cannot name the
same clip. Flattening across harnesses or models would put two measurements of one clip in
one list and count it twice.

### `compatibilityKey` has no ASR-Harness dimension, and that is a live constraint

`harness` in the key is the **measuring** harness - `codictate` or `wispr-flow`. It is not
Codictate's **ASR Harness**, which is the binary and CLI contract that executes a Speech
Engine (`crispasr`, and the retired `whisper-cli`; see
`docs/adr/0002-asr-harness-abstraction.md`). Those are two different dimensions and the
key only carries the first.

That is sound **only because exactly one ASR Harness is currently runnable.** With one
runnable Harness, every Codictate v2 measurement came from `crispasr`, so the dimension is
constant and a constant is not an identity. `benchmarks/stt/results-schema.ts` asserts the
premise rather than assuming it - `assertSingleRunnableAsrHarness()`, called at the top of
`pooledV2Leaves()` - so a second runnable Harness fails loudly instead of silently pooling
two ASR Harnesses as one series and publishing their average.

**If a second ASR Harness becomes runnable, `compatibilityKey` must grow a dimension**, and
both repositories must grow it together. Meeting this constraint here is the point: the
alternative is meeting it in a chart that pooled two Harnesses and looked fine. Note that
v1 already keys results by archived Harness label (`results-schema.ts`), so the v1 archive
keeps that distinction whatever v2 does.

### The schema-version key

The on-disk key is **`schemaVersion`** (camelCase, matching the archive's style); the
exported constant is `SCHEMA_VERSION = 2`. A reader may accept a record whose key is the
literal `SCHEMA_VERSION`, but only through `normalizeRunRecordV2`, which rewrites it
**before** the type guard runs. That combination - legible to a human, invisible to the
guard - is the dangerous one: the guard rejects the record, nothing is logged, and the run
vanishes from pooling while still sitting on disk. The canonical key wins if both are
present, and the alias is dropped rather than kept, so a normalised record cannot
round-trip the alias back to disk.

## Accuracy

```
WER = sum(wordErrors) / sum(referenceWords)
CER = sum(charErrors) / sum(referenceChars)
```

Pooled, never a mean of means. An unweighted mean of per-dataset rates weights a 908-clip
Spanish pool the same as a 5-clip smoke slice, so it is a different number from the one it
looks like and it is not the accuracy of the combined sample. `benchmarks/README.md` has
said so since `referenceWords` was added; `benchmarks/contract/aggregation.test.ts` pins a
deliberately unbalanced two-dataset fixture where the two answers are 10.4% and 30.0%, so
a regression fails a test instead of shipping a leaderboard.

**A leaf lacking a denominator is skipped, never treated as zero.** The runs written before
`referenceWords` existed have none on disk and can never be re-measured, so a reader loads
them and skips them; folding one in as zero errors over zero words is a perfect score for
a clip nobody scored. The same rule applies to counts: a missing `failures` means "not
counted", not zero, and it is the one field that could never be backfilled - nothing on
disk records which utterances failed. Every pooled rate returns its `errors`,
`references`, `leafCount` and `skippedCount` alongside the rate, because a pooled rate
over half the leaves is a different claim from one over all of them.

`errors` is always a whole number, which is what makes a published rate checkable by eye.

## Speed

```
responseMsPerAudioSec = sum(successful responseMs) / sum(successful audioDurationSec)
RTF_wall              = responseMsPerAudioSec / 1000
```

**Only successful Samples contribute.** A failure or a timeout has `responseMs: null`, and
`null` is not zero - zero would price a failure as an instant transcription, and excluding
a refused clip's audio from the denominator is what stops a product looking twice as fast
for having refused two clips. Failures and timeouts contribute to the counts and nothing
else.

Every pooled bucket exposes the whole `SpeedSummary`:

| field | meaning |
| --- | --- |
| `responseMsPerAudioSec` | the pooled ratio above, `null` when there is no audio |
| `wallRtf` | the published wall-clock RTF: `responseMsPerAudioSec / 1000` |
| `medianResponseMs` | raw response ms, successful only. Even count: the mean of the two middle values |
| `p90ResponseMs` | raw, successful only, **nearest-rank** on the sorted list |
| `attemptedCount` | scored Samples in the pool, whatever their status |
| `respondedCount` | successful: `status: "ok"` with a numeric `responseMs`, whatever its provenance |
| `speedExcludedCount` | responded Samples kept out of the ratio by the provenance rule below |
| `failureCount` | **every unsuccessful Sample, timeouts included** |
| `timeoutCount` | the timed-out **subset** of `failureCount` |
| `sampleCount` | pooled unique scored clips |

### The failure taxonomy is nested, not disjoint

`failureCount` is the total unsuccessful count and `timeoutCount` is a subset of it, so:

```
attemptedCount === respondedCount + failureCount
```

That invariant is asserted in `benchmarks/contract/aggregation.test.ts` on every fixture
shape. Nested rather than disjoint because it is what the v1 archive already means - a real
leaf carries `"failures": 1` beside `"failuresByStatus": {"timeout": 1, "failed": 0}` - and
reading the two as disjoint would silently change the meaning of every archived `failures`
number.

The counts are not decoration: `respondedCount < attemptedCount` is the whole story behind
a good-looking ratio. p90 is nearest-rank rather than interpolated because both
repositories have to produce the same number and interpolation invents a response time no
clip had. The median convention is spelled out for the same reason - "median" has two
conventions for an even count.

A `status: "ok"` Sample with a `null` `responseMs` is malformed, not fast: it is excluded
from the ratio *and* from `respondedCount`, exactly as a leaf with no denominator is
skipped. Because `failureCount` is defined as everything that did not respond, it lands
there and not in `timeoutCount`, and the invariant holds without a fourth counter.

### Speed provenance: which Samples may enter the ratio

A Flow Sample measured before the keydown-edge fix ran **~81-90 ms optimistic per clip**
(measured, not estimated), because its start timestamp was taken after `post(hotkey)`
returned and therefore excluded the modifier-to-key sleep. Those Samples are not
v2-compatible for speed. They stay readable as legacy and they are kept out of the pooled
number.

The predicate is `timing.ts::speedCompatible(sample)`, exported so the harnesses and the
website reader apply one rule instead of each inventing one. It is **regime-aware**, and
that is the whole difficulty: filtering on `hotkeyEdge`/`timingClock` alone would exclude
every *Codictate* Sample, because a direct adapter call has no hotkey to have an edge - a
naive filter silently zeroes out Codictate speed, the exact opposite of the defect being
fixed.

So the regime is mandated on the record, and the rule branches on it:

```
overhead.timingRegime: "direct-adapter" | "ui-observed-paste"    // mandated, both harnesses
overhead.hotkeyEdge:   "keydown" | <whatever else it was>        // UI-observed only
overhead.timingClock:  "monotonic" | <whatever else it was>      // UI-observed only
```

| regime | speed-compatible when |
| --- | --- |
| `direct-adapter` | always - there is no hotkey and no keystroke synthesis to mistime |
| `ui-observed-paste` | `hotkeyEdge === "keydown"` **and** `timingClock === "monotonic"` |
| absent or unknown | **never** |

**An absent `timingRegime` is incompatible, deliberately.** The alternative is to guess,
and the failure mode of guessing is publishing an ~85 ms-optimistic Flow number as though
it were comparable to a Codictate one - the defect this whole exercise exists to remove.
Excluding a Sample is recoverable: the clip is still in the corpus, it can be re-measured,
and it stays readable. Publishing a flattering wrong number is not recoverable, because it
is the number people quote.

**The filter applies to the speed numerator, the speed denominator and the raw
median/p90 list, and to nothing else.** An incompatible Sample was still attempted and
still responded, and its `wordErrors` are still a valid measurement of what the product
transcribed - the instrumentation defect moved a timestamp, not a transcript. So it stays
in `attemptedCount`, in `respondedCount`, in `sampleCount`, in accuracy pooling and in
coverage. `speedExcludedCount` reports how many were dropped, so a bucket cannot lose half
its speed data in silence; the ratio covers `respondedCount - speedExcludedCount` Samples.

`wallRtf` is derived from the **filtered** ratio. Deriving it from an unfiltered sum would
republish the excluded Samples' optimism under a different field name, which is the one
subtle way this could still leak.

### Two RTFs, and only one of them is published

**Wall-clock RTF is derived, not measured again.** `wallRtf = responseMsPerAudioSec / 1000`
needs no per-Sample field, and it lives in one function
(`timing.ts::wallRtfFromResponseRatio`) carried on the `SpeedSummary` so the report and
`benchmarks/stt/charts.py` cannot each derive their own. The chart script arithmetically
averaged per-dataset RTFs, which is a mean of means on the speed axis - the same defect the
accuracy rule already forbids - and it must compute exactly this instead.

**Inference RTF is a Codictate-only secondary diagnostic** and it *does* need a mandated
per-Sample field:

```
overhead.inferenceMs: number | null          // mandated for Codictate v2 records
RTF_inference = (sum(overhead.inferenceMs) / 1000) / sum(audioDurationSec)
```

`pooledInferenceRtf` computes it and **skips** Samples that do not report the field - never
zero, because zero inference time is not a fact about anything and would drag the
diagnostic down in proportion to how many Samples stayed quiet. It measures what happened
*inside* the adapter call, so it is **never comparable to a Wispr Flow number** - a
UI-observed paste has no inference boundary - and it never shares a column with `wallRtf`
or appears as the headline speed.

#### It is defined and currently unpopulated

**No Codictate adapter emits `inferenceMs` today.** A Speech Engine Adapter returns a
`TranscriptionResult` - `{ status, rawTranscript }` or a `FailedTranscription`, per
`docs/adr/0006-dictation-returns-an-outcome.md` - and that value carries no engine
inference duration. So Codictate writes the mandated field as `null`, every Sample is
skipped, and `pooledInferenceRtf` returns `rtf: null` with `leafCount: 0` in this
repository. The arithmetic is implemented and tested against fixtures that do carry a
value, which is the right state to leave it in: the moment an adapter reports a duration,
the diagnostic starts working with no contract change.

What must **not** happen in the meantime, and the reason this paragraph exists rather than
a quiet deletion:

- **Do not derive it from wall time.** A wall-clock number relabelled as inference time is
  the same class of error as the Flow start-timestamp bug - a measurement of one thing
  published as a measurement of another - and it would be harder to catch, because it
  looks right.
- **Do not invent a value**, and do not fall back to `responseMs`.
- **Do not drop the field.** A defined-and-empty diagnostic is honest and self-describing;
  removing it would mean re-litigating the mandate in both repositories later.

Nothing historical is lost by the gap: v1's `meanRTF` was always wall-clock, so there is
no inference-time series in the archive to be continuous with.

## The v2-on-v1 leaf

Both harnesses publish through the **v1 results tree**, because the website, the reports
and the charts read that tree and none of them is being rewritten for v2. So both write a
v1-shaped leaf carrying v2 numbers - and until now that shape lived in neither
repository's contract module. It diverged exactly as you would expect: Codictate wrote the
pooled speed summary as `speedV2`, the external harness wrote it as `speed`, nothing
asserted the name, `charts.py` read `speedV2`, found nothing on every external row, **fell
back to `meanRTF`**, and plotted a legacy differently-defined RTF at up to **28x the
contract value** beside Codictate's correctly-filtered number. One missing string
comparison; one published chart that was wrong for one of the two products it existed to
compare.

The shape is now pinned in `benchmarks/contract/v1-leaf.ts`, with a guard
(`isV2OnV1Leaf`, `v2OnV1LeafComplaints`, `assertV2OnV1Leaf`) and a golden leaf in
`fixtures/v2-on-v1-leaf.json` copied verbatim to the external repository, to be asserted
and never regenerated.

**The field name for the pooled v2 speed summary is `speedV2`.** Version-scoped, because a
bare `speed` is the name a v1 field would have had and gives a v3 nowhere to go. A summary
under any other key is refused by name, in both directions.

| field | status | notes |
| --- | --- | --- |
| `wer`, `referenceWords`, `wordErrors` | **required** | and consistent: `wer * referenceWords` must equal `wordErrors` |
| `cer`, `referenceChars`, `charErrors` | optional **as a set** | all three or none |
| `meanRTF`, `totalWallSec`, `totalAudioSec` | **required, legacy, unfiltered** | see the ruling below |
| `utteranceCount`, `failures` | **required** | `failures` is the total including timeouts; `0` differs from absent |
| `speedV2` | **required** | the pooled v2 summary, complete |
| `speedV2.responseMs`, `speedV2.audioDurationSec` | **required** | the filtered numerator and denominator; see below |
| `failuresByStatus` | **optional**, consistent | `timeout + failed === failures` |
| `sampleRange` | **optional**, forbidden when pooling >1 run | one range cannot describe several |
| `speed` | **forbidden** | the divergence this section exists for |

The leaf is **open**: a repository may add fields of its own (Codictate writes
`peakRSS_MB`, meaningless for a foreign process). What is pinned is the shared set above,
and a consumer must treat anything else as optional.

`wordErrors` is required rather than optional because of a second, quieter consequence of
the same divergence: `charts.py::_leaf_word_errors` used an exact integer for Codictate and
a derived float (`wer * referenceWords`) for the external product, so one published rate
was pooled from two kinds of numerator with float error accumulating on only one side.
Requiring the count on every new leaf leaves the derived-float path where it belongs -
reading the archive, which predates the field and can never be re-measured.

`failuresByStatus` is optional rather than required because Codictate has no timeout to
report: a `TranscriptionResult` is `ok` or `failed` and nothing else (ADR-0006), so
requiring the breakdown would force it to write `{ timeout: 0, failed: n }` - a zero
stating a fact about a type union rather than about the run, which reads as "we never timed
out". It is not forbidden either, because the external harness really does time out, and
that breakdown is the only place the distinction is recorded.

### The v2 speed ratio must be poolable across leaves

`speedV2` carries **`responseMs`** and **`audioDurationSec`**: the filtered numerator and
denominator behind `responseMsPerAudioSec`. Both are **required**.

The reason is that **a ratio is not a weightable quantity.** A consumer combining
conditions - overall speed across `da_dk` and `hu_hu`, or across every dataset of one
model - has to sum the two and divide once:

```
pooled responseMsPerAudioSec = sum(speedV2.responseMs) / sum(speedV2.audioDurationSec)
pooled wallRtf               = that / 1000
```

Averaging `responseMsPerAudioSec` or `wallRtf` across leaves is a **mean of means**, which
is the same defect the accuracy rule already forbids, one level up and on the speed axis.
`v1-leaf.test.ts` pins a deliberately unbalanced pair - a 1-second condition answering at
3000 ms/s beside a 99-second condition answering at 100 ms/s - where the pooled figure is
**129 ms/s** and the average of the two ratios is **1550 ms/s**. Twelvefold apart, and only
the first is the speed of the combined sample.

They are the **filtered** accumulators, so provenance-incompatible and no-denominator
Samples are already out of both. In particular they are **not** `totalWallSec` and
`totalAudioSec`: in the golden fixture the poolable sums are 12000 ms over 80 s (the six
Samples that survived both filters) while the legacy totals are 18.5 s over 100 s (all ten
scored Samples). A consumer reaching for `totalAudioSec` as a weight would be weighting a
filtered numerator by an unfiltered denominator.

This is the identical argument `LeafInferenceDiagnostic` already makes for carrying
`inferenceMs` and `inferenceAudioSec`, and the one `benchmarks/README.md` makes for storing
`referenceWords` beside `wer`. The contract was inconsistent with itself until these two
were pinned; `pooledSpeed` now returns them, so a writer no longer has to accumulate its
own copy beside the ratio - and the guard checks that
`responseMs / audioDurationSec === responseMsPerAudioSec` and
`wallRtf === responseMsPerAudioSec / 1000`, because a second copy of the filtering is a
second chance to drift.

**A leaf without these two fields may only display its own per-condition `wallRtf`.** It
must not contribute to a cross-condition pooled figure, and a consumer must **count and
caption** such leaves rather than invent a weight for them. `poolableSpeedTotals(leaf)`
returns `null` for exactly those leaves, which is the seam to branch on.

### `meanRTF` keeps its v1 meaning

**Ruling, settled in the contract rather than per repository:** `meanRTF`, `totalWallSec`
and `totalAudioSec` are **legacy fields**. They mean session wall clock over audio,
computed over **all** scored Samples, and they are **not** filtered by `speedCompatible`.
All v2, provenance-filtered speed lives under `speedV2` and nowhere else.

The reason is archive comparability. Every archived leaf carries these three fields and
nothing else about speed, and the archived values were computed this way. Redefining them
makes new runs incomparable to the archive they are published beside - and the
redefinition is invisible, because the field name does not change. A benchmark whose
oldest numbers quietly stop meaning what they meant has lost the thing it exists for.

Note for the harness: `benchmarks/stt/runner.test.ts` currently asserts
`leaf.speedV2.wallRtf === leaf.meanRTF`. Under this ruling the two are equal only by
coincidence - when nothing was filtered and no Sample lacked a duration - so that
assertion pins the conflation rather than the contract. The golden fixture deliberately
carries `meanRTF: 0.185` beside `speedV2.wallRtf: 0.15`, so a fixture where they matched
cannot be used to argue that a fallback is harmless.

### No consumer may fall back from `speedV2.wallRtf` to `meanRTF`

A missing `speedV2.wallRtf` means **"no publishable v2 speed"**. It does not mean "use the
legacy number". They are different definitions over different sample sets and they are not
interchangeable at any confidence level. A row with no v2 speed is drawn empty, or omitted,
or labelled legacy - never quietly filled in.

`v1-leaf.ts::publishableWallRtf(leaf)` is that rule as code: it reads `speedV2.wallRtf`,
returns `null` when it is absent, `null` or non-finite, and never looks at `meanRTF`. Use
it instead of a `?.` chain with a default - which is precisely the shape
(`speed.get("wallRtf", r.get("meanRTF"))`) that plotted a Flow row at 2.8 against
Codictate's 0.1.

## Timing: two regimes, stated

Codictate can call its Speech Engine Adapter. Wispr Flow cannot be called at all, so it is
measured the only way a shipped product can be: press the hotkey, watch the text appear.
These are not the same measurement and no arithmetic makes them one.

### Codictate - direct adapter

- The timer starts on the statement immediately before the adapter invocation and ends
  when the final transcript is returned. **Nothing else inside the window**: no manifest
  read, no WAV read, no logging. Those are the harness's costs and would be charged to the
  Speech Model.
- Paste and UI overhead are excluded, because this harness never pastes. Do not convert it
  to UI injection: the fast direct path is what makes a 400-clip run affordable.
- The Codictate-only inference RTF stays as a **secondary diagnostic**, clearly labelled.

### Wispr Flow - UI-observed paste

- The shortcut is **Option+Z**. Option is held first.
- `startedAt` is taken **immediately before the Z keydown event is posted**, not after
  `post(hotkey)` returns. The code sleeps between the modifier and the key transition, so a
  post-return timestamp silently excludes roughly 20-70 ms of the product's own window, in
  the product's favour. The **stop** edge follows the same rule: `stoppedAt` is the Z
  keydown edge of the stop hotkey, before any inter-transition sleep.
- The response timer ends at the **last actual pasted-text change**.
- The **750 ms stability-confirmation delay is excluded**. It is the harness's patience,
  not the product's latency, and including it adds a flat 750 ms to every Wispr Flow Sample
  and to nothing of Codictate's. The exclusion is structural rather than subtractive - the
  window ends at the last text change, before the wait begins - so there is no delay to
  subtract and no way to subtract it twice.
- Lead/tail audio setup happens **before** the stop timestamp. Restoring the previous
  output device happens **outside** the window.
- Capture-window **text-change events** are preferred. Polling is a fallback, and a polled
  Sample records that it was polled and carries the poll interval as a stated bias -
  reported next to the number, never folded into it.

### The asymmetry label

Any surface that shows both products states the asymmetry, in one sentence, from one
constant (`INSTRUMENTATION_ASYMMETRY_LABEL` in `benchmarks/contract/timing.ts`):

> Response times are not measured the same way for both products: Codictate is timed at
> the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste.

Present in report output, in chart captions and subtitles, and in the staging reader. One
constant rather than three sentences, because three paraphrases drift and a reader ends up
believing the two numbers are the same measurement.

## Legacy and v1 compatibility

- Existing v1 result files are **untouched legacy snapshots**. Readers keep loading them,
  and `benchmarks/results/` is never rewritten.
- Old validated accuracy stays displayable as **legacy** data, visibly labelled.
- A v1 aggregate leaf never becomes v2 per-clip measurements.
- A v1 fingerprint field stays readable and is never compared against a v2 fingerprint.
- **v1 reader tests stay green.** v2 tests are added alongside; no v1 test is rewritten to
  v2. `benchmarks/stt/results-archive.manual.ts` stays pinned to the seven committed
  Benchmark Runs.
- Full v2 results replace the leaderboard **only after separate publication approval**. The
  v2 staging reader exists; nothing is deployed.
- Smoke output lives in `results/smoke/<batch>/`, is git-ignored, and is excluded from the
  production cursor, aggregation, coverage, staging and publication.

## Acceptance gates

The tests that hold this document up. `benchmarks/contract/*.test.ts` covers 1-7 and 9-11
on the contract side; the instrumentation gates (8, and the harness half of 9) live with
the code that posts the keystrokes, and 12 with the readers.

1. Every selected FLEURS audio file has a unique `clipId`; a 400-clip range invokes the
   adapter exactly 400 times on 400 distinct files.
2. Both repositories produce the same clipIds and the same fingerprint for the shared
   fixtures.
3. An interrupted run does not advance the production cursor.
4. Explicit resume replays warmups and skips every completed scored clip.
5. Disjoint continuations pool; an overlapping rerun replaces only the matching clips.
6. The cursor stays at the contiguous prefix across an intentional gap; `maxMeasuredEnd`
   reports the gap-inclusive end separately.
7. An end-to-end rerun replaces rather than adds. No double counting.
8. The Flow start timestamp corresponds to the exact Z keydown edge.
9. The 750 ms stability delay does not enter the Flow response metric.
10. Codictate and Flow use the same pooled `responseMsPerAudioSec` formula, on one code
    path.
11. Charts and reports use pooled durations and errors, not means of means.
12. Old v1 reader tests remain green; new v2 staging reader tests pass.

## Running the contract's own tests

```bash
bun test benchmarks/contract              # the pure suites, in CI
bun test ./benchmarks/contract/fleurs-identity.manual.ts   # the real-TSV witness
```

The second is opt-in for the reason `benchmarks/stt/results-archive.manual.ts` is: it is
pinned to data that is not in the repository. `benchmarks/datasets/` is git-ignored - the
corpora are gigabytes - so it cannot run in CI and would turn `bun test` red on a fresh
checkout with nothing broken. The rule it witnesses is covered on every machine by
`clip-identity.test.ts`, on a synthetic mirror of the same shape. The leading `./` is
required: without it `bun test` reads the argument as a name filter and runs nothing.
