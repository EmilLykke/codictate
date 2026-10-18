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

Without `-nt`, Edda emits foreign-script noise. It keeps `-nt` on `--backend whisper`, and decodes the audio in slices Codictate cuts at pauses (next section). Edda has no Timed Transcript, because its segment times are not usable with `-nt`.

## `nt-vad` decodes Codictate's own slices

This path first ran `--backend whisper -nt --vad` with the bundled Silero weights, and lost long unbroken speech. Measured 2026-10-17 on about 90 s of speech with the pauses cut out (utterances trimmed and joined with 0.05 s, the long-audio check's `*_continuous_90s` clips), large-v3, large-v3-q5_0 and large-v1 lost 29-60 s of the English clip (large-v3 wrote the first slice's text again instead), large-v1 also 71-93 s, and Edda lost the last Danish utterance, 78-94 s.

The cause is whisper.cpp, not crispasr and not the models. The whisper backend declares `CAP_INTERNAL_CHUNKING`, so crispasr hands each VAD region to whisper.cpp whole (93 s here), and whisper.cpp decodes it in 30 s windows. With `-nt` there are no timestamp tokens to say where the model stopped, so after an early end-of-text it always moves on a full window (`seek_delta = 100*WHISPER_CHUNK_SIZE`, `src/whisper.cpp`) and the rest of that window is never decoded. OpenAI's reference `transcribe.py` does the same. This section first blamed the dispatcher for packing regions into 30 s slices; reading crispasr v0.8.41's source showed it does not. No crispasr up to v0.8.44 changes any of this. `-vmsd` cannot fix it: on the `--backend` path it is silently ignored (the dispatcher's VAD options have no max-speech field), and crispasr then merges any two regions less than 1 s apart, or after one shorter than 3 s. `-ck`, `-mc 0`, `-vsd` and `-vo` change nothing.

The decision is that **Codictate cuts the slices and passes them with `--vad-import`** (`src/bun/utils/whisper/engines/vad-slices.ts`, issue #83). crispasr uses a `"kind":"chunks"` file as written, with no merge and no re-pack, and decodes each slice on its own. The argv is `--backend whisper -nt --vad-import <per-run dir>/slices.json -sns -bs 5`, with no `--vad` and no `-vm`: `--vad-import` turns crispasr's VAD on by itself and never loads a VAD model. The cuts:

- A loudness scan in 10 ms frames finds speech and pauses. A pause is at least 98 ms of frames within 6 dB of the noise floor.
- Neighbouring speech is merged into slices of up to 20 s. A slice that cannot hold the next speech ends at the longest pause between 10 and 20 s from its start (faster-whisper's rule), and with no pause at all at the quietest 100 ms.
- A pause longer than 1.5 s always ends a slice and is left out of every slice. A long silence inside a slice is what invites an early end-of-text, and Edda was trained on clips with at most 2 s of trailing silence.
- Each edge keeps 0.2 s of real audio. Slices never overlap, and a slice with less than 250 ms of speech is dropped. A recording with no slices is an empty transcript, and crispasr is not started.
- `-sns` suppresses non-speech tokens such as "♪♪", which OpenAI whisper, faster-whisper and WhisperX all do by default. `-bs 5` is Edda's model card. Temperature fallback stays on, as crispasr's default.

This is how the rest of the field decodes Whisper without timestamps: WhisperX's cut and merge and faster-whisper's batched pipeline both cut at VAD pauses, decode each piece independently without timestamps or previous text, and use no overlap. Edda's card says "split at pauses for best results". A Silero pass to tell speech from noise was measured and left out: run alone through crispasr it costs about 0.35 s on 90 s of audio, against about 5 ms for the loudness scan, and its regions come out after the 1 s / 3 s merge.

### What was measured

The long-audio check, 2026-10-18, crispasr v0.8.41 on an M4 Max, every run repeated. It now also fails a model that loses 3 or more words, or the first or last word, of an utterance at a cut, compared with decoding that utterance alone. On the continuous clips that is reported but does not fail the model (below).

| Speech Model | Danish 5 min | Danish continuous 90 s | English 5 min | English continuous 90 s |
|---|---|---|---|---|
| Edda q5_0 / q8_0 / f16 | 95%, none lost | 90-91%, none lost | - | - |
| large-v3-q5_0 | 91%, none lost | 94%, none lost | 98%, none lost | 99%, none lost |
| large-v3 | 91%, none lost | 92%, none lost | 98%, none lost | 99%, none lost |

All five lose no words at any cut on the clips with natural pauses, translate correctly, and write no foreign script. Short clips stay within two words of the old argv, never worse against the reference. Speed is about the old path's: Edda decodes 5 min of Danish in about 9 s.

- **Beam search stays.** Greedy decoding lost the 128-137 s utterance of 5 min Danish on all three Edda Quantizations, and continuous Danish fell to 76-86%. On large-v3 greedy was 12-23% faster at the same accuracy, but `-bs 5` is the one setting that loses nothing everywhere.
- **The cap stays at 20 s.** At 25 s Edda was about 12% faster and equal on accuracy, large-v3 gained nothing measurable and lost 1-2 points on continuous Danish, and the same cut loss below did not move.
- **The rest of the `nt-vad` models are no worse.** large-v1 went from losing 29-93 s of continuous English to losing nothing. large-v2, large-v2-q5_0 and large-v2-q8_0 pass. Multilingual base and tiny, judged on English because they hear only a third to a half of Danish words even one utterance at a time, lose nothing and stop clipping "Stuff it into you" to "Duffered into you".
- **`-vt` no longer applies here.** This path runs no Silero VAD, so ADR-0011's threshold question for `nt-vad` is gone.

### Accepted: words lost at a cut inside a sentence

On the continuous clips the gaps between sentences are 0.05 s, below the 98 ms a pause needs, so every cut there lands inside a sentence, and a model can drop the piece of sentence at a slice edge. Edda (all three) drops "dens lange kæber havde mere end" at 29.98 s of continuous Danish. Before the longest-pause rule large-v2 dropped "See, said Uncas, pointing north and south" and every priority model "sytten dødsfald"; both are fixed. On the clips with natural pauses no cut by any model loses a word. Real speech almost always pauses for longer than 98 ms between sentences, so this is accepted and recorded, not gated. If a real Dictation ever shows words lost at a cut, the follow-up is a short overlap at cuts inside speech with the doubled words removed. Hugging Face's merge of overlapping chunks is, in its author's word, "unsound" on silence and repeated words, which is why it is not done before it is needed.

## Every Whisper Speech Model starts on `nt-vad`, and the check moves it to `timestamps`

Edda showed that a fine-tune can break without `-nt`, so dropping it is a per-model fact, not a default. A Speech Model with no `whisperDecoding` decodes on `nt-vad`, which since the section above loses no speech, so a new Speech Model is safe with no per-model work. The long-audio check (`.manual.ts`) is the upgrade to `timestamps`, which writes whole sentences more often (ADR-0011) and has a Timed Transcript: a model moves only after it passes there, with no utterance lost, short clips unchanged or within one word, no foreign-script noise, and sane segment times. Translate to English is checked too.

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

Two smaller facts the adapter relies on: on a `--backend` run a recording with no speech exits 0 and writes no JSON file, with `no speech detected` on stderr (upstream #311), which is a silent recording and an empty transcript, not a failure; on `nt-vad` Codictate does not start crispasr for a recording it cut into no slices. And the VAD weights are passed with `-vm` on the `timestamps` path, so crispasr never downloads them at runtime.

## Considered Options

- **Keep `-nt` and get timings from a second, aligner pass.** Rejected. It keeps the lost speech lost, and it adds a 392 MB aligner download.
- **`-otxt -of -` for the plain text.** It gives the same words, one segment per line, but only one format can go to stdout. The JSON carries the text and the times in one run.
- **Strip the `[00:00.000 --> …]` prefixes from stdout.** Rejected. It parses display output instead of crispasr's structured output.

## Consequences

- A Dictation no longer gets word-for-word the same transcript as before on long audio. That is the point. On short audio it does, or within a comma.
- New Benchmark Runs measure the new path, so Whisper and Edda numbers will move. Older runs stay in the archive as they were.
