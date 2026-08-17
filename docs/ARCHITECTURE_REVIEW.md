# Architecture review — 2026-08-17

Deepening opportunities for Codictate, scoped to the hot spots of the last 60 commits: the ASR Harness / Speech Model cluster, the Dictation Shortcut Preset list, and the speech benchmark. `AppConfig` is included because every one of those paths reads or heals through it.

Vocabulary: domain terms from `CONTEXT.md`, architecture terms (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) from the `codebase-design` skill. ADRs 0001-0004 are treated as settled; where a candidate touches one, it is marked.

The visual version of this review, with before/after diagrams per candidate, is `docs/architecture-review-2026-08-17.html` (open it in a browser; it pulls Tailwind and Mermaid from CDNs).

This is a review, not a decision record. Decisions that come out of it belong in `docs/adr/`.

## Standing condition

28,662 lines of TS/TSX. 5 `*.test.ts` files. **No `test` script in `package.json`**, and no workflow in `.github/workflows/` runs `bun test`, `lint`, or `tsc`. Zero tests exist for `AppConfig.ts`, `setup-recording.ts`, `speech2text.ts`, `keyboard-events.ts`, `rpc.ts`. Every "tests would improve" claim below is a claim about a test surface that does not exist yet.

## Candidates

| | Candidate | Strength |
| --- | --- | --- |
| A | Resolve the Dictation once, into a plan | Strong |
| B | Make the Dictation run return a result instead of pasting one | Strong |
| C | Give a Preset one exhaustive definition | Strong |
| D | Shrink AppConfig's interface to the eight members that carry it | Strong |
| E | Make the interface the test surface | Strong |
| F | Retire the whisper-models shim | Worth exploring |
| G | One module resolves Vendor Binaries and Native Helpers | Worth exploring |
| H | Collapse the tray action modules | Worth exploring |

### A — Resolve the Dictation once, into a plan

**Files**: `src/bun/utils/whisper/speech2text.ts:110-160` · `src/shared/whisper-models.ts:78-92,158-177` · `src/shared/speech-models.ts:647-689` · `src/bun/utils/audio/start-rec.ts:210-239` · `src/bun/setup-recording.ts:286-310` · `src/bun/AppConfig/AppConfig.ts:1071-1089,1343-1354` · `src/bun/utils/model-actions.ts:33-47` · `src/mainview/components/MainContainer.tsx:190-216`

**Problem**: which Speech Model, Speech Engine, Transcription Language and crispasr backend actually run is decided in six modules and re-decided at three different moments, so no caller can name the run it just asked for.

**Solution**: one module turns config plus availability into an immutable plan. Every caller — Dictation, tray, settings, benchmark — reads the plan instead of re-deriving its parts.

What the scatter costs:

- **Translate to English silently dropped.** `speech2text.ts:132` substitutes `DEFAULT_MODEL_ID` when hviske weights are absent, then `:134` asks `resolveTranslateModelId` — which now sees turbo, not hviske, and returns `null`. Translate is dropped even with a translate-capable Speech Model installed. *(bug — fixed 2026-08-17)*
- **Stats record a Speech Model that never ran.** `Speech2TextResult` (`speech2text.ts:330-334`) carries no `effectiveModelId`, so `index.ts:548` logs the selection. Every hviske fallback and translate swap is invisible.
- **Five definitions of "can Live Transcription run"** — `HomeScreen.tsx:148-165` (ignores `parakeetCoreMlReady`), `AppConfig.ts:1071-1088`, `index.ts:109-119`, `setup-recording.ts:291` (the boolean alone), `parakeet-stream-runner.ts:37-44`. Deleting the Parakeet Speech Model resets `parakeetCoreMlReady` but not `streamMode` (`setup-window.ts:432-443`), so the next Dictation throws, is swallowed at `setup-recording.ts:368-377`, and does nothing at all.
- **The stated Live Transcription requirement is enforced nowhere.** `CONTEXT.md` says it needs a fixed Transcription Language; `speech-models.ts:658` accepts `auto`, `:673-689` forces Parakeet to `auto`, and `parakeet-stream-runner.ts:55` passes no language.
- **Live Transcription ignores the selected Speech Model** — `parakeet-stream-runner.ts:35` hardcodes `parakeet-tdt-0.6b-v3` while `setup-recording.ts:331` logs `whisperModelId` as though it mattered.

