# Parakeet cold load on macOS and iOS

Research note, 2026-10-28, updated 2026-10-29 with the eviction, GPU encoder and process-name measurements and the decisions in section 7. Question: why is the first Parakeet TDT 0.6B v3 Dictation slow on the
Codictate macOS app and the Codictate iOS app, what is the best fix on each platform, what does it
cost to keep the model loaded, and do other on-device speech models avoid the problem.

Measured on: Mac16,5 (Apple M4 Max, 36 GB), macOS 26.6.2 (25G83), FluidAudio 0.17.7.
Nothing was measured on an iPhone. iOS numbers come from FluidAudio's own benchmarks, a FluidAudio
issue, Apple docs, or reasoning, and each one says which.

Markers used below: **[measured]** = run on this Mac today, **[source]** = a primary source says
so (linked), **[unverified]** = could not trace to a primary source or measure; treat as a guess.

## 1. TL;DR

- **The slow first Dictation is the Neural Engine compiling the 445 MB encoder again, not loading
  it.** On this Mac a cold `transcribe` took 12.6 to 14.4 s, and the system log shows
  `ANECompilerService` compiling the network for 10 to 12 s of that. A warm run takes 0.15 s.
  **[measured]**
- **There is one compiled copy per process name and model folder, and a differently signed
  binary under the same name replaces it.** With only the installed helper in play, the copy
  stayed warm across a 10-minute idle gap (0.18 s). Running the repo's ad-hoc signed helper on the
  same folder recompiled (13.4 s), and the installed helper right after it recompiled again
  (12.7 s). Binaries with different names on the same folder kept separate copies, and a rebuilt
  binary with the same identifier stayed warm. **[measured, 2026-10-29]** An earlier reading of
  "gone after 5 to 8.5 minutes" was this eviction, not a time limit.
- **That is why this Mac is slow so often.** Stable, canary and dev builds all run as
  `CodictateParakeetHelper` on `~/Library/Application Support/codictate/models` with three
  different signing identifiers, so every switch between them costs a 12 to 19 s compile,
  stable and canary included. **[measured]** A user who runs only the stable app pays it far less
  often: on first use, after an OS update, and possibly after a reboot or low disk. An app update
  probably does not recompile (same identifier, new code hash stayed warm with ad-hoc signing).
  **[reboot and a signed update unverified]**
- **The fix is when the load happens, not keeping a process alive.** Loading in the background
  at launch and on selection, with a Dictation waiting on that load, moves nearly every compile
  away from a Dictation. Giving each channel's helper its own executable name stops the channels
  evicting each other. A resident helper (M1) would also work (0 s idle CPU, 25 to 29 MB
  footprint, about 470 MB reclaimable Neural Engine memory **[measured]**) but is parked; see
  section 7.
- **Encoder on GPU is not the answer.** It skips the compile, but uses 2.4 GB RSS instead of
  80 MB, a 1.1 GB cache, and slows back to 2.5 to 3 s after a few idle minutes. **[measured]**
- **iOS fix: start loading when recording starts, not after it stops, and load at bootstrap.**
  Today the model only loads inside `transcribe()`, and `warmUp()` is never called. Expect a full
  recompile after every app update (12 s on iPhone 16 Pro Max, 51 to 181 s on iPhone 18 Pro Max
  per a FluidAudio issue). **[source]**
- **Apple's SpeechTranscriber avoids the problem but has no Danish.** On this Mac it lists 30
  locales and reports `da-DK` as unsupported. `DictationTranscriber` (the older dictation model)
  does support `da-DK`. **[measured]** The smaller FluidAudio Parakeet models are English only.
  **[source]**

## 2. Why it is slow

### 2.1 What Core ML does on load (Apple's description)

