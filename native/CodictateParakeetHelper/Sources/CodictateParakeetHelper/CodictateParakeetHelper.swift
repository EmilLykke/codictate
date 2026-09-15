@preconcurrency import AVFoundation
import CoreAudio
import Darwin
import FluidAudio
import Foundation

// MARK: - Helpers

/// Bun sets `CODICTATE_STREAM_DEBUG_ID` when spawning stream mode so stderr lines match TS `streamDebugId`.
private enum StreamSessionLog {
  /// One Parakeet helper process per stream; tag is set once in `streamCommand` before any logging.
  nonisolated(unsafe) static var stderrTag: String = ""
}

private func logPhase(_ msg: String) {
  let tag = StreamSessionLog.stderrTag
  let line =
    tag.isEmpty
    ? "[CodictateParakeetHelper] \(msg)\n"
    : "[CodictateParakeetHelper]\(tag) \(msg)\n"
  FileHandle.standardError.write(Data(line.utf8))
  fflush(__stderrp)
}

/// Set `CODICTATE_LIVE_DEBUG=1` in the environment (app inherits it when spawning the helper)
/// to log partial vs commit decisions on stderr — surfaced in Bun logs as `parakeet stderr`.
private func logLiveDebug(_ msg: String) {
  guard liveStreamDebugEnabled() else { return }
  logPhase("stream [live][debug] \(msg)")
}

private func liveStreamDebugEnabled() -> Bool {
  let v = ProcessInfo.processInfo.environment["CODICTATE_LIVE_DEBUG"]?.lowercased() ?? ""
  return v == "1" || v == "true" || v == "yes"
}

private func debugSnippet(_ s: String, maxLen: Int = 100) -> String {
  let t = s.replacingOccurrences(of: "\n", with: " ")
  if t.count <= maxLen { return t }
  return String(t.prefix(maxLen)) + "…"
}

private func emitJSON(_ obj: [String: Any]) {
  var data = try! JSONSerialization.data(withJSONObject: obj)
  data.append(0x0a)
  FileHandle.standardOutput.write(data)
  fflush(__stdoutp)
}

private func usage() -> Never {
  let msg = """
    Usage:
      CodictateParakeetHelper transcribe <wavPath> <parakeetModelDir>
      CodictateParakeetHelper transcribe-session <parakeetModelDir>
      CodictateParakeetHelper stream <vad|live> <parakeetModelDir>
    """
  FileHandle.standardError.write(Data(msg.utf8))
  FileHandle.standardError.write(Data([0x0a]))
  exit(2)
}

private func loadAsrModels(parakeetDir: URL) async throws -> AsrModels {
  let cfg = AsrModels.defaultConfiguration()
  return try await AsrModels.load(from: parakeetDir, configuration: cfg, version: .v3)
}

private func joinTranscript(_ prefix: String, _ suffix: String) -> String {
  if prefix.isEmpty { return suffix }
  if suffix.isEmpty { return prefix }
  return prefix + " " + suffix
}

private func padToMinimumTranscribeLength(
  _ samples: [Float], minimum: Int = 16_000
) -> [Float] {
  if samples.count >= minimum { return samples }
  return samples + Array(repeating: 0, count: minimum - samples.count)
}

/// Live mode: full-buffer ASR sometimes returns empty (trailing silence / edge cases) while
/// partials were non-empty — without a fallback the UI keeps stale `injectedDisplay` vs
/// `committedText` and the next utterance looks like every other phrase was dropped.
private func resolveLiveUtteranceText(finalRaw: String, lastPartial: String) -> String {
  let f = finalRaw.trimmingCharacters(in: .whitespacesAndNewlines)
  if !f.isEmpty { return f }
  return lastPartial.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Spoken-form ASR → written-form (numbers, money, dates, etc.) via NeMo ITN
/// ([FluidInference/text-processing-rs](https://github.com/FluidInference/text-processing-rs)).
/// Used for one-shot `transcribe` and stream **VAD** only — live stream stays raw for stable partials.
private func applyInverseTextNormalization(_ raw: String) -> String {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }
  return NemoTextProcessing.normalizeSentence(trimmed)
}

/// Builds an AVAudioConverter from `source` format → 16 kHz mono Float32.
private func makeConverter(from source: AVAudioFormat) -> AVAudioConverter? {
  guard
    let target = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false)
  else { return nil }
  return AVAudioConverter(from: source, to: target)
}

