# Codictate domain glossary

Canonical terms for Codictate. Glossary only: no implementation details, no plans, no decisions. Architectural decisions live in `docs/adr/`, architecture in `AGENTS.md`.

## Dictation

**Dictation** - one complete cycle of the core user action: the user activates a Dictation Shortcut, speaks, and the resulting text is placed at the cursor.

**Dictation Shortcut** - the key combination that starts and ends a Dictation. Codictate has two independent slots: the primary shortcut (supports both Hold and Tap) and an optional second shortcut (Hold only).

**Preset** - one of the fixed, named key combinations Codictate offers in the shortcut picker. Codictate does not let a user invent arbitrary combinations; the offered set is curated. See `docs/adr/0003-shortcut-presets-over-capture.md`.

**Trigger Key** - the non-modifier key in a Preset (Space, Enter, F1). A Preset may have no Trigger Key, in which case the combination is modifier-only (Right Option alone, Fn alone, Ctrl+Win).

**Modifier** - Option/Alt, Control, Shift, Command/Win, or Fn. Left and right variants of the same Modifier are distinguishable and are never mixed within one Preset.

**Shortcut Family** - the grouping a Preset appears under in the picker: Option/Alt, Fn/Globe, Control, or Meta (Command on macOS, Win on Windows). A Preset that involves the Meta key groups under Meta whichever Modifier comes first, because Meta is the key a user scans for; every other Preset groups by its leading Modifier.

**Hold** - activation style where the user keeps the Dictation Shortcut pressed while speaking; releasing it ends the Dictation and pastes.

**Tap** (also **latch**) - activation style where a quick press and release starts a hands-free Dictation that continues until the shortcut is pressed a second time.

## Speech

**Speech Engine** - the recognition system a Dictation is transcribed by, as the user sees it: Whisper, Parakeet, or hviske. Note that the Parakeet engine is identified as `whisperkit` in code, which is a misnomer; the engine is FluidAudio.

**hviske** - the Danish-only Speech Engine, running the mirrored `syvai/hviske-v5-tiny` weights. A Speech Engine in its own right rather than a Whisper Speech Model, because its weights, its backend and its language support all differ. See `docs/adr/0004-hviske-danish-ungated.md`.

**ASR Harness** - the specific binary and CLI contract used to execute a Speech Engine. There is one Harness, `crispasr`, and it executes both Whisper and hviske. Harness is an internal concept and is never exposed to end users. See `docs/adr/0002-asr-harness-abstraction.md`.

**Speech Model** - the weights a Speech Engine loads, identified by a Model ID (`large-v3-turbo-q5_0`). Distinct from the Speech Engine that runs it and the Harness that executes it.

**Quantization** - the precision variant of a Speech Model (`q4_k`, `q5_0`, `f16`). Different Quantizations of the same weights are separate Speech Models with separate Model IDs.

**Curated Speech Model** - a Speech Model Codictate offers in the main Settings list. Everything else is reachable only through the browse modal ("Browse more models" in Settings). Curation is a recommendation Codictate stands behind, not a capability difference.

**Transcription Language** - the language the user has fixed for recognition, or automatic detection.

**Translate to English** - a mode where the Speech Engine outputs English regardless of the spoken language, rather than transcribing verbatim. Distinct from Transcription Language, which selects the input language.

**Live Transcription** - a mode where partial text appears while the user is still speaking, rather than only after the Dictation ends. Requires Parakeet and a fixed Transcription Language. Previously labelled "Stream mode".

## Formatting

**Raw Transcript** - the text a Speech Engine produced, before any rewriting.

**Formatting Mode** - a named rewriting behaviour applied to a Raw Transcript before it is pasted (for example turning spoken words into an email). "Off" is a Formatting Mode.

**Formatting Backend** - what executes a Formatting Mode: llama.cpp running a local model, or Apple Intelligence on macOS 26+.

## Distribution

**Vendor Binary** - a third-party executable Codictate ships and invokes as a subprocess (`crispasr`, `llama-completion`). Distinct from a **Native Helper**, which is a binary Codictate itself authors (`KeyListener`, `CodictateWindowsHelper`, `CodictateParakeetHelper`, `CodictateWindowHelper`, `CodictateObserverHelper`).

**Mirror** - a copy of a third-party Speech Model that Codictate hosts itself, because the upstream repository is access-gated and end users cannot download from it directly.

## Benchmarking

**Benchmark Run** - one named, timestamped execution of the speech benchmark, recorded as a single result file with the hardware it ran on.

**Benchmark Combination** - one (Harness, Speech Model, dataset, language) tuple. "Already benchmarked" is a property of a Combination, not of a Speech Model.

**Sample** - one utterance from a dataset. Sample count is recorded per Combination, so the same Combination can exist at different depths across Benchmark Runs.