Apple's WWDC23 session "Improve Core ML integration with async prediction" describes the load:
Core ML first checks a cache for a copy already specialized for this configuration and device. If
found, that is a "cached load". If not, it runs a device-specialized compilation, caches the
output, and finishes from there: an "uncached load", which "for certain models ... can take a
significant amount of time" ([WWDC23 10049](https://developer.apple.com/videos/play/wwdc2023/10049/)).
The same session says the cache is "tied to the model's path and configuration", is "meant to
persist across app launches and reboots", and is deleted when disk space runs short, after a system
update, or when the compiled model is deleted or modified
([WWDC23 10049](https://developer.apple.com/videos/play/wwdc2023/10049/)).

For the Neural Engine part, the compile runs in a system service. whisper.cpp's README says the same
thing in plain words: "The first run on a device is slow, since the ANE service compiles the Core ML
model to some device-specific format. Next runs are faster"
([whisper.cpp README](https://github.com/ggml-org/whisper.cpp/blob/master/README.md)).
FluidAudio's profiler notes call it "ANE means fast inference, slow load. First ANE init is
multi-second" ([FluidAudio ANE_Profiler.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/ANE_Profiler.md)).

### 2.2 How FluidAudio loads Parakeet v3

- The encoder is `Encoder.mlmodelc`, 425 MB on disk here (6-bit palettized). It is the only big
  piece: Decoder 23 MB, JointDecisionv3 12 MB, Preprocessor 0.5 MB. **[measured]**
- Compute units: Preprocessor is pinned to `.cpuOnly`; encoder, decoder and joint use the
  configuration's units, which default to `.cpuAndNeuralEngine`
  ([AsrModels.swift, v0.17.7](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/ASR/Parakeet/SlidingWindow/TDT/AsrModels.swift),
  [MLModelConfigurationUtils.swift](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/Shared/MLModelConfigurationUtils.swift)).
- `AsrModels.loadLocal` (what the macOS helper calls) builds each component with the synchronous
  `MLModel(contentsOf:configuration:)`. `AsrManager.loadModels` only stores the models; it runs no
  warm-up prediction
  ([AsrManager.swift, v0.17.7](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/ASR/Parakeet/SlidingWindow/TDT/AsrManager.swift)).
- FluidAudio's own iPhone numbers for the v3 bundle: encoder cold load 3,361 ms and warm load
  162 ms on iPhone 16 Pro Max, cold 4,396 ms on iPhone 13. Decoder and joint are under 150 ms cold
  ([Benchmarks.md, "ASR Model Compilation"](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/Benchmarks.md)).

### 2.3 macOS: what actually happens (measured on this Mac)

Every Parakeet Dictation spawns a fresh `CodictateParakeetHelper` (`transcribe`, `stream vad`,
`stream live`), and each spawn loads the four models again. Only the benchmark uses the resident
`transcribe-session` mode
(`native/CodictateParakeetHelper/Sources/CodictateParakeetHelper/CodictateParakeetHelper.swift`).

The unified log (`log show`, no root needed) shows the mechanism for a cold run:

| Time | Event |
|---|---|
| 19:43:39.32 | `aned`: `open(...) failed. errno=2 : No such file or directory`, then a missing `directoryPath` (NSCocoaErrorDomain 4). The compiled copy is not on disk. |
| 19:43:39.42 | Helper memory-maps the 445,187,200-byte encoder weights. |
| 19:43:41.85 | `aned`: `Calling ANECompilerService: modelURL=... csIdentity=... key=... outputURL=...` |
| 19:43:42.24 | `ANECompilerService`: "Start of compilation of network" |
| 19:43:47.47 | "Dram Required for procedure ... is 491583404" |
| 19:43:53.40 | "End of compilation of network" (about 11.2 s of compile) |
| 19:43:53.56 | `aned`: program loaded, `wiredMemory=491323392` |

A warm run 30 s later had none of this: no failed `open`, no weight mmap, no compiler call, and
the program was created in about 20 ms from `cachedModel.length=460554240`. **[measured]**

Timings with a 0.5 s silent 16 kHz WAV, `/usr/bin/time -l`:

| Run | Binary | Wall time | Max RSS | Peak footprint |
|---|---|---:|---:|---:|
| 19:52:50, 8.5 min after last use | repo `vendors/parakeet` helper (ad-hoc) | 13.27 s | 526 MB | 69 MB |
| 19:53:18, right after | same | 0.16 s | 81 MB | 38 MB |
| 19:53:19, first use today | `/Applications/Codictate.app` helper (Developer ID) | 12.56 s | 526 MB | 69 MB |
| 19:53:31, right after | same | 0.15 s | 84 MB | 41 MB |

Does the compiled copy expire, or is it replaced? Installed helper unless marked:

| When | Gap / what ran before | Wall time |
|---|---|---:|
| 2026-10-28 | 90 s gap | 0.18 s |
| 2026-10-28 | 180 s gap | 0.26 s |
| 2026-10-28 19:52:50 (repo helper) | 507 s gap, installed helper ran in between | 13.27 s (recompiled) |
| 2026-10-29 08:31:26 | 300 s gap, repo helper compiled the same folder at 08:26 | 13.71 s (recompiled) |
| 2026-10-29 08:38:40 | 420 s gap, nothing else compiled | 0.25 s |
| 2026-10-29 08:49:08 | 600 s gap, nothing else ran | 0.18 s |
| 2026-10-29 08:49:09 (repo helper) | right after the installed helper | 13.43 s (recompiled) |
| 2026-10-29 08:49:22 | right after the repo helper | 12.66 s (recompiled) |
| 2026-10-29 08:49:35 (repo helper) | right after the installed helper | 13.74 s (recompiled) |

Every recompile in the table follows a run of the other helper; no run without one in between
recompiled. **[measured]**

What this shows:

1. **The cost is the ANE compile, about 10 to 12 s of the 12.6 to 14.4 s.** Loading an already
   compiled program takes about 20 ms. **[measured]**
2. **The compiled copy is keyed by the calling binary's code-signing identity.** `aned` reads the
   caller's signing identifier and team ID (`SecTaskCopySigningIdentifier`,
   `SecTaskCopyTeamIdentifier`) and passes `csIdentity` to the compiler. The repo helper was warm
   while the installed helper, same model folder, compiled from scratch. **[measured]** The repo
   helper was also rebuilt at 15:04 today, between a 14:41 compile and the 19:43 cold run, which
   fits a cache keyed on the binary. **[measured; that the key includes the code hash is
   unverified]**
3. **There is one compiled copy per model folder, and a differently signed caller replaces it.**
   With one helper only, the copy survived 10 idle minutes. Each switch between the installed
   (Developer ID) and repo (ad-hoc) helper recompiled. **[measured]** This fits Apple's rule that
   the cache is "tied to the model's path and configuration"
   ([WWDC23 10049](https://developer.apple.com/videos/play/wwdc2023/10049/)), with the signing
   identity as part of the key and only one entry kept per path. **[the one-slot mechanism is
   inferred, not documented]** No `aned` garbage-collection activity
   (`com.apple.aned.modelCacheGC`, `danglingModelsGC`) was logged around the recompiles.
   The `com.apple.aned` caches under `/Library/Caches` are protected and could not be read
   without root. Not tested: survival across days, a reboot, an app update (same identifier, new
   code hash) and an OS update.
   On this Mac three helpers share the folder: stable `app.codictate.native.codictateparakeethelper`,
   canary `app.codictate.canary.native.codictateparakeethelper` (both team `L256GR2793`) and the dev
   build's ad-hoc `CodictateParakeetHelper`. All channels use the same `APP_DATA_DIR`
   (`src/bun/platform/runtime.ts`). Stable (0.0.69) and canary (0.0.55) evict each other too
   **[measured, 2026-10-29]**:

   | Run | Helper | Wall |
   |---|---|---:|
   | 1 | stable | 14.20 s (cold) |
   | 2 | stable | 0.14 s |
   | 3 | canary | 19.39 s (recompiled) |
   | 4 | canary | 0.10 s |
   | 5 | stable | 13.02 s (recompiled) |
   | 6 | canary | 12.62 s (recompiled) |
   | 7 | stable | 12.66 s (recompiled) |

   **What the slot is keyed on**, from a probe binary and the repo helper on APFS clones of the
   model folder (clones share disk blocks but have their own paths) **[measured, 2026-10-29]**:
   - Two binaries with different process names (`Probe-v1`, `CodictateParakeetHelper`) on the
     same path kept separate warm copies: 13.12 s cold, then 0.16 to 0.19 s for each after.
   - Two binaries with the same name and different signing identifiers on the same path evicted
     each other every switch (12.9 to 13.0 s). On different clones they did not (0.15 to 0.21 s).
   - The same identifier under a new name got its own cold slot (13.98 s) and left the old one warm.
   - A rebuilt binary (new code hash, same identifier and name) stayed warm (0.09 s). Ad-hoc
     signing only; a Developer ID signed update was not tested.

   So the slot is one per (process name, model path), and a different signing identity under the
   same name replaces it. Giving each channel's helper its own executable name, or its own APFS
   clone of the model folder, should each stop the eviction. The name change is inferred from the
   probe runs, not yet tested on the real helpers.

   Side finding: canary 0.0.55 rejects the 0.5 s warmup WAV with `invalidAudioData`, because
   FluidAudio 0.13.6 required at least 1 s of audio
   (`AsrManager+Transcription.swift:9`). The models load first, so the compile still happens; only
   the exit code fails, which left the persisted "prepared" flag unset. Fixed in `aaf2f69`
   (FluidAudio 0.17.7, minimum 0.3 s), first shipped in v0.0.61.
4. **The e5 bundle cache does exist but does not hold the encoder.**
   `~/Library/Caches/CodictateParakeetHelper/com.apple.e5rt.e5bundlecache/25G83/` holds 46 entries
   (217 MB in total), sized about 23 MB, 12 MB, 1 MB and 80 KB: the decoder, joint and preprocessor
   pieces, not a 450 MB encoder program. The folder name `25G83` is the macOS build number, so an
   OS update starts a new folder. **[measured]** The general `getconf DARWIN_USER_CACHE_DIR` has no
   entry for the helper; the per-process cache sits under `~/Library/Caches/<process name>/`.
5. **The boot "Cold Start" load in `parakeet-warmup.ts` only partly helps** (the code's name; it
   is the same load, and every slow one measured was a Parakeet Preparation). It runs once per app
   process (`loadedThisProcess`). For a user on one channel it keeps the copy compiled until
   something evicts it. It does not help after another channel or a dev build recompiled the
   folder, or after whatever else evicts the copy (untested: update, reboot, low disk).
   **[measured for the eviction; the rest unverified]**
6. **Today's earlier measurement was not the installed app.** The 19:43 to 19:44 runs used
   `codictate/vendors/parakeet/CodictateParakeetHelper` (ad-hoc signed), per the log's
   `processImagePath`. The installed helper did not run at all today before 19:53, and the app's
   config (`~/Library/Application Support/codictate/main-config.json`) has
   `speechModelId: large-v3-turbo-q5_0`, so the boot load at 16:04 was skipped by design
   (`shouldStartParakeetColdStartLoad` requires Parakeet to be selected). **[measured]**

Memory accounting, measured on a resident `transcribe-session` helper with `footprint`:

- `phys_footprint` 25 to 29 MB (peak 67 MB during load). RSS 81 MB.
- A separate category, "Owned physical footprint (unmapped) (neural) (nofootprint)": 29 MB clean
  plus 439 MB reclaimable, `neural_peak: 468 MB`.
- `aned` reports `wiredMemory=491323392` (469 MiB) for the encoder program.

So the Neural Engine copy is real physical memory owned by the helper, but it is tagged so that it
does not count in the footprint number the system uses for memory limits. XNU's source confirms the
rule: neural-tagged memory "counts in footprint only when nonvolatile and not marked as 'no
footprint'" ([xnu vm_object.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)),
and jetsam snapshots record it separately as `jse_neural_nofootprint_total_pages`
([xnu kern_memorystatus.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus.c)).
What "reclaimable" means in practice (can the kernel purge it under pressure, and does the next
prediction then recompile or just reload?) is **unverified**.

Note on the earlier figure of "max RSS ~80 MB, peak footprint ~39 MB" for a loaded helper: that is
a warm load. A cold load maps the whole encoder file and peaks at 526 MB RSS. Neither number shows
the Neural Engine memory; `footprint` does.

### 2.4 iOS: what happens (from the code, not measured)

`codictate-app` resolves FluidAudio 0.15.7 (`ios/.../Package.resolved`; the config plugin asks for
"up to next major" from 0.14.5, so a clean build can pick up any 0.x release).

- `ParakeetEngine.transcribe()` calls `loadIfNeeded()` first, so the load starts after the user has
  stopped speaking. The user waits for load plus inference.
- `ParakeetEngine.warmUp()` exists but nothing calls it (`grep` finds no caller; the same is true
  for the Whisper and hviske engines).
- `ParakeetModelManager.loadedModels` and the engine's `AsrManager` live in the host process. When
  iOS terminates the suspended app, both are gone and the next Dictation loads again.
- Side finding: `ParakeetModelManager.modelDirectory` reports `Documents/parakeet-tdt-v3`, but
  `AsrModels.downloadAndLoad(version: .v3)` with no `to:` stores the models in
  `Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml`
  ([v0.15.7 MLModelConfigurationUtils.defaultModelsDirectory](https://github.com/FluidInference/FluidAudio/blob/v0.15.7/Sources/FluidAudio/Shared/MLModelConfigurationUtils.swift)).
  The path `ModelManager` reports for Parakeet is not where the files are. Not a load-time cause.

How long the user waits on iOS depends on which of three states the device is in:

| State | Expected wait before inference | Basis |
|---|---|---|
| App process alive, models loaded | none | code |
| New process, compiled copy still cached | about 0.2 to 0.5 s (encoder warm load 162 ms on iPhone 16 Pro Max) | [source](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/Benchmarks.md) |
| New process, compiled copy gone (first use, after app update, after OS update) | 3.4 to 4.4 s (FluidAudio bench), 12 s (Ultra encoder, iPhone 16 Pro Max), 51 to 181 s (v3, iPhone 18 Pro Max, iOS 27.0.1) | [Benchmarks.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/Benchmarks.md), [FluidAudio #1022](https://github.com/FluidInference/FluidAudio/issues/1022) |

FluidAudio issue #1022 reports the long load "after each app install or update" and says later
launches are fast; the maintainer replies that this is "the one-time Neural Engine compile inside
`MLModel(contentsOf:)`" and "the per-update recompile is iOS cache behavior we can't carry across
installs" ([#1022](https://github.com/FluidInference/FluidAudio/issues/1022)). That fits Apple's
rule that the cache is tied to the model path: an app update can change the container path
**[unverified for iOS 26 specifically]**.

On the Mac, time alone did not evict the compiled copy; a differently signed caller did (2.3).
On iOS each app has its own container, so the analogue is a new build: every TestFlight or
development install is a new binary, and #1022 reports a recompile after each one. A developer
installing builds often will see the recompile far more than a user on App Store updates.
**[reasoned]** If the user sees a slow first Dictation on iOS on most days without a new build,
something else evicts the copy; worth checking with the Core ML Instrument, whose load event
says "prepare and cache" for an uncached load and "cached" for a cached one
([WWDC23 10049](https://developer.apple.com/videos/play/wwdc2023/10049/)).

### 2.5 Windows (brief)

The Windows helper is Rust and uses `parakeet-rs` 0.3.8 with ONNX Runtime and the DirectML
execution provider (`native/CodictateWindowsHelper/Cargo.toml`, `src/asr/parakeet.rs`). It is
also spawned per Dictation with the same arguments as the macOS helper (`parakeet-warmup.ts`
comment). There is no Neural Engine compile, but every spawn still builds an ONNX Runtime session
and reads the weights. How long that takes, and whether DirectML caches compiled shaders between
processes, is **unverified** (not measured, no Windows machine). A resident helper would remove it
there too, which keeps the platform parity rule in `AGENTS.md`. The code also falls back to CPU
when DirectML fails, which is outside this note.

## 3. Fix options, ranked

### macOS

**M1. One resident Parakeet helper that loads once and stays alive. (Best.)**
- What: start one helper when Parakeet is the selected Speech Model and keep it running. Extend the
  existing `transcribe-session` NDJSON mode so it can also start and stop `stream vad` and
  `stream live` sessions on request, instead of spawning a new process per Dictation.
- Gain: the model stays loaded in the process, so a Dictation never depends on the compile cache
  surviving. A resident `transcribe-session` helper left idle for 10 minutes answered its next
  request in 0.044 s, and kept doing so while the other helper's runs recompiled the shared
  folder around it (its own copy is held in memory, not looked up again). **[measured,
  2026-10-29]** For a one-channel user the gain is smaller than on this Mac, because a spawned
  helper is already warm (0.15 to 0.25 s) whenever nothing evicted the cache; M1 removes the
  remaining cold cases (first use after an eviction) and the 0.15 s spawn.
- Effort: medium. The protocol grows from "transcribe this WAV" to "start/stop a stream". Mic
  capture, VAD and paste already live in the helper. TS side needs a supervisor that restarts the
  helper if it dies and re-sends nothing (a Dictation in flight just fails loudly, which fits
  ADR-0005). The same change is needed in the Windows Rust helper for parity.
- Risks: a crash or hang now affects the next Dictation, not just one. Mitigate with a supervisor
  and a health ping. Mic must still open before the model is ready on the first start (keep the
  existing "capture first" order). One process holds about 470 MB of Neural Engine memory while
  Parakeet is selected.
- Idle timeout: possible, since the compiled copy survived at least 10 idle minutes without a
  process holding it. After a timeout the next Dictation pays a warm load (about 0.15 s) unless
  something evicted the copy meanwhile. Idle cost is zero CPU (section 4), so a timeout only buys
  back Neural Engine memory.

**M2. Re-load on wake and on a schedule. (Add-on to M1, or a stopgap without it.)**
- What: on system wake (`NSWorkspace.didWakeNotification`), on screen unlock, and when Parakeet
  becomes selected, make sure the resident helper is up and has run one tiny prediction. Without
  M1, the existing boot load in `parakeet-warmup.ts` can also run on wake.
- Gain: covers cases where the system drops ANE state while the process lives (after sleep, under
  memory pressure), or the cache was evicted while the Mac slept. Whether either happens is
  **unverified**; this is defensive.
- Effort: small. A timer-based re-warm is not needed: time alone did not evict the copy.

**M3. Start loading at shortcut press (already done for stream mode; extend to batch).**
- Stream modes already open the mic before loading. Batch `transcribe` spawns after recording ends.
  Spawning the helper at press and handing it the WAV path at release hides up to the recording
  length of the load. Gain is partial: a 3 s Dictation still waits about 10 s for the compile.
  Superseded by M1.

**M4. Encoder on GPU (`encoderComputeUnits: .cpuAndGPU`).**
- FluidAudio documents the option: about 8% faster end to end on M-series Macs, WER-neutral, and
  ANE "remains the default because it is far more power-efficient on iOS"
  ([EncoderComputePlacement.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/ASR/EncoderComputePlacement.md)).
  The maintainer says the GPU encoder "loads in ~1 s with identical WER"
  ([#1022](https://github.com/FluidInference/FluidAudio/issues/1022)).
- Gain: removes the ANE compile entirely on the Mac. GPU compile caching across processes was not
  measured here **[unverified]**.
- Risks: more power while transcribing; competes with the GPU used by the Whisper/hviske harness
  (Metal). Not usable for iOS background work (see I4).
- Measured 2026-10-29 with a FluidAudio 0.17.7 probe on copies of the model folder, one process
  per run **[measured]**:

  | | GPU encoder | ANE (default) |
  |---|---|---|
  | First-ever load | 5.75 s load + 2.34 s first transcribe = 8.59 s | 14.18 s |
  | Warm spawn, 0.5 s silence | 0.42 to 0.43 s wall | 0.13 to 0.14 s wall |
  | Warm spawn after 2 to 3 min idle | 2.5 to 3.0 s load (5 of 5 times) | 0.09 to 0.16 s |
  | Max RSS / peak footprint, warm | 2.41 GB / 1.44 GB | 79 MB / 37 MB |
  | Cache on disk | 1.1 GB under `~/Library/Caches/<process name>/` | none in the user's caches |
  | 23.67 s LibriSpeech clip, later transcribes | RTF about 0.0048 | RTF about 0.0047 |

  Transcripts were byte-identical. **Rejected:** it only wins on a first-ever load, and costs
  about 30 times the memory, a 1.1 GB cache and a slow load after idle.

**M5. Core ML APIs that do not help here.**
- `MLModel.load(contentsOf:configuration:)` loads asynchronously
  ([Apple docs](https://developer.apple.com/documentation/coreml/mlmodel/load(contentsof:configuration:completionhandler:))).
  It moves the wait off a thread; it does not shorten it.
- `MLOptimizationHints.specializationStrategy = .fastPrediction` trades "specialization time,
  memory footprint, and the disk space" for prediction latency
  ([Apple docs](https://developer.apple.com/documentation/coreml/mloptimizationhints-swift.struct/specializationstrategy-swift.enum/fastprediction)),
  so it goes the wrong way for load time. FluidAudio measured these hints as a 26% RTFx regression
  on this model and leaves them off
  ([MLModelConfigurationUtils.swift](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/Shared/MLModelConfigurationUtils.swift)).
- There is no public API to pin or pre-populate the ANE compile cache. **[unverified; none found]**

**M6. Stop the channels evicting each other (developer Macs, and users who run stable and canary).**
- Because a differently signed helper replaces the compiled copy, stable, canary and dev builds
  sharing `~/Library/Application Support/codictate/models` recompile on every switch.
  **[measured for ad-hoc vs Developer ID]**
- Options: give each channel's helper its own executable name (no disk cost; the slot is keyed on
  the process name, see 2.3), give each channel an APFS clone of the models folder (no disk cost,
  but clone bookkeeping on every download and delete), give each channel its own downloaded
  folder (about 470 MB each), or accept it. M1 hides it for whichever channel is running, but the
  first load after a switch still compiles.
- When measuring load times, use one helper only, or the numbers mix the eviction into the result.

### iOS

**I1. Start the load when recording starts. (Best, smallest change.)**
- What: in the recording start path (`beginRecordingWhenActive`, the listen session's
  `beginCapture`, and the Action Button start), fire `Task { try? await engine.warmUp() }` for the
  selected engine. `loadIfNeeded()` then finds a loaded `AsrManager` when the user stops. Guard
  against two concurrent loads (an actor or a stored `Task`).
- Gain: hides the load behind the user's speech. A cached load (about 0.2 to 0.5 s) disappears
  completely. A full recompile (3 to 12 s, or more on new chips) is hidden for as long as the user
  speaks. **[source for load times; gain is reasoned]**
- Effort: small. Risk: low. Works with Neural Engine in the background, since FluidAudio keeps
  every Parakeet component off the GPU "which keeps background execution permitted on iOS"
  ([AsrModels.swift](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/ASR/Parakeet/SlidingWindow/TDT/AsrModels.swift)).

**I2. Load at bootstrap and after an app update.**
- What: in `KeyboardHostRecorder.bootstrap()` (which also runs on background relaunch), if
  Parakeet is selected and `parakeetModelReady` is true, start `warmUp()` at utility priority.
  After an app update, do it on first foreground launch so the recompile happens before the first
  Dictation, ideally with a short "Preparing Parakeet" state in the app. This mirrors the macOS
  "preparation on selection" rule.
- Gain: the first Dictation after a cold launch finds the model loaded. Covers the
  per-update recompile reported in [#1022](https://github.com/FluidInference/FluidAudio/issues/1022),
  if the user opens the app before dictating.
- Effort: small. Risks: a bootstrap load on a background relaunch spends CPU and memory when the
  user may not dictate; the compile itself is a sustained CPU burst, and Apple warns that
  "after a sustained high CPU load in the background, the system will generate an energy exception
  report" and may terminate the app
  ([WWDC20 10078 transcript, mirror](https://nonstrict.eu/wwdcindex/wwdc2020/10078/)). Prefer the
  foreground launch for the post-update compile.

**I3. Keep the models loaded through the warm session, and release on memory warning.**
- What: this already happens while the host process lives (`TranscriptionRouter.shared` keeps the
  engine). Make it explicit: never drop `AsrManager` when the warm session ends, and do drop it in
  `applicationDidReceiveMemoryWarning` / `didReceiveMemoryWarningNotification`
  ([Apple: Responding to memory warnings](https://developer.apple.com/documentation/uikit/responding-to-memory-warnings)).
  Apple's own guidance is to "keep the model loaded if the application will likely be running
  many predictions in a row" and to "unload the model if your app won't use it for a while"
  ([WWDC23 10049](https://developer.apple.com/videos/play/wwdc2023/10049/)).
- Gain: no reload inside a warm session. Effort: small.

**I4. Encoder on GPU on iOS. (Do not.)**
- iOS "restrict[s] a background app's access to the GPU"; commands submitted in the background are
  not executed ([Apple: Preparing your Metal app to run in the background](https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background)).
  Keyboard warm-path Dictations transcribe while the host is in the background, so a GPU encoder
  would fail there. The FluidAudio maintainer says the same: GPU "gives up background execution"
  ([#1022](https://github.com/FluidInference/FluidAudio/issues/1022)). Apple's own enum docs say to
  use `cpuOnly` "if your app might run in the background"
  ([MLComputeUnits](https://developer.apple.com/documentation/coreml/mlcomputeunits)); the Neural
  Engine works in practice per FluidAudio's comment above.
- Related side finding: `WhisperBridge.mm` and `CohereBridge.mm` set `cparams.use_gpu = true` on
  device. If the Whisper or hviske engines run on the keyboard warm path while the host is
  backgrounded, Metal work is blocked by the rule above. Not investigated further. **[unverified
  impact]**

**I5. Pin the FluidAudio version on iOS.** `upToNextMajorVersion` from 0.14.5 lets a clean build
pick any 0.x release, and a FluidAudio bump can change model files or load behaviour. Pinning it
exactly, as the Mac helper does, keeps load-time measurements comparable. Small, low risk.

## 4. Cost of keeping it loaded at all times

### macOS (measured on this Mac unless marked)

| Item | Value |
|---|---|
| Helper process footprint, loaded and idle | 25 to 29 MB `phys_footprint`, 81 MB RSS |
| Peak during a warm load | 67 MB footprint |
| Peak during a cold load (compile) | 526 MB RSS in the helper, plus `ANECompilerService` (278 MB RSS) |
| Neural Engine memory held | about 470 MB (`neural_peak` 468 MB; `aned` `wiredMemory` 491,323,392 B), tagged "neural, nofootprint", 439 MB of it "reclaimable" |
| Idle CPU | 0.00 s of CPU time accumulated over 10 minutes idle (`ps` TIME 0:01.73 before and after, 2026-10-29); `top` CPU 0.0, POWER 0.0, idle wakeups 1 |
| Idle energy | `powermetrics` needs root, so ANE power while idle was not measured. With zero CPU and no predictions, the Neural Engine has no work to do; whether an idle loaded program draws any ANE power is **unverified** |
| Thermal | No sustained work while idle, so no thermal cost from residency. The cost is in the compile (about 10 to 12 s of one busy `ANECompilerService` thread) and that is what residency avoids |

On a 36 GB Mac, 470 MB of Neural Engine memory plus about 30 MB of process memory is small. On an
8 GB Mac it is about 6% of RAM, held for as long as Parakeet is the selected Speech Model. Since the
kernel marks most of it reclaimable, memory pressure may take it back; if that happens the next
Dictation pays a reload or recompile **[unverified]**, which is a reason for the wake/re-load check
in M2.

### iOS (documented limits and reasoned estimates; nothing measured on a phone)

- **Per-app memory limit.** Apple does not publish a number. "The limit does vary from device to
  device. Older devices generally have lower limits", and "the footprint limit is the same in the
  foreground and the background"
  ([WWDC20 10078 transcript, mirror](https://nonstrict.eu/wwdcindex/wwdc2020/10078/)). The live
  headroom is `os_proc_available_memory()`, "the current memory limit minus the memory footprint of
  your app" ([Apple docs](https://developer.apple.com/documentation/os/os_proc_available_memory)).
  The `com.apple.developer.kernel.increased-memory-limit` entitlement raises it "on supported
  devices" only ([Apple docs](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit)).
- **Does the 470 MB Neural Engine copy count toward that limit?** On macOS it is tagged
  "nofootprint", and the XNU rule is that neural memory counts in footprint only when nonvolatile
  and not marked "no footprint"
  ([xnu vm_object.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)).
  iOS runs the same kernel, so it is likely the same, but **unverified on iPhone**. Check with
  Xcode's memory gauge or `os_proc_available_memory()` before and after `loadModels`.
- **Background kill risk.** The main background termination is a memory "pressure exit, also known
  as jetsam", and Apple's advice is "when going into the background, aim for less than 50
  megabytes. The smaller, the better" ([WWDC20 10078 transcript, mirror](https://nonstrict.eu/wwdcindex/wwdc2020/10078/)).
  A `vm-pageshortage` jetsam means "the system ... needed to free background process memory for
  the current foreground app"
  ([Apple: jetsam event reports](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports)).
  Even if the Neural Engine copy does not count toward the per-app limit, it is still physical
  memory, and jetsam reports record it per process (`jse_neural_nofootprint_total_pages`,
  [xnu kern_memorystatus.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus.c)).
  Whether jetsam ranks a background app higher because of it is **unverified**. Reasoned estimate:
  a host holding Parakeet in the background sits well above Apple's 50 MB advice and will be among
  the first apps reclaimed when the foreground app needs memory, especially on 6 to 8 GB iPhones.
- **Interaction with the warm session.** While the listen session runs, the app is alive through
  `UIBackgroundModes: audio` and a running `AVAudioEngine`, so the models stay loaded and every
  Dictation is warm. When the session ends (default 60 s, range 30 to 1800 s), the app is
  suspended and becomes a jetsam candidate like any other. Keeping the models loaded "at all times"
  on iOS therefore means "for as long as iOS keeps the process", which you cannot extend without
  keeping audio running. Apple: "Use background execution modes sparingly because overuse can
  negatively impact device performance and battery life"
  ([Apple: Configuring background execution modes](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes)).
- **Battery and thermal.** A loaded but idle model does no compute, so its direct energy cost is
  near zero **[reasoned; ANE idle power unverified]**. The real battery cost of "always loaded" on
  iOS is the warm session itself: a running `AVAudioEngine` with the mic open, which is the existing
  cost of the warm path, not something Parakeet adds. The compile after each update is a burst of
  several seconds to minutes of CPU and should happen in the foreground (I2).

## 5. Alternatives that avoid the load problem

| Option | Load problem? | Danish? | Notes |
|---|---|---|---|
| Apple `SpeechTranscriber` (iOS 26, macOS 26) | Model lives in the system, "outside of your application's memory space", and "does not increase the run-time memory size" ([WWDC25 277](https://developer.apple.com/videos/play/wwdc2025/277/)). `prepareToAnalyze(in:)` preloads "to reduce or eliminate delays in analyzing the first audio input" ([docs](https://developer.apple.com/documentation/speech/speechanalyzer/preparetoanalyze(in:))). `ModelRetention` `.lingering` keeps models "for a time" and `.processLifetime` "until this process exits" ([docs](https://developer.apple.com/documentation/speech/speechanalyzer/options/modelretention-swift.enum)) | **No.** On this Mac: 30 supported locales (de, en, es, fr, it, ja, ko, pt, yue, zh variants); `AssetInventory.status` for `da-DK` is `unsupported` **[measured]** | Assets download through `AssetInventory`; Apple says "your app can have language support for a limited number of languages at a time" ([WWDC25 277](https://developer.apple.com/videos/play/wwdc2025/277/)). Cold load not measured: the en-US asset is "supported", not installed, on this Mac, and I did not download it |
| Apple `DictationTranscriber` (iOS 26, macOS 26) | Same system-managed model hosting as above **[source for SpeechAnalyzer in general]** | **Yes**, `da-DK` is in its 54 supported locales and its asset status is `supported` (downloadable) **[measured]** | "Uses the same speech-to-text machine learning models as system dictation features" and on-device `SFSpeechRecognizer` ([docs](https://developer.apple.com/documentation/speech/dictationtranscriber)). Older model; accuracy against Parakeet or hviske on Danish not measured here |
| FluidAudio Parakeet TDT-CTC-110M | Still a Neural Engine compile; FluidAudio quotes "19.9s cold start vs 30s+ for v3" ([TDT-CTC-110M.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/ASR/TDT-CTC-110M.md)) | No, English only (same doc) | ~407 MB on disk per the doc |
| FluidAudio Phonon-2 | Smaller ANE encoder (176 to 253 MB options), still ANE compiled | No, English only ([Phonon2.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/ASR/Phonon2.md)) | iOS 18+ |
| FluidAudio Parakeet Ultra / Redux | Same size class as v3; Ultra was slower to compile than v3 on iPhone 18 Pro Max ([#1022](https://github.com/FluidInference/FluidAudio/issues/1022)) | Yes, same 25 languages as v3 ([ParakeetUltra.md](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/ASR/ParakeetUltra.md)) | Does not avoid the problem |
| whisper.cpp / GGML (crispasr: Whisper, Edda, hviske) | No Neural Engine compile when run without Core ML. Each process still reads the weights; whisper.cpp lists runtime memory of ~388 MB for base and ~3.9 GB for large ([README](https://github.com/ggml-org/whisper.cpp/blob/master/README.md)). With its optional Core ML encoder it has the same "first run on a device is slow" compile ([README](https://github.com/ggml-org/whisper.cpp/blob/master/README.md)) | Whisper and hviske, yes | On iOS the GPU (Metal) path is blocked in the background (see I4); the Mac harness spawns per Dictation and pays a weight read each time (page cache usually makes it fast, **[unverified for Codictate's models]**) |

Parakeet TDT 0.6B v3 itself supports Danish (`da` is one of its 25 languages,
[NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)). The FluidInference Core ML
card says "25 European languages", macOS 14+ and iOS 17+, and does not cover load time
([HF card](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml)).

Bottom line: nothing that runs on the Neural Engine through Core ML avoids the compile; only Apple's
system-hosted SpeechAnalyzer models move it out of the app, and the better of those
(`SpeechTranscriber`) has no Danish. For Danish, hviske stays the iOS Danish model (user decision)
and `DictationTranscriber` is the only system-hosted option.

## 6. Recommendation

**macOS:** much of the slowness seen on the developer Mac is stable, canary and dev helpers
evicting each other's compiled copy (M6); a one-channel user hits the compile far less, and the
2026-10-29 measurements suggest an app update does not cause one. So fix when the load happens
rather than keeping a process alive: load in the background at launch, on selection and after a
download, and have a Dictation wait on that load. Stop the channels evicting each other by giving
each channel's helper its own executable name. M4 (GPU encoder) was measured and rejected. M1
(resident helper) stays a fallback if users still report a slow first Dictation after that ships.
The decisions are in section 7.

**iOS:** do I1 (warm up at record start) and I2 (the first foreground launch after an update)
now; both are small. Add I3's memory-warning release and I5's exact FluidAudio pin. Keep the Neural
Engine (not GPU). Then measure on a phone with the Core ML Instrument to see whether the slow first
Dictation is a cached load (fixed by I1) or a recompile (only hidden by I1, and avoided by I2 if the
app is opened first). Do not extend the warm session just to keep the model loaded: the battery cost
of an open mic outweighs a sub-second cached load.

## 7. Decisions (2026-10-29)

Settled in a review of this note. Domain wording is in `GLOSSARY.md` (Parakeet Preparation).

macOS and Windows:
- **Parakeet Preparation can recur, and Cold Start is not a separate thing.** Every slow load
  measured was a recompile; loading a prepared copy takes about 20 ms. The glossary drops Cold
  Start.
- **One load path.** Parakeet loads in the background at app launch, when it becomes the selected
  Speech Model, and when its download finishes. A Dictation that starts during that load waits on
  it rather than spawning a second helper. The persisted "prepared" flag no longer decides
  anything. Only the Dictation's Speech Model is loaded; a File Transcription on Parakeet pays any
  Preparation in its Processing Time.
- **Only a Batch Dictation waits on that load. Live Transcription never does:** its helper opens
  the mic before it loads, so a wait would lose speech. Spawning beside the background load is
  safe: two helpers compiling the same weights at once both exited 0 (15.5 s and 26.4 s), and the
  next run was warm (0.15 s). **[measured, 2026-10-29]**
- **Settings shows "Preparing" only once a load has run for more than about 1 s.** The recording
  indicator is unchanged: on Live Transcription the mic is already open and text catches up, on
  Batch the transcribing state lasts longer.
- **No wake trigger (M2).** Launch already covers app updates, OS updates and reboots (there is no
  launch at login), and sleep showed no eviction.
- **Each channel's macOS helper gets its own executable name** (stable, canary, dev), to be
  confirmed on the real helpers. Windows has no Neural Engine compile, so this is macOS only.
- **Rejected:** M4 (GPU encoder), per-channel model folders or clones. **Parked:** M1 (resident
  helper).

iOS (`codictate-app`):
- I1 for Parakeet only; Whisper and hviske wait until someone checks whether their Metal work runs
  with the host in the background.
- I2 on the first foreground launch after an update, not on a background relaunch.
- I3 and I5 as written.

Parked: `DictationTranscriber` as a Danish system-hosted Speech Engine (section 5).

Still unmeasured: whether a reboot evicts the compiled copy, and a Developer ID signed app update.

## 8. Sources

Apple
- WWDC23 10049, Improve Core ML integration with async prediction (transcript): https://developer.apple.com/videos/play/wwdc2023/10049/
- WWDC25 277, Bring advanced speech-to-text to your app with SpeechAnalyzer (transcript): https://developer.apple.com/videos/play/wwdc2025/277/
- WWDC20 10078, Why is my app getting killed? (Apple transcript via the nonstrict.eu WWDC index mirror; the session is unlisted on developer.apple.com): https://nonstrict.eu/wwdcindex/wwdc2020/10078/
- `MLModel.load(contentsOf:configuration:completionHandler:)`: https://developer.apple.com/documentation/coreml/mlmodel/load(contentsof:configuration:completionhandler:)
- `MLComputeUnits`: https://developer.apple.com/documentation/coreml/mlcomputeunits
- `MLOptimizationHints.SpecializationStrategy.fastPrediction`: https://developer.apple.com/documentation/coreml/mloptimizationhints-swift.struct/specializationstrategy-swift.enum/fastprediction
- `os_proc_available_memory`: https://developer.apple.com/documentation/os/os_proc_available_memory
- Increased memory limit entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit
- Identifying high-memory use with jetsam event reports: https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports
- Responding to memory warnings: https://developer.apple.com/documentation/uikit/responding-to-memory-warnings
- Configuring background execution modes: https://developer.apple.com/documentation/xcode/configuring-background-execution-modes
- Preparing your Metal app to run in the background: https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background
- `SpeechTranscriber`: https://developer.apple.com/documentation/speech/speechtranscriber
- `DictationTranscriber`: https://developer.apple.com/documentation/speech/dictationtranscriber
- `SpeechAnalyzer`, `prepareToAnalyze(in:)`, `Options.ModelRetention`: https://developer.apple.com/documentation/speech/speechanalyzer
- XNU source (Apple open source): `osfmk/vm/vm_object.c`, `osfmk/kern/task.c`, `bsd/kern/kern_memorystatus.c`, `tests/vm/neural_footprint.c` at https://github.com/apple-oss-distributions/xnu

FluidAudio (FluidInference)
- Source at v0.17.7 (macOS pin) and v0.15.7 (iOS resolved): https://github.com/FluidInference/FluidAudio (`AsrModels.swift`, `AsrManager.swift`, `MLModelConfigurationUtils.swift`, `ModelHub.swift`)
- `Documentation/Benchmarks.md` (ASR Model Compilation), `Documentation/ANE_Profiler.md`, `Documentation/ASR/EncoderComputePlacement.md`, `TDT-CTC-110M.md`, `Phonon2.md`, `ParakeetUltra.md`, `ParakeetRedux.md`
- Issue #1022, encoder load after each app update: https://github.com/FluidInference/FluidAudio/issues/1022
- Model card: https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml
- NVIDIA model card (languages): https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3

Other
- whisper.cpp README (Core ML first-run compile, memory table): https://github.com/ggml-org/whisper.cpp/blob/master/README.md

Local evidence (this Mac, 2026-10-28)
- Unified log: `log show --info --debug --predicate 'process == "aned" OR process == "ANECompilerService" OR process == "CodictateParakeetHelper"'`, 14:41 to 20:15.
- `/usr/bin/time -l` runs of both helpers against a 0.5 s silent 16 kHz WAV; `footprint` and `vmmap --summary` on a resident `transcribe-session` helper; `top -l` and `ps` for idle CPU.
- `~/Library/Caches/CodictateParakeetHelper/com.apple.e5rt.e5bundlecache/25G83/` listing.
- Swift probe of `SpeechTranscriber.supportedLocales`, `DictationTranscriber.supportedLocales` and `AssetInventory.status` on macOS 26.6.2.
- Code: `codictate/native/CodictateParakeetHelper/`, `codictate/src/bun/utils/whisper/parakeet-warmup.ts`, `codictate/native/CodictateWindowsHelper/`, `codictate-app/targets/codictateapp/{ParakeetEngine,KeyboardHostRecorder,KeyboardListenSession,ModelManager}.swift`, `codictate-app/plugins/withFluidAudio.ts`.