private final class AudioFeedState: @unchecked Sendable {
  private let lock = NSLock()
  private var hasFed = false

  func claimInput() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if hasFed { return false }
    hasFed = true
    return true
  }
}

/// Convert one hardware-format `AVAudioPCMBuffer` to a 16 kHz mono `[Float]`.
private func convert(_ buffer: AVAudioPCMBuffer, using converter: AVAudioConverter) -> [Float] {
  let ratio = 16_000 / buffer.format.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
  guard
    let out = AVAudioPCMBuffer(
      pcmFormat: converter.outputFormat,
      frameCapacity: capacity)
  else { return [] }

  var err: NSError?
  let feedState = AudioFeedState()
  converter.convert(to: out, error: &err) { _, status in
    if !feedState.claimInput() {
      status.pointee = .noDataNow
      return nil
    }
    status.pointee = .haveData
    return buffer
  }
  guard err == nil, let ch = out.floatChannelData else { return [] }
  let n = Int(out.frameLength)
  var samples = [Float](repeating: 0, count: n)
  for i in 0..<n { samples[i] = ch[0][i] }
  return samples
}

private func getDefaultOutputDevice() -> AudioDeviceID {
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  _ = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
  return id
}

private func getDeviceTransportType(_ id: AudioDeviceID) -> UInt32 {
  var transport: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyTransportType,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport) == noErr else {
    return 0
  }
  return transport
}

private func outputDeviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var cfName: CFString?
  var size = UInt32(MemoryLayout<CFString?>.size)
  let err = withUnsafeMutablePointer(to: &cfName) { ptr in
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
  }
  if err == noErr, let s = cfName {
    return s as String
  }
  return "Device \(id)"
}

private enum OutputDeviceKind {
  case builtIn
  case headphone
  case other
}

private func classifyOutputDevice(_ id: AudioDeviceID) -> OutputDeviceKind {
  guard id != 0 else { return .other }
  let transport = getDeviceTransportType(id)
  if transport == kAudioDeviceTransportTypeAggregate || transport == kAudioDeviceTransportTypeVirtual {
    return .other
  }
  let name = outputDeviceName(id)
  if transport == kAudioDeviceTransportTypeBluetooth
    || transport == kAudioDeviceTransportTypeUSB
    || name.localizedCaseInsensitiveContains("headphone")
    || name.localizedCaseInsensitiveContains("headset")
    || name.localizedCaseInsensitiveContains("airpods")
  {
    return .headphone
  }
  if transport == kAudioDeviceTransportTypeBuiltIn { return .builtIn }
  return .other
}

private struct SavedOutputVolume {
  let device: AudioDeviceID
  let scalar: Float32
}

private func outputVolumeScalarAddress() -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyVolumeScalar,
    mScope: kAudioDevicePropertyScopeOutput,
    mElement: kAudioObjectPropertyElementMain)
}

private func tryApplyOutputDuck(
  builtInEnabled: Bool,
  headphonesEnabled: Bool,
  headphoneLevel: Int
) -> SavedOutputVolume? {
  let device = getDefaultOutputDevice()
  let kind = classifyOutputDevice(device)
  guard
    (kind == .builtIn && builtInEnabled) || (kind == .headphone && headphonesEnabled)
  else { return nil }
  var addr = outputVolumeScalarAddress()
  guard AudioObjectHasProperty(device, &addr) else { return nil }
  var settable: DarwinBoolean = false
  guard AudioObjectIsPropertySettable(device, &addr, &settable) == noErr, settable.boolValue else {
    return nil
  }
  var current: Float32 = 1
  var size = UInt32(MemoryLayout<Float32>.size)
  guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &current) == noErr else {
    return nil
  }
  let ducked: Float32 = kind == .builtIn ? 0 : Float32(max(0, min(100, headphoneLevel))) / 100.0
  guard ducked + 0.02 < current else { return nil }
  var toWrite = ducked
  guard AudioObjectSetPropertyData(device, &addr, 0, nil, size, &toWrite) == noErr else {
    return nil
  }
  return SavedOutputVolume(device: device, scalar: current)
}

