# A Batch Dictation returns an Outcome; pasting is the caller's job

A transcript could not be obtained from Codictate without pasting it into whatever app had focus. `speech2text()` ended in `await pasteTranscript(transcript)`, and the audio it transcribed was not a parameter at all: `transcribe()` read the process-global `RECORDING_PATH`. The two consequences were not theoretical. A Benchmark Run copied each Sample over the running app's recording buffer, roughly 200 times per Benchmark Combination, purely to satisfy a hardcoded path. And the same function held five unrelated concerns - a brand mishearing table, a pipe drain, the crispasr spawn and parse, the Parakeet helper and its NDJSON protocol, and dictionary plus formatting plus paste orchestration - so the benchmark could not reuse any of it and re-implemented four pieces instead.

The decision is to **accept audio, return a value, and let the caller decide what happens to it**. Paste, history, stats and the AppConfig mutation move out to `setup-recording.ts`, which already owns every other post-Dictation surface. The two Speech Engine invocations go behind one interface with two real implementations.

ADR-0005 established that a Dictation is resolved once into a **Dictation Plan** and that a failure is carried as a value rather than raised. This ADR applies the same shape one layer down: the run itself produces a value, and its failures are a closed union too.

## Two seams, not one

The obvious refactor is a single `runDictation(plan, audio)` and it is wrong, because the two callers want different things. The Dictation wants the whole pipeline - transcript, dictionary, Formatting Mode - and then to paste it. The benchmark wants exactly what the Speech Engine said and nothing else; giving it the pipeline would mean handing it formatting settings, which is the coupling this ADR is removing.

So there are two:

- **Speech Engine Adapter** - takes a **Transcription Request** and returns a **Transcription Result**. Two implementations: crispasr and the Parakeet Native Helper. Two callers: the Dictation pipeline and the benchmark. It knows nothing about the Dictionary, Formatting Modes, history or the clipboard.
- **The Dictation pipeline** - takes a runnable Dictation Plan and an audio path, calls an adapter, applies the brand fix, the Dictionary and the Formatting Mode, and returns a **Dictation Outcome**. It does not paste.

A Transcription Request is deliberately not a Dictation Plan. AGENTS.md forbids giving the benchmark a plan, a settings read or a heal pass, and a Request keeps that true without a private benchmark entry point: the app derives one from its plan through a pure function, the benchmark constructs one by hand.

## Live Transcription is outside the interface

Live Transcription cannot return a result. The Parakeet Native Helper captures the mic, runs the model and pastes, and nothing is read from its stdout. It is a session lifecycle - start, stop - not a request-and-result call.

Rather than give the interface a third method that one of two adapters implements and one of two callers uses, `startParakeetStream` stays outside it entirely. This is a real asymmetry and it is chosen, not overlooked: in Batch Dictation, Codictate owns the paste; in Live Transcription, the Native Helper does. Making the helper stream finals back so TS could paste them is a latency change and a protocol change in two native helpers, on both macOS and Windows, and it is a decision for its own day.

## Failure

A non-zero engine exit currently is not treated as an error. `speech2text.ts` logged the exit code and returned stdout anyway, so an empty transcript was pasted over the user's cursor, written to history and counted in stats.

A Transcription Result is `{status:'ok', rawTranscript}` or `{status:'failed', reason, message}`, with four reasons, all of them about the engine: the engine exited non-zero, the binary or the weights vanished between the plan and the spawn, the Parakeet helper emitted no `final` line, or its output could not be parsed. The union is closed with an exhaustive message `Record`, the same device ADR-0005 used, so a fifth failure mode does not compile until it has a sentence.

The failed arm also carries an optional `diagnostic` - a stderr tail, a thrown message, a byte count - which is the engine's own words rather than the user's sentence. It exists for the log and for the benchmark console, and it never reaches a banner or a notification: what is stored for the UI is the reason and the message only.

A failed run reaches the same four surfaces as a blocked plan - the error chime, the tray error state, and a native notification or an in-window banner - but it does **not** trigger the heal pass. A blocked plan means the configuration is unrunnable and healing is the correction. A crashed helper means the configuration was fine, and running the heal pass on every crash would let a flaky helper quietly rewrite settings the user chose.

Two things are deliberately not failures:

- **A zero-exit empty transcript is a success with empty output.** Nothing is pasted, nothing is written to history, no stats row, and no error chime. The user said nothing, or said nothing the model could hear; silence should not sound like breakage.
- **A Formatting Backend failure still degrades to the Raw Transcript and pastes it.** Withholding a real transcript because the rewrite failed is worse than pasting it unformatted. The asymmetry with the engine is the point: without the engine there is no text, and there is nothing honest to paste.

