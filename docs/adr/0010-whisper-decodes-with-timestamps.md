# Whisper decodes with timestamps; the plain transcript comes from crispasr's JSON

Every crispasr run used to pass `-nt`, so that stdout held the plain transcript and nothing else. ADR-0008 kept it and rejected timestamps, because dropping `-nt` turned Edda's transcript to noise. But on the whisper backend `-nt` is not a display flag. It puts the no-timestamps token in the prompt and decodes in fixed 30 s windows, and speech that crosses a window edge is lost. This hit every Dictation and File Transcription past about a minute.

The decision is that **stock Whisper Speech Models decode with timestamps**: no `-nt`, with `--no-prints -ojf -of <file>` (see the implementation note below for why a file and not stdout). Codictate reads the plain transcript and the Timed Transcript from the same JSON, joining the segment texts in order. Nothing is ever stripped from printed text. This applies to Dictations and File Transcriptions alike, and supersedes the "no timestamps" lines of ADR-0008 and ADR-0009.

## What was measured

Measured on 2026-10-13 on an M4 Max with crispasr v0.8.41. The clips were FLEURS `da_dk` and LibriSpeech test-clean utterances joined with short gaps. "Heard" means reference words found in order in the output; "lost" means whole utterances with less than 30% of their words heard.

| Clip | Today (`-nt`) | Lost today | New | Lost new |
|---|---|---|---|---|
| Turbo, English 60 s | 89% | 57-65 s | 97% | none |
| Turbo, English 5 min | 29% | everything from 84 s | 98% | none |
| Turbo, Danish 5 min | 65% | 5 stretches | 89% | none |
| Small, Danish 2 min | 43% | 3 stretches | 64% | none |
| Edda, Danish 5 min | 36% | 14 stretches | 94% (VAD path, below) | none |

Up to 30 s the two paths hear the same words at the same speed, within about 0.03 s. Past a minute, the new path takes 20-40% longer on this Mac and on a 4-thread CPU-only run. Part of that is speech that is now transcribed instead of skipped. We accept the cost: losing what the user said is worse than waiting a few seconds.

## Edda keeps `-nt`

Without `-nt`, Edda emits foreign-script noise. It keeps `-nt` and runs `--backend whisper --vad`, which splits the audio at pauses instead of every 30 s. That costs about 2x on long audio, and it stops the loss where the speaker pauses (below). The Silero VAD weights (`ggml-silero-v6.2.0.bin`, 864 KB) ship in `vendors/` on both platforms, so crispasr never downloads them at runtime. Edda has no Timed Transcript, because its segment times are not usable with `-nt`.

## Open: this path still loses long unbroken speech