private func restoreOutputDuck(_ saved: SavedOutputVolume) {
  var addr = outputVolumeScalarAddress()
  guard AudioObjectHasProperty(saved.device, &addr) else {
    logPhase("stream: output device gone, cannot restore volume")
    return
  }
  let size = UInt32(MemoryLayout<Float32>.size)
  var scalar = saved.scalar
  if AudioObjectSetPropertyData(saved.device, &addr, 0, nil, size, &scalar) != noErr {
    logPhase("stream: failed to restore output volume")
  }
}

private final class StreamOutputDuckCoordinator: @unchecked Sendable {
  static let shared = StreamOutputDuckCoordinator()

  private let lock = NSLock()
  private var savedOutputVolume: SavedOutputVolume?
  private var stopped = false

  func begin(
    delaySeconds: TimeInterval,
    builtInEnabled: Bool,
    headphonesEnabled: Bool,
    headphoneLevel: Int
  ) {
    lock.lock()
    stopped = false
    lock.unlock()

    let apply: @Sendable () -> Void = { [weak self] in
      self?.applyIfNeeded(
        builtInEnabled: builtInEnabled,
        headphonesEnabled: headphonesEnabled,
        headphoneLevel: headphoneLevel)
    }
    if delaySeconds <= 0 {
      DispatchQueue.global().async {
        apply()
      }
    } else {
      DispatchQueue.global().asyncAfter(deadline: .now() + delaySeconds) {
        apply()
      }
    }
  }

  private func applyIfNeeded(
    builtInEnabled: Bool,
    headphonesEnabled: Bool,
    headphoneLevel: Int
  ) {
    lock.lock()
    let alreadyStopped = stopped || savedOutputVolume != nil
    lock.unlock()
    if alreadyStopped { return }
    guard
      let applied = tryApplyOutputDuck(
        builtInEnabled: builtInEnabled,
        headphonesEnabled: headphonesEnabled,
        headphoneLevel: headphoneLevel)
    else { return }
    lock.lock()
    defer { lock.unlock() }
    if stopped {
      restoreOutputDuck(applied)
      return
    }
    savedOutputVolume = applied
  }

  func end() {
    lock.lock()
    stopped = true
    let saved = savedOutputVolume
    savedOutputVolume = nil
    lock.unlock()
    if let saved {
      restoreOutputDuck(saved)
    }
  }
}

private enum StreamSignalHandlers {
  nonisolated(unsafe) static var sigint: DispatchSourceSignal?
  nonisolated(unsafe) static var sigterm: DispatchSourceSignal?
}

private func outputDuckDelaySecondsFromEnv() -> TimeInterval {
  let raw = ProcessInfo.processInfo.environment["CODICTATE_OUTPUT_DUCK_DELAY_MS"] ?? ""
  guard let ms = Int(raw), ms >= 0, ms <= 10_000 else { return 0.248 }
  return Double(ms) / 1000.0
}

private func outputDuckBuiltInEnabledFromEnv() -> Bool {
  let raw = ProcessInfo.processInfo.environment["CODICTATE_OUTPUT_DUCK_BUILT_IN"] ?? "1"
  return raw != "0"
}

private func outputDuckHeadphonesEnabledFromEnv() -> Bool {
  let raw = ProcessInfo.processInfo.environment["CODICTATE_OUTPUT_DUCK_HEADPHONES"] ?? "0"
  return raw != "0"
}

private func outputDuckLevelFromEnv() -> Int {
  let raw = ProcessInfo.processInfo.environment["CODICTATE_OUTPUT_DUCK_LEVEL"] ?? "0"
  guard let value = Int(raw) else { return 0 }
  return max(0, min(100, value))
}

private func installStreamSignalHandlersForCleanup() {
  signal(SIGPIPE, SIG_IGN)

  let cleanupAndExit: @convention(block) () -> Void = {
    StreamOutputDuckCoordinator.shared.end()
    exit(0)
  }

  let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
  sigint.setEventHandler(handler: cleanupAndExit)
  signal(SIGINT, SIG_IGN)
  sigint.resume()

  let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
  sigterm.setEventHandler(handler: cleanupAndExit)
  signal(SIGTERM, SIG_IGN)
  sigterm.resume()

  StreamSignalHandlers.sigint = sigint
  StreamSignalHandlers.sigterm = sigterm
}

// MARK: - Main

@main
struct CodictateParakeetHelperMain {
  static func main() async {
    do {
      try await run()
    } catch {
      let line = "codictate-parakeet-helper: \(error)\n"
      FileHandle.standardError.write(Data(line.utf8))
      exit(1)
    }
  }