**Wins**: locality (one place decides the run) · leverage (plan replaces six re-derivations) · the plan is a value, testable with no spawn · readiness reasons survive to the UI · stats can name the effective Speech Model · benchmark enters at link one, not four.

### B — Make the Dictation run return a result instead of pasting one

**Files**: `src/bun/utils/whisper/speech2text.ts` (373 lines) · `parakeet-stream-runner.ts` · `src/bun/utils/audio/start-rec.ts:175-242` · `src/bun/setup-recording.ts:441-452` · `src/bun/platform/runtime.ts:75` · `benchmarks/stt/runner.ts:85-242`

**Problem**: a transcript cannot be obtained without pasting into the user's focused app, and audio arrives through a process-global file rather than a parameter — so the only two adapters that exist fight over it.

**Solution**: accept audio, return an outcome. Move paste, history, stats and the AppConfig mutation out to the caller, and put the two Speech Engine invocations behind one interface. Two adapters (crispasr, Parakeet Native Helper) make that seam real.

`speech2text.ts` currently holds eight concerns: brand mishearing table (`:27-69`), pipe drain (`:80-99`), hviske availability fallback (`:110-132`), translate swap and language pin (`:134-160`), crispasr spawn and parse (`:182-209`), Parakeet helper and NDJSON protocol (`:212-268`), a hand-written 44-byte WAV header (`:270-302`), and dictionary/formatting/paste orchestration (`:336-373`).

What the missing seam costs:

- **A Benchmark Run overwrote the running app's recording buffer.** `benchmarks/stt/runner.ts:205,228` copied each Sample over `RECORDING_PATH` — roughly 200 times per Benchmark Combination — purely to imitate a hardcoded path. `buildWhisperHarnessCommand` already accepts any `audioPath` (`whisper-harness-command.ts:16`); only `transcribe()` refused one. *(bug — fixed 2026-08-17)*
- **Any throw wedged Dictation until restart.** `start-rec.ts:206-240` had no `try/catch` and nothing registers `unhandledRejection`. A throw from `findAsrHarnessBinary`, `getModelPath` or the backend+translate invariant skipped `onDone()`, so `transcriptionPipelineActive` stayed true forever and every later Dictation was refused. The Formatting Backend degrades to the Raw Transcript on any error (`apply-formatting.ts:222-237`); the Speech Engine wedged. *(bug — fixed 2026-08-17)*
- **Non-zero exit is not an error.** `speech2text.ts:195-209` logs `exitCode` and returns stdout anyway, so an empty transcript is pasted, written to history and counted in stats.
- **Asking a question deletes files.** `isModelAvailable` for Parakeet calls `cleanupParakeetCoreMlInstall` → `rmSync(recursive)` (`model-manager.ts:186-190,123`), and that predicate sits on the Dictation hot path and inside every `getSettings()`.
- **The duplication is load-bearing.** The benchmark re-implements the drain helper (`runner.ts:88-107` vs `speech2text.ts:80-99`, character-identical), the Parakeet NDJSON parse (`:182-196` vs `:239-252`), the Parakeet argv (three sites), and the WAV duration walk (`build-manifests.ts:14-52`, whose comment admits it copies `start-rec.ts`). WER is also scored on brand-substituted hypotheses.

**Consistent with ADR-0002**: the ASR Harness seam stays where it is. `buildWhisperHarnessCommand` has two real adapters (app and benchmark) and holds the backend+translate invariant. This candidate adds a Speech Engine seam above it — a different seam from Harness, as `CONTEXT.md` already distinguishes them.

### C — Give a Preset one exhaustive definition

**Files**: `src/shared/types.ts:167-182` · `src/shared/shortcut-options.ts:15-21,35-126,272-280` · `src/bun/utils/keyboard/keyboard-events.ts:12-34,240-354,385-392` · `src/bun/setup-recording.ts:36-64,205-248` · `native/CodictateWindowsHelper/src/keyboard/hook.rs:73-127,176-206` · `src/bun/utils/keyboard/KeyListener.swift:222-257`

