---
status: trial on branch feat/whisper-vad-beam-prompt, pending real-dictation use
---

# Whisper on the timestamps path decodes with its own VAD, beam search and a prompt

ADR-0010 moved stock Whisper Speech Models off `-nt` so long audio stops losing speech. That fixed the loss, but natural dictation came out in pieces. When the user pauses mid-sentence, Whisper closes the sentence there: "the links and. All that stays within the card. Because right now it overflows as. You can see...". Every hesitation becomes a full stop and a capital letter.

This is Whisper, not crispasr. The same clips through upstream whisper.cpp 1.9.5 give byte-identical output, and mlx-whisper and faster-whisper break at the same pauses.

The decision is that **the `timestamps` path adds three things**, still on the default crispasr path with no `--backend`:

- `--vad -vm <bundled Silero weights>`. whisper.cpp's own VAD joins the speech regions with about 0.1 s between them and decodes them as one stream, so a pause no longer looks like the end of a sentence. Segment times are mapped back to the original timeline. The timestamp-driven seek from ADR-0010 is kept, so nothing is lost on long audio.
- `-vt 0.25`, a lower VAD threshold than the default 0.5. Above it the VAD starts a speech region late, or skips quiet speech, and Whisper never hears those words. No Whisper Speech Model may lose speech, so the threshold is set by the model that loses most (below). A wider speech pad (`-vp` 150-300 ms instead of 30) also fixes a clipped first word, but keeps more of each pause, and the stray full stops came back (10-12 instead of 4).
- `-bs 5`, beam search with 5 beams. That is upstream whisper-cli's default; crispasr defaults to greedy.
- `--prompt` with one punctuated sentence. Without it, beam search sometimes wrote lowercase run-ons joined by commas.

`-nt` stays off this path. Edda's `nt-vad` path and hviske's `cohere` path do not change.

## What was measured

Measured on large-v3-turbo-q5_0 with the bundled crispasr v0.8.41. Short clips: 18 hesitant TTS clips with pauses inside sentences, 735 words. "Stray breaks" are sentence ends where the speaker only paused; "missed ends" are real sentence ends that were not written as one. Long clips: 74 s, 147 s and 83 s of clean speech, scored by recall of the reference words.

| Path | Stray breaks | Missed ends | Long-clip recall | Lost speech |
|---|---|---|---|---|
| `timestamps` before this change | 15 | 15 | 0.999 | none |
| Old `-nt` | 17 | 12 | 0.873 average, 0.763 worst | 6 runs |
| `timestamps` + VAD + beam 5 + prompt | 4 | 5 | 0.997-0.999 | none |
| The same with `-vt 0.35` | 7 | 4 | 0.997-0.999 | none |

`-vt 0.25`, which ships, was measured afterwards and is in the next section.

Two partial runs belong next to it. Beam search alone on the `timestamps` path lost a sentence at about 103-111 s of the 147 s clip. Edda's path (`--backend whisper -nt --vad`) gave 40 stray breaks on the short clips.

It costs time: about 10% slower on short clips and about 40% slower on 2.5 min. It also writes more stray commas where the user paused. We accept both: a stray comma does less harm than a stray full stop and capital.

A silent recording on this path exits 0 and writes JSON with `"transcription": []`, which is an empty transcript, as before.

## The VAD threshold is 0.25

The trial first shipped `-vt 0.35`. On 2026-10-17 it lost speech on other Speech Models:

- small-q5_1, small, small-q8_0, large-v3-turbo (f16) and large-v3-turbo-q8_0 turned LibriSpeech test-clean 1089-134686-0001, "Stuff it into you, his belly counselled him", into "Duffered into you" or "Stuffed into you". At 0.25 small-q5_1 writes it correctly.
- medium.en-q5_0 dropped seven words at the start of LibriSpeech test-other 5764-299665-0017: "religious and fearful tremblingly repeat this passage" was missing and the output started at "though he slay me". At 0.25 they are back.
- On 40 LibriSpeech clips, for small-q5_1, small.en-q5_1, medium.en-q5_0 and large-v3-turbo-q5_0, the reference words missing at 0.25 were no more than at 0.35, for every model.