## Consequences

- **`speech2text.ts` and `Speech2TextResult` are gone.** The adapters live under `src/bun/utils/whisper/engines/`, the pipeline moves to a new `src/bun/dictation/`, next to nothing else for now but named after the concept `src/shared/dictation-plan.ts` already uses.
- **`startRecording` shrinks to a recorder.** It emits `onCaptureFinished({audioPath, durationMs, discarded, skipReason})` and stops running the pipeline inside the mic process's `onExit`. The WAV short-capture check stays in the audio module, because it reads WAV bytes; the decision to skip transcription moves out. The end chime moves out too - every other sound is already played from `setup-recording.ts`, and one chime left behind would mean two modules own the audio feedback of one Dictation.
- **The order of operations is unchanged, on purpose.** Capture finishes, the tray and indicator say transcribing, the end chime plays, transcription runs, the paste happens on the statement after the pipeline returns. No await is added anywhere between the transcript and the paste. The refactor changes who calls `pasteTranscript`, never when.
- **Stats take one value.** The Dictation Outcome carries `engineId`, `languageId` and `durationMs`, so `onStatsSave(outcome)` replaces three arguments. AGENTS.md's "stats record what ran, from the plan, not from live config" becomes structural instead of a convention every call site has to remember.
- **The brand mishearing table moves above the Speech Engine seam.** The app still applies it; the benchmark no longer does, so WER is scored on what the engine actually said. This matters more than it looks: the table rewrites Danish-shaped strings (`kodigtede`, `ko digtet`) into the product name, and hviske is scored on FLEURS `da_dk`. The four archived Benchmark Runs are clean - the string appears only in two run descriptions, never in a hypothesis - so the change costs nothing today and keeps every future Danish number honest.
- **The benchmark's duplicates are deleted rather than kept in sync.** The pipe drain, the Parakeet NDJSON parse and the Parakeet argv were re-implemented in `benchmarks/stt/runner.ts`, the drain character-identical. The benchmark now calls an adapter, which is what makes the seam load-bearing instead of decorative: two implementations and two callers.
- **`stt.json` is byte-identical.** The adapter changes the call path, not the record. `benchmarks/stt/results-archive.manual.ts` pins the four committed Benchmark Runs including an exact `runCount` and the Harness-label round-trips, and none of that may move as a side effect of a refactor.
- **The seam is where tests become possible.** The WAV duration walk, the NDJSON final-line parse, the plan-to-Request derivation, the brand table and the failure-reason messages are all pure and all currently untested. The adapters themselves still spawn, so what remains manual is a real Dictation on both platforms, a killed helper producing the four failure surfaces, and a short capture still skipping.
- **Consistent with ADR-0002.** The ASR Harness seam does not move. `buildWhisperHarnessCommand` keeps the backend-and-translate invariant and stays the thing the crispasr adapter calls. The Speech Engine Adapter is a different seam above it, and `GLOSSARY.md` already distinguishes a Speech Engine from the Harness that executes it.

## Considered Options

- **One seam: `runDictation(plan, audio)` and the benchmark calls it too.** Rejected. It forces the benchmark to construct formatting settings and a Dictation Plan to get a transcript, which is the coupling being removed, and AGENTS.md rules the plan out of the benchmark for reasons that have not changed.
- **Give the adapter a Dictation Plan and the benchmark a second entry point.** Rejected. A private door for one caller is how the interface stops being one. A Transcription Request costs one pure derivation function and keeps both callers on the same path.
- **Leave paste, history and stats in `start-rec.ts` and only change the signature.** Rejected: the mic module would still orchestrate the Formatting Backend, which is the concern this ADR is about. Moving the call one line up is not moving it out.
- **Keep the brand fix inside the adapter, behind a flag the benchmark turns off.** Rejected. A flag is the benchmark asking the app to be less itself; moving the fix up one layer makes the benchmark's correctness fall out of the structure with nothing to configure.
- **Make the engine throw on a non-zero exit.** Rejected for the reason ADR-0005 already gave: a throw on this path was caught and discarded, and the shortcut press did nothing at all. A failure has to be carried, not raised.
- **Treat a zero-exit empty transcript as a failure so the user always gets feedback.** Rejected. It is the normal outcome of pressing the shortcut and not speaking, and an error chime for a silent recording trains the user to ignore the error chime.
- **Change the Live Transcription protocol so the helper streams finals and TS pastes.** Rejected for now, and recorded rather than dropped. It would make the two modes symmetric and put every paste in one place, at the cost of a protocol change in two native helpers and added latency on the path where latency is most visible. Worth revisiting if a second thing ever needs the live text - history, for instance, which Live Transcription does not currently write.
- **Per-Dictation temp audio files instead of one `RECORDING_PATH`.** Rejected as out of scope. The bug that motivated this - the benchmark overwriting the running app's buffer - is fixed by making the path a parameter, and per-Dictation files solve a concurrency Codictate does not have, since `transcriptionPipelineActive` allows one Dictation at a time.