**Problem**: Preset knowledge is spread over 15 sites in 6 files and 3 languages, and only one is compile-enforced, so a half-added Preset renders in the picker, reports success, and is never saved.

The 15 sites: `ShortcutId` union · `SHORTCUT_OPTIONS` entry · `shortcutFamily` prefix inference · `windowsUsesModifierReleaseHold` · `SHORTCUTS` record (**the only `tsc`-enforced one**) · `KeyCode` table · `requireLeftOption` switch · `isWindowsModifierReleaseEvent` · `isWindowsComboTriggerReleaseEvent` · `OPTION_CHORD_MAIN_IDS` · `FN_GLOBE_DEFER_CANCEL_SUPPRESS` · `holdFnChordConflictsWithFnGlobeMain` · `hook.rs` `vk_to_keycode` · `hook.rs` `ActiveComboModifiers` · `KeyListener.swift` modifier switch.

**Solution**: one `Record<ShortcutId, Preset>` holding keys, labels, Shortcut Family, Trigger Key, Modifiers, hold-end rule and platforms. Matchers, pickers and the native keycode tables derive from it.

Silent failures today:

- **A missing `SHORTCUT_OPTIONS` entry looks like success.** `AppConfig.ts:72-74` builds `VALID_SHORTCUT_IDS` from that array, so `updateGeneralSettings` returns `false` at `:932-937` — and `SectionShortcuts.tsx:40` discards the boolean after an optimistic cache write. The picker shows the Preset selected; nothing is persisted.
- **Unknown ids land in the Option Shortcut Family silently** — `shortcut-options.ts:20` returns `'option'` by default.
- **Two Presets of the same shape use two different Windows hold-end mechanisms.** `option-space` gets the rule twice (matcher guard plus the pre-filter at `setup-recording.ts:239-248`, making the guard dead); `control-meta-space` gets it only from the pre-filter, because `twoModifierTriggerCombo` has no platform guard.
- **A Shift-based Preset cannot work on Windows at all.** `ActiveComboModifiers` (`hook.rs:73-83`) has no `shift` field and `active_combo_from_rule:177-181` ignores `rule.shift`.
- **`displayKeys` is dead weight** — restated for all 12 Presets at `keyboard-events.ts:242-345`, read nowhere, with no Windows variant.
- **Platform support is never validated.** `optionSupportedOnPlatform` defaults true when `supportedPlatforms` is absent and AppConfig never checks platform, so a persisted `fn-globe` on Windows is accepted and inert (`hook.rs:269` hardcodes `function: false`).
- **Five keycode tables must agree and none references another** (`keyboard-events.ts:12-34,181-183` · `setup-recording.ts:36-46` · `KeyListener.swift:222-257` · `hook.rs:107-127` plus a second literal list at `:196-198`). The mac/Windows mapping is documented only in prose at `hook.rs:56-57`.

**Refines ADR-0003, does not contradict it.** Presets stay curated; no capture UI. But the ADR's five-file count undercounts by ten, and its stated trigger ("if it grows much past a dozen, revisit capture") is already met at 12. Cheapening the per-Preset cost is what keeps the no-capture decision affordable. The ADR also records the logic as "unit-tested"; that resolves to two serde assertions in `protocol.rs:167-197` — `hook.rs` has no `#[cfg(test)]` module.

### D — Shrink AppConfig's interface to the eight members that carry it

**Files**: `src/bun/AppConfig/AppConfig.ts` (1937 lines) · `src/shared/types.ts:184-340` · `src/bun/setup-window.ts:146-270` · `src/bun/platform/runtime.ts:68-78`

**Problem**: 107 public members, 50 of them with no caller outside the file, wrap eight that hold all the behaviour (~614 lines) — and the module creates its own paths, model manager and logger, so none of it can be constructed in a test.

Of the 107: 50 unreachable, 38 single-statement delegations to one of the five `update*` methods, ~40 bare field returns. The behaviour lives in `load`, `getSettings`, `getFormattingRuntimeSettings`, the five `update*` methods, `resolveAudioDevice`, and the dictionary auto-learn cluster.