  static func run() async throws {
    var args = CommandLine.arguments
    args.removeFirst()
    guard let cmd = args.first else { usage() }
    args.removeFirst()

    switch cmd {
    case "transcribe": try await transcribeCommand(args)
    case "transcribe-session": try await transcribeSessionCommand(args)
    case "stream": try await streamCommand(args)
    default: usage()
    }
  }

  // MARK: - transcribe (single WAV → JSON)

  static func transcribeCommand(_ args: [String]) async throws {
    guard args.count >= 2 else { usage() }
    let wavPath = args[0]
    let modelDir = URL(fileURLWithPath: args[1], isDirectory: true)

    logPhase("loading models (first run may prepare model assets for this Mac — can take a few minutes)…")
    let models = try await loadAsrModels(parakeetDir: modelDir)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    logPhase("transcribing…")
    let result = try await asr.transcribe(URL(fileURLWithPath: wavPath), source: .system)
    let text = applyInverseTextNormalization(result.text)
    logPhase("done")
    emitJSON(["kind": "final", "text": text])
  }

  // MARK: - transcribe-session (one model load, sequential WAV requests over NDJSON)

  private struct TranscribeSessionRequest: Decodable {
    let id: Int
    let audioPath: String
  }

  /// Benchmark-only batch session. Dictation keeps using the compatible one-shot command.
  static func transcribeSessionCommand(_ args: [String]) async throws {
    guard let modelPath = args.first else { usage() }
    let modelDir = URL(fileURLWithPath: modelPath, isDirectory: true)

    logPhase("transcribe session: loading models…")
    let models = try await loadAsrModels(parakeetDir: modelDir)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)
    emitJSON(["kind": "ready"])

    let decoder = JSONDecoder()
    while let line = readLine() {
      if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
      let request = try decoder.decode(
        TranscribeSessionRequest.self,
        from: Data(line.utf8)
      )
      guard request.id >= 0, !request.audioPath.isEmpty else {
        throw NSError(
          domain: "CodictateParakeet",
          code: 4,
          userInfo: [NSLocalizedDescriptionKey: "invalid transcribe-session request"]
        )
      }

      logPhase("transcribe session: request \(request.id)…")
      let result = try await asr.transcribe(
        URL(fileURLWithPath: request.audioPath),
        source: .system
      )
      let text = applyInverseTextNormalization(result.text)
      emitJSON(["kind": "final", "id": request.id, "text": text])
    }