**This path still loses speech, and it is not accepted.** The VAD only helps where the speaker pauses. The crispasr dispatcher packs the VAD's speech regions into slices of up to 30 s and decodes each with `-nt`; a region longer than 30 s is cut at 30 s wherever that falls. Measured 2026-10-17 on about 90 s of speech with the pauses cut out (utterances trimmed and joined with 0.05 s, the long-audio check's `*_continuous_90s` clips), the VAD found one 93 s region. large-v3, large-v3-q5_0 and large-v1 lost 29-60 s of the English clip (large-v3 wrote the first slice's text again instead), large-v1 also 71-93 s, and Edda lost the last Danish utterance, 78-94 s. The long-audio check fails on all of them.

`-vmsd` (VAD max speech duration) cannot fix it in crispasr v0.8.41. whisper.cpp's VAD does split a region at the cap, at the last silence of at least 98 ms or else at the current frame, but a later pass merges every two regions less than 200 ms apart, which rejoins those splits: the region stays at 93 s and the transcript does not change. `-ck`, `-mc 0`, `-vsd` and `-vo` change nothing either, and fixed 15 or 20 s chunks without the VAD lost more Danish.

The planned fix is for Codictate to choose the cut points itself, at real pauses, in slices of 20 s or less, and pass them with `--vad-import`, which crispasr honours. On the same clips, cut between utterances, nothing was lost: large-v3-q5_0 98.9%, large-v3 99.3% and large-v1 98.2% of English heard, Edda 95.5% and large-v3-q5_0 92.1% of Danish. Hard 10 s cuts mid-speech did not work: large-v3 wrote "♪♪" for three slices. The `timestamps` path lost nothing on the continuous clips, and neither did large-v3-q5_0 and large-v2-q5_0 forced onto it.

The `-vt 0.25` threshold of the `timestamps` path (ADR-0011) waits for that fix too. On this path it fixed base and tiny clipping a first word ("Duffered into you") and lost nothing more on Edda, but large-v2, large-v2-q5_0 and large-v2-q8_0 lost one 5 min Danish utterance (128-137 s) at any `-vt` from 0.2 to 0.4 that they keep at the default 0.5. That is not the VAD: the slice there holds a 0.5 s tail of the previous utterance and the lost one, its edges move by 0.06 s, and `-nt` then writes 2 of its 8 words. Which speech `-nt` loses moves with small changes like that, which is why this path needs cut points it controls.

## Every Whisper Speech Model is checked before it drops `-nt`

Edda showed that a fine-tune can break without `-nt`, so dropping it is a per-model fact, not a default. A model drops `-nt` only after it passes the long-audio check (`.manual.ts`): no utterance lost, short clips unchanged or within one word, no foreign-script noise, and sane segment times. Translate to English is checked too. Until a model has been checked, it takes Edda's path: `-nt` with VAD, and no Timed Transcript.

First check, 2026-10-13: small.en-q5_1, medium.en-q5_0, small-q5_1 and large-v3-turbo-q5_0 pass and decode with timestamps. large-v3-q5_0 fails. Without `-nt` it loops on long Danish, repeating parts up to four times and losing the last utterance of the 5 min clip, and it loops on translate too. So it stays on Edda's path, where it loses nothing.

Second check, 2026-10-17, every Whisper Speech Model with the VAD at `-vt 0.25` (ADR-0011). These pass and now decode with timestamps: large-v3-turbo, large-v3-turbo-q8_0, small, small-q8_0, small.en, small.en-q8_0, medium, medium-q5_0, medium-q8_0, medium.en, medium.en-q8_0, base.en, base.en-q5_1, base.en-q8_0, tiny.en, tiny.en-q5_1 and tiny.en-q8_0. These fail and stay on Edda's path:

- large-v3-q5_0: a repeated part on 5 min Danish.
- large-v3: lost 111-144 s of 5 min English, and repeats on Danish.
- large-v2, large-v2-q5_0 and large-v2-q8_0: with the dictation prompt they drop opening words ("After a while" on LibriSpeech 2033-164916-0005); the f16 also wrote Chinese and once wrote the Danish prompt into the transcript.
- large-v1: a short Danish clip came out 3 words worse than on `-nt`.
- base, base-q5_1, base-q8_0, tiny, tiny-q5_1 and tiny-q8_0: with the Danish prompt and the VAD they skip the whole first utterance (0-8 s) of a Danish clip.

hviske and Parakeet were never affected. On the cohere backend `-nt` only changes how stdout is printed, and Parakeet chunks with overlap. hviske switches to the JSON output so every crispasr run is read the same way.

## Implementation note: the JSON comes from a file, not stdout

The decision first said `-of -`, JSON on stdout. Reading crispasr v0.8.41's source showed that only works on one of the three paths, and only on macOS:

- Stock Whisper with a `.bin` model and no `--backend` runs the old whisper code path. There `-of -` opens `/dev/stdout` on macOS but `CON` on Windows (`examples/cli/cli.cpp`), and `CON` is not the pipe a GUI app reads, so Windows would get no JSON at all.
- Every `--backend` run (hviske on `cohere`, Edda on `whisper`) goes through the dispatcher, which writes `fname_out + ".json"`: with `-of -` that is a file literally named `-.json` in the working directory. The dispatcher also always prints plain text to stdout.

So every run, on both platforms, passes `--no-prints -ojf -of <per-run temp dir>/transcript` and Codictate reads `transcript.json`, then removes the directory. It is still crispasr's own structured output, and nothing is stripped from display output: stdout is drained so the pipe never fills, and ignored.

The two writers differ, so the parser (`src/bun/utils/whisper/engines/crispasr-json.ts`) reads bytes, not text. The old whisper writer escapes only `"` and `\` (control characters pass through raw), writes token texts as raw byte-level BPE pieces that can end inside a UTF-8 character (`" \xc3"`, `"\x98"` for " Ø", seen with small-q5_1 on FLEURS Danish), and includes special tokens such as `[_BEG_]`. Upstream fixed the split characters (#475) only in the dispatcher's writer. A segment's text that is not UTF-8 is still a failure, as stdout was.

Two smaller facts the adapter relies on: on the VAD path a recording with no speech exits 0 and writes no JSON file, with `no speech detected` on stderr (upstream #311), which is a silent recording and an empty transcript, not a failure. And the VAD weights are passed with `-vm`, so crispasr never downloads them at runtime.

## Considered Options

- **Keep `-nt` and get timings from a second, aligner pass.** Rejected. It keeps the lost speech lost, and it adds a 392 MB aligner download.
- **`-otxt -of -` for the plain text.** It gives the same words, one segment per line, but only one format can go to stdout. The JSON carries the text and the times in one run.
- **Strip the `[00:00.000 --> …]` prefixes from stdout.** Rejected. It parses display output instead of crispasr's structured output.

## Consequences

- A Dictation no longer gets word-for-word the same transcript as before on long audio. That is the point. On short audio it does, or within a comma.
- New Benchmark Runs measure the new path, so Whisper and Edda numbers will move. Older runs stay in the archive as they were.