**Solution**: delete the unreachable half, fold the delegating setters into the five patch methods, accept paths and availability as dependencies, and give all five `update*` methods one transactional discipline.

What the wide interface hides:

- **Three siblings, three transactional disciplines, none in the interface.** `updateFormattingSettings` mutates `enabled` at `:1098` before validating at `:1126` and returning `false` without saving; `updateTranscriptionSettings` does the same at `:1053-1085`; `updateGeneralSettings` validates up front. On rejection, memory ≠ disk, the webview refetches the mutated memory, and the next unrelated `saveMain()` persists it.
- **A field's default depends on whether a config file exists.** `onboardingCompleted` is `false` in the constructor (`:257`) and `true` when absent from a loaded file (`:409-411`).
- **The migration branch never retires.** `LEGACY_CONFIG_PATH` is read at `:787,808` and deleted nowhere; with `main-config.json` present but the dictionary file absent, stale legacy main values are re-applied over current config (`:807,684`).
- **No write queue.** `ProductOnboardingScreen.tsx:266-277` fires 10 concurrent `updateFormattingSettings` through `Promise.all`, each ending in `saveMain()` — while `HistoryManager` and `StatsManager` both queue (`history-manager.ts:95-102`).
- **`getSettings()` is a getter with 39 stat calls and possible file deletion** (`:900` → `getAvailabilityMap`), and `setup-indicator-window.ts` calls it five times per status change.
- **Rich reasons collapse to `boolean` at the seam.** `StreamModeReadiness` and `TranslateReadiness` are discriminated unions; `:1079-1086` logs the reason and returns a bool, so `need_warmup` never reaches the UI and the toggle snaps back unexplained.
- **Rejected writes get no correction push** from `setup-window.ts:178-179`, while the sibling handler at `:203-206` does push — against 80 optimistic `setQueryData(['settings'])` calls across 14 files.
- **One domain rule, four implementations** — the hold-only-differs-from-primary invariant lives at `:429-434`, `:938-947`, `:976-981`, plus `SectionShortcuts.tsx:35-38`. Dictionary entry identity has three, and `rpc.ts:479-486` keys fuzzy entries differently from the other two.
- **The built-in "Codictate" dictionary entry can be deleted.** `ensureBuiltinDictionaryEntries` runs on load (`:671`) but not in `updateDictionarySettings` (`:1206-1220`), which is the path the webview uses — so it stays gone until restart resurrects it.

### E — Make the interface the test surface

**Files**: `package.json:14-38` · `.github/workflows/*` · `src/bun/utils/stats/stats-manager.ts:77-272` · `src/shared/whisper-models.ts:78-177` · `src/bun/utils/whisper/model-downloads.test.ts` · `benchmarks/stt/results-schema.test.ts:34-174`

**Problem**: nothing runs the tests that exist, and the two most testable modules in the repo — both of which already accept their dependencies — have no tests at all.

Two of the five existing test files do not test Codictate. `model-downloads.test.ts` does live `fetch` against Hugging Face and never imports `model-manager.ts`, so it cannot fail for any bug in `downloadModel`. `results-schema.test.ts:174` asserts `runCount === 4` against the committed archive, so a fifth Benchmark Run breaks the suite.

**Solution**: add a `test` script and a CI job, move the network test out of the default run, and cover the five interfaces that need no restructuring first:

- `stats-manager` — accepts a `() => string` path. Holds the most date-sensitive logic in the repo: streak maths, the DST fudge at `:264`, and a month-boundary branch duplicated at `:139` and `:194`.
- `history-manager` — accepts its path, queues writes.
- `resolveTranslateModelId`, `getStreamModeReadiness`, `getTranslateReadiness` — pure functions of an injected `isModelAvailable`.
- `buildWhisperHarnessCommand` — pin `availableParallelism` and argv becomes assertable.
- `hook.rs` matchers — `cargo test` is already wired via `check:native:windows-helper`, just never called by CI.

### F — Retire the whisper-models shim

**Files**: `src/shared/whisper-models.ts` (177 lines) · `src/shared/speech-models.ts` · `src/bun/AppConfig/AppConfig.ts:1034-1038` · `src/mainview/components/Settings/ModelPicker.tsx`