    logPhase("transcribe session: stdin closed")
  }

  // MARK: - stream (mic → inject text locally; no stdout protocol)

  /// Stream modes capture from the mic, transcribe with Parakeet TDT, and inject text
  /// into the focused app via the same clipboard + Cmd+V path as KeyListener.
  /// Stdout is unused; the Bun host only spawns/stops this process.
  ///
  /// **vad** — RMS VAD, one batch transcription per utterance (silence commit), paste + space.
  ///
  /// **live** — Re-transcribe the growing buffer on a cadence (≥1s audio, no partial padding),
  ///            updating the focused field with append-or-LCP-replace. Raw ASR text (no ITN).
  static func streamCommand(_ args: [String]) async throws {
    guard args.count >= 2 else { usage() }
    let mode = args[0]
    let modelDir = URL(fileURLWithPath: args[1], isDirectory: true)

    if let sid = ProcessInfo.processInfo.environment["CODICTATE_STREAM_DEBUG_ID"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !sid.isEmpty
    {
      StreamSessionLog.stderrTag = " [s\(sid)]"
    } else {
      StreamSessionLog.stderrTag = ""
    }

    logPhase("stream [\(mode)]: loading models…")
    let models = try await loadAsrModels(parakeetDir: modelDir)
    logPhase("stream [\(mode)]: models ready")
    installStreamSignalHandlersForCleanup()
    let duckBuiltInOutput = outputDuckBuiltInEnabledFromEnv()
    let duckHeadphoneOutput = outputDuckHeadphonesEnabledFromEnv()
    let duckLevel = outputDuckLevelFromEnv()
    if duckBuiltInOutput || duckHeadphoneOutput {
      StreamOutputDuckCoordinator.shared.begin(
        delaySeconds: outputDuckDelaySecondsFromEnv(),
        builtInEnabled: duckBuiltInOutput,
        headphonesEnabled: duckHeadphoneOutput,
        headphoneLevel: duckLevel)
    }
    defer {
      if duckBuiltInOutput || duckHeadphoneOutput {
        StreamOutputDuckCoordinator.shared.end()
      }
    }

    if mode == "vad" {
      try await runVadMode(models: models)
    } else {
      try await runLiveMode(models: models)
    }
  }

  // MARK: VAD mode

  static func runVadMode(models: AsrModels) async throws {
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)

    guard let converter = makeConverter(from: hwFormat) else {
      throw NSError(
        domain: "CodictateParakeet", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Cannot create audio converter"])
    }

    // Pipe converted 16 kHz chunks into an AsyncStream for sequential VAD processing.
    let (audioStream, audioContinuation) = AsyncStream<[Float]>.makeStream()

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
      let samples = convert(buffer, using: converter)
      if !samples.isEmpty { audioContinuation.yield(samples) }
    }

    try engine.start()
    logPhase("stream [vad]: audio engine running")

    // VAD parameters (16 kHz sample counts)
    let rmsThreshold: Float = 0.012   // energy gate
    let silenceCommit = 8_000         // 500 ms silence → commit utterance
    let minUtterance = 8_000          // 500 ms minimum to bother transcribing
    let maxUtterance = 16_000 * 30    // hard cap at 30 s

    var utterance: [Float] = []
    var inSpeech = false
    var silenceAccum = 0

    for await chunk in audioStream {
      let rms = sqrt(chunk.map { $0 * $0 }.reduce(0, +) / Float(chunk.count))

      if rms >= rmsThreshold {
        silenceAccum = 0
        if !inSpeech {
          inSpeech = true
          utterance = []
          logPhase("stream [vad]: speech start")
        }
        utterance.append(contentsOf: chunk)

        // Hard cap — force a transcription and keep going
        if utterance.count >= maxUtterance {
          await transcribeVadAndInject(asr: asr, samples: utterance)
          utterance = []
        }
      } else if inSpeech {
        utterance.append(contentsOf: chunk)
        silenceAccum += chunk.count

        if silenceAccum >= silenceCommit {
          inSpeech = false
          silenceAccum = 0
          logPhase("stream [vad]: speech end — transcribing \(utterance.count) samples")
          if utterance.count >= minUtterance {
            await transcribeVadAndInject(asr: asr, samples: utterance)
          }
          utterance = []
        }
      }
    }
  }

  private static func transcribeVadAndInject(asr: AsrManager, samples: [Float]) async {
    do {
      let result = try await asr.transcribe(samples, source: .microphone)
      let text = applyInverseTextNormalization(result.text)
      guard !text.isEmpty else { return }
      logPhase("stream [vad]: pasting \(text.count) chars")
      await StreamInjection.pasteOnly(text + " ")
    } catch {
      logPhase("stream [vad]: transcription error: \(error)")
    }
  }

  // MARK: Live mode

  static func runLiveMode(models: AsrModels) async throws {
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let hwFormat = inputNode.outputFormat(forBus: 0)

    guard let converter = makeConverter(from: hwFormat) else {
      throw NSError(
        domain: "CodictateParakeet", code: 4,
        userInfo: [NSLocalizedDescriptionKey: "Cannot create audio converter"])
    }

    let (audioStream, audioContinuation) = AsyncStream<[Float]>.makeStream()

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
      let samples = convert(buffer, using: converter)
      if !samples.isEmpty { audioContinuation.yield(samples) }
    }

    try engine.start()
    logPhase("stream [live]: audio engine running")
    if liveStreamDebugEnabled() {
      logPhase(
        "stream [live][debug] CODICTATE_LIVE_DEBUG on — logging partials, commits, discards")
    }

    // FluidAudio rejects < 1s of audio (`invalidAudioData`). Do not zero-pad partial
    // snapshots — padding makes TDT hallucinate long junk, then finals are shorter and
    // the UI deletes huge spans. Partials only run on real ≥1s buffers; short tails
    // are padded only once at utterance end.
    let rmsThreshold: Float = 0.010
    // ~1.5s @ 16kHz — longer than brief phrase gaps so one PTT hold stays fewer segments / less churn.
    let silenceCommit = 24_000
    let minUtterance = 2_400
    // FluidAudio requires ≥1s of audio per call; cannot go lower for first partial.
    let minSamplesForInfer = 16_000
    // How much new 16kHz audio between re-transcribe passes (~300ms). Smaller =
    // snappier UI but more ANE work; wall time is still dominated by TDT on long buffers.
    let minSamplesBetweenUpdates = 4_800
    let maxUtterance = 16_000 * 20

    var committedText = ""
    var utterance: [Float] = []
    var inSpeech = false
    /// Live mode only: increments when the RMS gate opens a new segment after a silence commit (same process).
    var utteranceSegmentIndex = 0
    var silenceAccum = 0
    var samplesSinceLastUpdate = 0
    var lastLiveText = ""
    var injectedDisplay = ""

    for await chunk in audioStream {
      let rms = sqrt(chunk.map { $0 * $0 }.reduce(0, +) / Float(chunk.count))

      if rms >= rmsThreshold {
        silenceAccum = 0
        if !inSpeech {
          inSpeech = true
          utteranceSegmentIndex += 1
          utterance = []
          samplesSinceLastUpdate = 0
          lastLiveText = ""
          logPhase(
            "stream [live]: segment #\(utteranceSegmentIndex) — voice active (same process)")
        }

        utterance.append(contentsOf: chunk)
        samplesSinceLastUpdate += chunk.count

        let shouldEmitUpdate =
          utterance.count >= minSamplesForInfer &&
          samplesSinceLastUpdate >= minSamplesBetweenUpdates
        if shouldEmitUpdate {
          samplesSinceLastUpdate = 0
          let partialText = try await asr
            .transcribe(utterance, source: .microphone)
            .text
          guard !partialText.isEmpty, partialText != lastLiveText else { continue }
          lastLiveText = partialText
          let fullText = joinTranscript(committedText, partialText)
          logLiveDebug(
            "partial utteranceSamples=\(utterance.count) text=\(debugSnippet(partialText))")
          await StreamInjection.updateLiveLine(
            displayed: &injectedDisplay,
            newFull: fullText
          )
        }

        if utterance.count >= maxUtterance {
          let finalInput =
            utterance.count >= minSamplesForInfer
            ? utterance
            : padToMinimumTranscribeLength(utterance)
          let lastPartialSnapshot = lastLiveText
          let rawFinal = try await asr
            .transcribe(finalInput, source: .microphone)
            .text
          let finalText = resolveLiveUtteranceText(
            finalRaw: rawFinal, lastPartial: lastPartialSnapshot)
          let fallback =
            rawFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !lastPartialSnapshot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          logLiveDebug(
            "commit[maxUtterance] samples=\(finalInput.count) fallbackToPartial=\(fallback) text=\(debugSnippet(finalText))"
          )
          if !finalText.isEmpty {
            committedText = joinTranscript(committedText, finalText)
            await StreamInjection.updateLiveLine(
              displayed: &injectedDisplay,
              newFull: committedText
            )
          }
          lastLiveText = ""
          utterance = []
          samplesSinceLastUpdate = 0
        }
      } else if inSpeech {
        utterance.append(contentsOf: chunk)
        silenceAccum += chunk.count

        if silenceAccum >= silenceCommit {
          inSpeech = false
          silenceAccum = 0
          logPhase(
            "stream [live]: segment #\(utteranceSegmentIndex) — silence commit (finalising)")
          if utterance.count >= minUtterance {
            let finalInput =
              utterance.count >= minSamplesForInfer
              ? utterance
              : padToMinimumTranscribeLength(utterance)
            let lastPartialSnapshot = lastLiveText
            let rawFinal = try await asr
              .transcribe(finalInput, source: .microphone)
              .text
            let finalText = resolveLiveUtteranceText(
              finalRaw: rawFinal, lastPartial: lastPartialSnapshot)
            let fallback =
              rawFinal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              && !lastPartialSnapshot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            logLiveDebug(
              "commit[silence] samples=\(finalInput.count) fallbackToPartial=\(fallback) text=\(debugSnippet(finalText))"
            )
            if !finalText.isEmpty {
              committedText = joinTranscript(committedText, finalText)
              await StreamInjection.updateLiveLine(
                displayed: &injectedDisplay,
                newFull: committedText
              )
            }
          } else {
            logLiveDebug(
              "discard[short] utteranceSamples=\(utterance.count) min=\(minUtterance) (no commit)")
          }
          utterance = []
          samplesSinceLastUpdate = 0
          lastLiveText = ""
        }
      }
    }
  }
}
