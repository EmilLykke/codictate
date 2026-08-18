# A Dictation never adapts to an unrunnable state

Codictate resolved a Dictation while it ran. If the selected Speech Model's weights had been deleted it transcribed with a different one; if Translate to English was on with a Speech Model that cannot translate it silently transcribed verbatim instead; if Live Transcription was on with Parakeet missing it threw, and the throw was discarded so the Dictation simply did nothing. Three failures, three different silent behaviours, none of them visible to the user and none of them recorded in stats.

The decision is to remove all three. **The state is kept runnable instead of the Dictation being made to cope with a broken one.** A configuration that cannot produce the Dictation the user asked for is refused when it is written, corrected when availability changes underneath it, and never offered in the UI. What remains at run time is a **Dictation Plan**: a value that is either runnable or blocked, and a blocked plan names its reason and starts nothing.

This generalises a decision already recorded in ADR-0002 for Vendor Binaries — "a silent degrade to an unexercised binary is worse than an error a user can report, and an unresolvable Vendor Binary is a packaging defect that has to be fixed at the source rather than papered over at runtime" — from binaries to Speech Model state.

## What "kept runnable" means concretely

Validity is not a property of a settings patch, it is a property of the whole settings object, and it depends on files that change without any settings write at all. So it is enforced in three places:

- **On write.** Every settings update validates the object that would result, not the fields in the patch. Turning Translate on with `large-v3` and then switching to `large-v3-turbo` is two individually valid writes with an invalid result; the second is the one that has to be caught.
- **On availability change.** A heal pass runs whenever a Speech Model is downloaded or deleted, and at boot. It takes current settings plus current availability and returns corrected settings. Deleting the Speech Model that is selected resets the selection to the bundled default rather than leaving it dangling.
- **On a blocked Dictation.** Weights can vanish behind the app's back — a Finder delete, a failed disk, a cloud-storage eviction. The shortcut press is the first thing that notices, so a blocked plan both reports the reason and triggers the heal pass. The next press works, and Settings no longer claims a deleted Speech Model is selected.

The heal pass tells the user when it changes something the user chose — the Speech Model selection, Translate to English, Live Transcription — and stays quiet otherwise. Silently flipping a toggle the user set is the same class of surprise as a silent fallback.

## The Dictation Plan

One pure function of `(settings, availability snapshot)` returning a Dictation Plan, in `src/shared/dictation-plan.ts` so that both the Bun side and the webview can use it. It covers batch Dictation and Live Transcription as one union. It has no substitution list, because nothing substitutes.

Its blocked reasons are a closed union, so a new failure mode cannot join a generic bucket without `tsc` demanding a message for it. Readiness is computed in the main process and shipped in the settings payload; the webview renders it and derives nothing. Stats read the Speech Model and Transcription Language from the plan rather than re-reading live config after the run, which the user can change mid-transcription.

The benchmark is deliberately outside this. It has no settings, no availability healing and no fallback semantics; it reuses the ASR Harness command builder, not the plan.

"Outside" means outside the plan and the heal pass, not off limits. The implementing branch did change `benchmarks/stt/runner.ts`, in two places where the benchmark had the same class of defect this ADR is about - failure reported as a plausible number instead of as a failure. A non-zero Harness exit was indistinguishable from silence, so an empty transcript scored as a 100% WER utterance and a Harness that never transcribed anything produced a finished-looking Benchmark Run; and `resolveModelPath` accepted a half-populated Parakeet directory on `existsSync`, then re-downloaded once per utterance. Neither change gives the benchmark a plan, a settings read or a fallback.

## Considered Options

- **Keep resolving at run time, but log it loudly.** Rejected. This is what the code already did — every one of the three fallbacks logs. Logging is not a user-visible surface, and the whole defect is that the user is told nothing while getting a transcript from a Speech Model they did not select, in a language they did not ask for.
- **Make the builder throw and let the caller catch.** Rejected because a throw is exactly what the Live Transcription path already does, and it is the failure that produces the *worst* outcome of the three: caught, discarded, and the shortcut does nothing at all. A blocked value has to be carried, not raised.
- **Always produce a runnable plan by substituting, but record the substitutions so they reach stats and the UI.** This was the first proposal and it is the honest version of the current behaviour. Rejected because it keeps the user's selection and the actual run permanently divergent and asks the UI to explain the divergence after the fact, when the alternative is to never let them diverge.
- **Refuse the write and make the user fix it.** Chosen for the *write* path (Translate cannot be turned on where it cannot run) but rejected for the *availability* path: refusing to delete a Speech Model because it happens to be selected makes the app argue with a user whose intent is clearly to free disk space.
- **Watch the models directory so the state is corrected before the user ever presses.** Rejected for now. A filesystem watcher over a directory of multi-gigabyte files, with platform-specific semantics and cloud-eviction false positives, is a large amount of machinery to avoid one error message that already clears itself on the next press. Worth revisiting if users hit it.

## Consequences

- **Translate to English plus an hviske Speech Model stops being offered.** Today it quietly works by running a Whisper Speech Model instead. Now the Translate toggle is disabled while hviske is selected, and switching to hviske turns Translate off with a visible note. This is a real loss of a working combination, accepted because the combination worked by running weights the user did not choose.
- **`resolveTranslateModelId` collapses to a boolean.** With the hviske swap gone and no "first available translate-capable model" search, the question reduces to "is the selected Speech Model translate-capable and installed". `src/shared/whisper-models.ts` had no remaining justification once that complexity left — it was already a projection of `SPEECH_MODELS` plus four re-exports, with its own type marked `@deprecated` — so it is deleted and its survivors move into `dictation-plan.ts`.
- **Supersedes bullets in ADR-0004.** "Translate to English is not refused on an hviske selection; it resolves away to a translate-capable Whisper Speech Model instead" and "Such a run falls back to the default Speech Model, which means a transcript in the wrong language rather than a failed Dictation" no longer describe the system. The rest of ADR-0004 stands, including the Danish language pin for an hviske run that actually happens.
- **Supersedes a bullet in ADR-0002.** "The translate Speech Model swap is a Speech Model concern, not a Harness concern... That swap is what makes Translate to English work" no longer describes the system. It remains true that the swap was never a Harness concern; there is simply no swap.
- **Parakeet warmup stops being a user-facing state.** `need_warmup` was a readiness reason a user could not act on. Warmup now runs automatically when Parakeet becomes the selected Speech Model, and the reason never reaches a message.
- **`assertParakeetStreamRuntimeReady` survives** rather than being deleted as a duplicate check. The gap between building a plan and spawning the helper is where a race lands, so the last check before the spawn stays — but it produces a plan-shaped typed reason instead of a bare `Error`, which is what stops it being a competing definition of readiness.
- **The five scattered definitions of "can Live Transcription run" reduce to one.** The AppConfig gate becomes the validator, the boot check becomes the heal pass, the `HomeScreen` copy becomes rendering of shipped readiness, and the bare `getStreamMode()` boolean on the shortcut path becomes the plan's mode.
- **This is easier to reverse in code than in product.** The pure functions could be deleted in an afternoon; re-teaching users that Translate works under hviske after telling them it does not is the part that does not revert.
- **It depends on a test runner existing.** The plan builder, the validator and the heal pass are pure functions whose entire justification is that they can be tested without a spawn or a filesystem. A `test` script and a CI job land before this work, or the restructuring buys nothing.
