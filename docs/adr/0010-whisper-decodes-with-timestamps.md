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

Without `-nt`, Edda emits foreign-script noise. It keeps `-nt` and runs `--backend whisper --vad`, which splits the audio at pauses instead of every 30 s. That costs about 2x on long audio, and it stops the loss. The Silero VAD weights (`ggml-silero-v6.2.0.bin`, 864 KB) ship in `vendors/` on both platforms, so crispasr never downloads them at runtime. Edda has no Timed Transcript, because its segment times are not usable with `-nt`.

## Every Whisper Speech Model is checked before it drops `-nt`

Edda showed that a fine-tune can break without `-nt`, so dropping it is a per-model fact, not a default. A model drops `-nt` only after it passes the long-audio check (`.manual.ts`): no utterance lost, short clips unchanged or within one word, no foreign-script noise, and sane segment times. Translate to English is checked too. Until a model has been checked, it takes Edda's path: `-nt` with VAD, and no Timed Transcript.

First check, 2026-10-13: small.en-q5_1, medium.en-q5_0, small-q5_1 and large-v3-turbo-q5_0 pass and decode with timestamps. large-v3-q5_0 fails. Without `-nt` it loops on long Danish, repeating parts up to four times and losing the last utterance of the 5 min clip, and it loops on translate too. So it stays on Edda's path, where it loses nothing. Every browse-only Whisper model is still unchecked.

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