The `nt-vad` path then ran `--backend whisper -nt --vad` and honoured `-vt` too. At 0.25 its first speech region started at 0.32 s instead of 0.55 s, which fixed "Stuff it into you" becoming "Duffered into you" on base, base-q5_1, base-q8_0, tiny and tiny-q8_0, but large-v2, large-v2-q5_0 and large-v2-q8_0 lost one utterance of 5 min Danish at 0.2-0.4 that they keep at 0.5. That loss was `-nt` decoding, not the VAD. Since ADR-0010's `--vad-import` fix that path runs no Silero VAD and Codictate cuts the slices itself, so it has no threshold; the clipped first word on base and tiny is gone there too.

It costs nothing we could measure in punctuation. On 11 real dictations with large-v3-turbo-q5_0, 0.25 and 0.35 trade single sentence breaks either way: 0.25 is better on one, worse on one, and the rest are identical. Three hesitant TTS clips are identical.

The long-audio check now guards this. On the `timestamps` path it runs 20 short LibriSpeech clips, and 10 FLEURS `da_dk` clips for a multilingual model, with the app's argv and with the same argv minus `--vad -vm <path> -vt <x>`, and fails a model when the VAD run is missing reference words the other run heard and has 3 or more words fewer there, or lost the first word. Counting words keeps a misheard stretch from counting as lost: small-q5_1 writes FLEURS "ved at give" as "når jeg giver" at every threshold from 0.1 to 0.35, which is a misrecognition and not lost speech.

## The prompt follows the Transcription Language

The prompt is written in the language Whisper will write:

- Danish: "Hej, dette er en diktering. Jeg skriver i hele sætninger, med kommaer hvor jeg holder pause."
- English, auto-detect, and any run with Translate to English: "Hello, this is a dictation. I write in full sentences, with commas where I pause."
- Any other pinned language: no prompt. It is untested, so we do not bias it.

Auto-detect gets the English prompt because a 71 s Danish FLEURS clip with `--language auto` and the English prompt stayed Danish. A Danish prompt was equally good on that clip.

Without the VAD, small-q5_1 once wrote the Danish prompt into the transcript three times. It has not been seen with the VAD, but the long-audio check fails any transcript on this path that repeats four words of the prompt in a row.

## No word times on this path

With `--vad`, whisper.cpp leaves token `offsets` in the VAD's compressed timeline (upstream whisper.cpp #4046). On a 19 s clip the last token ended at 13.1 s while its segment correctly ended at 19.2 s. So on this path the Timed Transcript is built from segment times only, with no words. Caption Files still work: a part without words is split and its time shared out by character. hviske keeps its word times.

The long-audio check from ADR-0010 passed on large-v3-turbo-q5_0 with `-vt 0.35`: no utterance lost on English 60 s and 5 min or Danish 2 and 5 min, times in order and every utterance covered.

## Considered Options

- **Go back to `-nt` for short clips.** Rejected. It did not reduce the stray breaks in the test (17 against 15), and it loses speech past 30 s, which is what ADR-0010 fixed.
- **`--backend whisper --vad`, Edda's path.** Rejected. The dispatcher decodes each VAD slice on its own, which gave 40 stray breaks. And with `-nt`, as Edda runs it, it still loses speech inside merged slices longer than 30 s.
- **A punctuation model after Whisper.** Rejected. crispasr runs one only on the `--backend` dispatcher path, and per segment.
- **`single_segment`.** Not run. In whisper.cpp it still decodes timestamp tokens and skips a whole 30 s window after an early stop, like `-nt`, so it would bring the lost speech back.
- **The prompt alone, or `-mc 0`.** No effect on the breaks.
- **A wider VAD speech pad instead of a lower threshold.** Rejected, above: it brings the stray full stops back.
- **Beam search alone.** It lost a sentence in the 147 s clip.

## Caveats

- The pauses were TTS pauses, a stand-in for real hesitation. This is why the change is a trial until it has been used for real dictation.
- The punctuation was measured only on large-v3-turbo-q5_0. The other Speech Models on the `timestamps` path (small.en-q5_1, medium.en-q5_0, small-q5_1) get the same flags; for them only the lost speech was measured.
- The English prompt with auto-detect was checked only on Danish.

## Consequences

- Dictations on the `timestamps` path read as whole sentences more often, with more commas at pauses.
- They are slower, about 10% on short clips and 40% on long ones.
- The Timed Transcript on this path has part times and no word times.
- New Benchmark Runs measure this path, so turbo numbers will move.