**Problem**: the module is a projection of `SPEECH_MODELS` plus four re-exports, its type is self-marked `@deprecated` at `:14`, and its one validator (`isValidWhisperModelId:137-139`) returns true for Parakeet and hviske ids while gating the field named `whisperModelId`.

**Deletion test**: fails for the shim, passes for two functions inside it. Deleting `WHISPER_MODELS`, `WHISPER_MODEL_IDS` and the re-exports moves nothing — callers already have `speech-models.ts`. `resolveTranslateModelId` and the two readiness unions do concentrate real complexity and should survive; they belong next to the rest of the run decision (candidate A), not in a module named for one Speech Engine that decides Parakeet's readiness.

### G — One module resolves Vendor Binaries and Native Helpers

**Files**: `src/bun/platform/types.ts:34-49` · `src/bun/platform/{macos,windows,linux}/index.ts` · `src/bun/utils/whisper/find-asr-harness.ts` · `src/bun/utils/audio/find-mic-recorder.ts` · `src/bun/utils/keyboard/find-keyboard-helper.ts`

**Problem**: the same resolve-or-throw logic (candidate list → first existing → throw with remediation) is written nine times across three seams, and `PlatformProvider`'s interface grows one method per binary shipped — six of its twelve methods are `find*Binary`.

**Solution**: a table of binaries plus one `resolveBinary(id)`. `PlatformProvider` keeps what actually varies by platform: data dir, temp path, `playSound`, `openUrl`, permission URLs.

- `find-asr-harness.ts` and `find-mic-recorder.ts` are the same module written twice with different error strings — each 40-60 lines, each with one caller.
- `find-keyboard-helper.ts` caches a `path` but recomputes `kind` from the current platform on every hit (`:17,25-30`).
- Individually each finder is a hypothetical seam. Together they are nine copies of one rule, which is what makes consolidating them worth more than deleting them.
- The interface docs are stale: `types.ts:25,41` still say `llama-cli`, renamed to `llama-completion` by ADR-0001.
- `getPlatform()` is a module-level singleton keyed off `process.platform` (`platform/index.ts:9-27`) with 18 call sites, so no test can vary a helper path.

### H — Collapse the tray action modules

**Files**: `src/bun/utils/device-actions.ts` (37) · `src/bun/utils/transcription-language-actions.ts` (26) · `src/bun/utils/model-actions.ts` (50) · `src/bun/setup-tray.ts:246-263` · `src/bun/setup-menu.ts:71-86` · `src/mainview/components/MainContainer.tsx:190-216`

**Deletion test, per module**:

- **`device-actions.ts` — fails.** ~20 lines move into two callers, nothing concentrates. Worse, it concealed a defect: `setup-menu.ts:83` omitted `deviceDetails`, so `device-actions.ts:30` computed `deviceId = null` and wiped the persisted device id that `resolveAudioDevice` prefers (`AppConfig.ts:1284-1289`). Two adapters disagreeing is exactly what a seam should make visible; this one hid it. *(bug — fixed 2026-08-17)*
- **`transcription-language-actions.ts` — fails.** One caller. It also skips the Speech Model language coercion its sibling applies, so picking a language from the tray under a Parakeet Speech Model persists a language the Speech Engine ignores.
- **`model-actions.ts` — passes, narrowly.** `handleModelAction:25-50` is the only place three rules compose (coerce the Transcription Language, drop Live Transcription if unsupported, sequence both writes). The complexity has already reappeared elsewhere: `MainContainer.tsx:190-216` re-implements it and disables Live Transcription unconditionally where `model-actions` only does so when unsupported.

**Solution**: inline the menu building. Keep the Speech Model change rule as its own module and route the React path through it instead of its hand-written copy — that gives the seam its second adapter.

## Suggested sequence

1. **The four live bugs** (done 2026-08-17) — cheap, independent of any deepening, and they make A and B verifiable.
2. **E** — costs a `test` script and a CI job; without it nothing below can be verified.
3. **A**, then **B** — the plan gives `runDictation(plan, audio)` something to accept. **F** folds into A.
4. **C** — touches no file the others touch, so it can go in any order.
5. **D**, **G**, **H** — independent.