### Punctuation Restoration in the pipeline (amended 2026-10-29)

Punctuation Restoration (#89, #95) is a step of the Dictation pipeline, not of the Speech Engine Adapter: the order is **engine, Punctuation Restoration (when the plan says so), brand table, Dictionary, Formatting Mode**. It runs on the Raw Transcript as the engine wrote it, so the brand table and the Dictionary see punctuated text and a Formatting Mode is handed better input, and it runs whether or not a Formatting Mode applies. The Dictation Plan decides whether it runs (`punctuationRestoration`: always for the ekko Speech Engine, for hviske with Add punctuation on, never on a live plan), and the pipeline re-derives nothing.

- **`rawTranscript` stays engine output.** The Dictation Outcome's `raw` includes the punctuation, and the Outcome gains `punctuationRestored`, which stats store as they store `formattingUsed` (`null` for rows written before it).
- **A raw request returns before it.** `codictate dictate --raw` is the Raw Transcript, unpunctuated.
- **The benchmark is untouched.** It calls the Speech Engine Adapter, below this step, so it keeps scoring the Raw Transcript and Punctuation Restoration never moves WER.
- **A third thing that is not a failure.** A Punctuation Restorer that fails to load, fails a run, changes the word count or times out hands its input back unpunctuated, and the Dictation carries on with it: an Outcome, pasted, with `punctuationRestored: false` and no error chime. It is the same reasoning as the Formatting Backend degrade - the words are real and there is something honest to paste. What is *not* degraded is a missing Punctuation Model with Add punctuation on: that is a blocked plan with its own reason (ADR-0005), and the heal pass turns the switch off.
- **`runDictation` takes its Speech Engine run, its Punctuation Restorer and its Formatting Mode as dependencies**, with the real ones as defaults, so the order is tested with fakes that leave a mark on the text (`run-dictation.test.ts`).

### A third adapter, ekko (amended 2026-10-29)

The Speech Engine Adapter has three implementations now: crispasr (Whisper, Edda, hviske), the Parakeet Native Helper, and ekko (#87, #102), which runs RyeAI's ekko-v1-tiny on the `parakeet-cli` ASR Harness (ADR-0002) with Codictate's own slices, one process per slice. The Transcription Request gains a third arm, `EkkoTranscriptionRequest`, discriminated on `engineId` like the other two, with no language, translate or backend: the weights are Danish only and `parakeet-cli` takes no language. It still has two callers, the Dictation pipeline and the benchmark, through the same `runTranscription`.

- **ekko's Raw Transcript is unpunctuated.** It is lowercase with no punctuation, and the Dictation Plan always restores punctuation for it (`punctuationRestoration`, amendment above). The adapter stops at the engine's text; Punctuation Restoration is the pipeline's next step.
- **The benchmark scores that Raw Transcript.** It calls the ekko adapter below Punctuation Restoration, as it does every other adapter, so ekko's WER (9.91% on all 927 FLEURS `da_dk` clips, Benchmark Run `2026-10-30_06-58-37_ekko-v1-tiny-danish`; 9.93% before ekko's slicing change in #108, `2026-10-29_21-54-05_ekko-v1-tiny-danish`) is comparable with every other Speech Model's, and Punctuation Restoration never moves it.
- **`codictate dictate --raw` with ekko is lowercase and unpunctuated** for the same reason: it is the Raw Transcript.
- **Installed means both parts.** An ekko Speech Model counts as available only with its GGUF and the Punctuation Model (ekko-pnc) on disk (`modelManager.isModelAvailable`), so no ekko run ever reaches the pipeline without its Punctuation Restorer's weights. Without ekko-pnc it is a missing Speech Model like any other: blocked as `speech_model_not_installed`, healed by moving the selection (ADR-0005), with no reason of its own.
