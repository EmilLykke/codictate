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
      CodictateParakeetHelper stream <vad|live> <parakeetModelDir> [deviceIndex]
    """
  FileHandle.standardError.write(Data(msg.utf8))
  FileHandle.standardError.write(Data([0x0a]))
  exit(2)
}

/// Loads the Core ML weights from exactly `parakeetDir`, never from the network.
///
/// `AsrModels.load(from:)` would read `parakeetDir`'s parent plus FluidAudio's own folder
/// name for the repo, and fetch whatever it finds missing from Hugging Face `main`. Codictate
/// downloads a pinned revision itself (`model-manager.ts`), so a missing file must fail here.
/// The default `.int8` precision is the original `Encoder.mlmodelc`, the one Codictate ships.
private func loadAsrModels(parakeetDir: URL) throws -> AsrModels {
  let cfg = AsrModels.defaultConfiguration()
  return try AsrModels.loadLocal(from: parakeetDir, version: .v3, configuration: cfg)
}

/// One independent transcription. Since FluidAudio 0.13.7 the caller owns the TDT decoder
/// state; a fresh one per call matches the old `transcribe(_:source:)`, which reset its
/// per-source state after every call.
private func transcribeOnce(_ asr: AsrManager, _ url: URL) async throws -> ASRResult {
  var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
  return try await asr.transcribe(url, decoderState: &state)
}

private func transcribeOnce(_ asr: AsrManager, _ samples: [Float]) async throws -> ASRResult {
  var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
  return try await asr.transcribe(samples, decoderState: &state)
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

// MARK: - Input device selection

private func coreAudioInputChannelCount(_ id: AudioDeviceID) -> Int {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0
  else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return 0 }
  let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

private func coreAudioDeviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr,
    let name
  else { return "Device \(id)" }
  return name.takeRetainedValue() as String
}

private func coreAudioDeviceUID(_ id: AudioDeviceID) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var uid: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &uid) == noErr, let uid
  else { return nil }
  return uid.takeRetainedValue() as String
}

/// Input devices in the order `MicRecorder --list-devices` numbers them: every Core Audio
/// device with at least one input channel, sorted by `AudioDeviceID`. The Microphone reaches
/// this helper as its device UID, or as an index into that list for a device without one, so
/// it must stay identical to `listInputDevices` in `src/bun/utils/audio/MicRecorder.swift`.
private func listInputDeviceIDs() -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  let system = AudioObjectID(kAudioObjectSystemObject)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.filter { coreAudioInputChannelCount($0) > 0 }.sorted()
}

private func getDefaultInputDevice() -> AudioDeviceID {
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  _ = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
  return id
}

/// The mic the user selected in Codictate, so Live Transcription records from the same device as
/// batch Dictation (and as the Windows helper does).
///
/// Without a `deviceRef` this is the system default input, which is not necessarily the selected
/// mic: with a MacBook lid closed the default is often the built-in microphone, which then
/// delivers silence. A `deviceRef` that does not name a current input device is an error, never
/// a quiet switch to the default.
private func resolveStreamInputDevice(deviceRef: String?, mode: String) throws -> AudioDeviceID {
  guard let deviceRef else {
    let id = getDefaultInputDevice()
    logPhase("stream [\(mode)]: input device: system default (\(coreAudioDeviceName(id)))")
    return id
  }
  let devices = listInputDeviceIDs()
  let index =
    devices.firstIndex(where: { coreAudioDeviceUID($0) == deviceRef })
    ?? Int(deviceRef).flatMap { devices.indices.contains($0) ? $0 : nil }
  guard let index else {
    throw NSError(
      domain: "CodictateParakeet", code: 5,
      userInfo: [
        NSLocalizedDescriptionKey:
          "Input device \(deviceRef) not found (\(devices.count) input devices)"
      ])
  }
  logPhase("stream [\(mode)]: input device #\(index): \(coreAudioDeviceName(devices[index]))")
  return devices[index]
}

/// Captures one input device through an input-only AUHAL and hands out 16 kHz mono chunks.
///
/// Not AVAudioEngine: its input node starts out bound to the system default input, and opening
/// it, even before `kAudioOutputUnitProperty_CurrentDevice` points it elsewhere, is enough to
/// switch AirPods that are the default input into their call profile, so the user's music drops
/// out mid-Dictation. An AUHAL with output disabled and its device set before
/// `AudioUnitInitialize` opens the chosen device and nothing else. Same as `DeviceRecorder` in
/// `src/bun/utils/audio/MicRecorder.swift`.
private final class StreamInputCapture: @unchecked Sendable {
  private var unit: AudioUnit?
  private let capture: AVAudioPCMBuffer
  private let converter: AVAudioConverter
  private let onSamples: @Sendable ([Float]) -> Void

  init(device: AudioDeviceID, onSamples: @escaping @Sendable ([Float]) -> Void) throws {
    func check(_ status: OSStatus, _ what: String) throws {
      guard status == noErr else {
        throw NSError(
          domain: "CodictateParakeet", code: 6,
          userInfo: [NSLocalizedDescriptionKey: "\(what): OSStatus \(status)"])
      }
    }
    self.onSamples = onSamples

    var description = AudioComponentDescription(
      componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
      componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0,
      componentFlagsMask: 0)
    guard let component = AudioComponentFindNext(nil, &description) else {
      throw NSError(
        domain: "CodictateParakeet", code: 6,
        userInfo: [NSLocalizedDescriptionKey: "No HAL output audio component"])
    }
    var created: AudioUnit?
    try check(AudioComponentInstanceNew(component, &created), "AudioComponentInstanceNew")
    guard let unit = created else {
      throw NSError(domain: "CodictateParakeet", code: 6)
    }
    self.unit = unit

    let u32 = UInt32(MemoryLayout<UInt32>.size)
    var on: UInt32 = 1
    var off: UInt32 = 0
    try check(
      AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, u32),
      "Enable input")
    try check(
      AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, u32),
      "Disable output")
    var deviceId = device
    try check(
      AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceId,
        UInt32(MemoryLayout<AudioDeviceID>.size)),
      "Cannot select input device \(coreAudioDeviceName(device))")

    // The device side of element 1; the client side gets the same rate and channels as
    // deinterleaved Float32, since an AUHAL does not convert the sample rate of its input.
    var hardware = AudioStreamBasicDescription()
    var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(
      AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &asbdSize),
      "Read device format")
    guard hardware.mSampleRate > 0, hardware.mChannelsPerFrame > 0,
      let client = AVAudioFormat(
        standardFormatWithSampleRate: hardware.mSampleRate, channels: hardware.mChannelsPerFrame),
      let converter = makeConverter(from: client)
    else {
      throw NSError(
        domain: "CodictateParakeet", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Cannot create audio converter"])
    }
    self.converter = converter
    var clientDescription = client.streamDescription.pointee
    try check(
      AudioUnitSetProperty(
        unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &clientDescription, asbdSize),
      "Set client format")

    try check(AudioUnitInitialize(unit), "AudioUnitInitialize")
    var maxFrames: UInt32 = 4096
    var maxFramesSize = u32
    _ = AudioUnitGetProperty(
      unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames,
      &maxFramesSize)
    guard let capture = AVAudioPCMBuffer(pcmFormat: client, frameCapacity: max(maxFrames, 4096))
    else { throw NSError(domain: "CodictateParakeet", code: 6) }
    self.capture = capture

    var callback = AURenderCallbackStruct(
      inputProc: { refCon, flags, timestamp, bus, frames, _ in
        Unmanaged<StreamInputCapture>.fromOpaque(refCon).takeUnretainedValue()
          .render(flags: flags, timestamp: timestamp, bus: bus, frames: frames)
      },
      inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
    try check(
      AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback,
        UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
      "Set input callback")
  }

  func start() throws {
    guard let unit else { return }
    let status = AudioOutputUnitStart(unit)
    guard status == noErr else {
      throw NSError(
        domain: "CodictateParakeet", code: 7,
        userInfo: [NSLocalizedDescriptionKey: "AudioOutputUnitStart: OSStatus \(status)"])
    }
  }

  func stop() {
    guard let unit else { return }
    AudioOutputUnitStop(unit)
    AudioUnitUninitialize(unit)
    AudioComponentInstanceDispose(unit)
    self.unit = nil
  }

  /// On the device's IO thread, one call at a time.
  private func render(
    flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    timestamp: UnsafePointer<AudioTimeStamp>, bus: UInt32, frames: UInt32
  ) -> OSStatus {
    guard let unit, frames <= capture.frameCapacity else { return noErr }
    capture.frameLength = frames
    let buffers = UnsafeMutableAudioBufferListPointer(capture.mutableAudioBufferList)
    for index in 0..<buffers.count {
      buffers[index].mDataByteSize = frames * UInt32(MemoryLayout<Float32>.size)
    }
    let status = AudioUnitRender(unit, flags, timestamp, bus, frames, capture.mutableAudioBufferList)
    guard status == noErr else { return status }
    let samples = convert(capture, using: converter)
    if !samples.isEmpty { onSamples(samples) }
    return noErr
  }
}

private enum StreamSignalHandlers {
  nonisolated(unsafe) static var sigint: DispatchSourceSignal?
  nonisolated(unsafe) static var sigterm: DispatchSourceSignal?
}

private func installStreamSignalHandlersForCleanup() {
  signal(SIGPIPE, SIG_IGN)

  let cleanupAndExit: @convention(block) () -> Void = {
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
    let models = try loadAsrModels(parakeetDir: modelDir)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    logPhase("transcribing…")
    let result = try await transcribeOnce(asr, URL(fileURLWithPath: wavPath))
    let text = applyInverseTextNormalization(result.text)
    logPhase("done")
    var final: [String: Any] = ["kind": "final", "text": text]
    if let timing = spokenWordTiming(transcript: text, tokenTimings: result.tokenTimings) {
      final["timing"] = timing
    }
    emitJSON(final)
  }

  /// The batch `final` line's optional `timing`: the words as spoken, before ITN, with when each
  /// was said (seconds, rounded to ms). Spoken, not written, because ITN rewrites words ("twenty
  /// one" → "21") after the model timed them; the app lines the written words back up with these
  /// (`parakeet-timings.ts`). `nil` when there is no transcript or no timings, so the field is
  /// omitted and the line reads exactly as it did before.
  private static func spokenWordTiming(
    transcript: String, tokenTimings: [TokenTiming]?
  ) -> [String: Any]? {
    guard !transcript.isEmpty, let tokenTimings, !tokenTimings.isEmpty else { return nil }
    // Decimal, not Double: JSONSerialization writes a Double's 17 digits (0.23999999999999999).
    func ms(_ seconds: TimeInterval) -> Decimal {
      Decimal(Int64((seconds * 1000).rounded())) / 1000
    }
    let items: [[String: Any]] = buildWordTimings(from: tokenTimings).compactMap { word in
      guard word.startTime.isFinite, word.endTime.isFinite, word.startTime >= 0 else { return nil }
      return [
        "text": word.word,
        "start": ms(word.startTime),
        "end": ms(max(word.startTime, word.endTime)),
      ]
    }
    guard !items.isEmpty else { return nil }
    return ["unit": "spoken-word", "items": items]
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
    let models = try loadAsrModels(parakeetDir: modelDir)
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
      let result = try await transcribeOnce(asr, URL(fileURLWithPath: request.audioPath))
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
    let deviceRef = args.count >= 3 ? args[2] : nil

    if let sid = ProcessInfo.processInfo.environment["CODICTATE_STREAM_DEBUG_ID"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !sid.isEmpty
    {
      StreamSessionLog.stderrTag = " [s\(sid)]"
    } else {
      StreamSessionLog.stderrTag = ""
    }

    logPhase("stream [\(mode)]: loading models…")
    let models = try loadAsrModels(parakeetDir: modelDir)
    logPhase("stream [\(mode)]: models ready")
    // Audio Ducking is not this helper's job: Codictate runs `MicRecorder duck` beside it.
    installStreamSignalHandlersForCleanup()

    if mode == "vad" {
      try await runVadMode(models: models, deviceRef: deviceRef)
    } else {
      try await runLiveMode(models: models, deviceRef: deviceRef)
    }
  }

  // MARK: VAD mode

  static func runVadMode(models: AsrModels, deviceRef: String?) async throws {
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    let device = try resolveStreamInputDevice(deviceRef: deviceRef, mode: "vad")

    // Pipe converted 16 kHz chunks into an AsyncStream for sequential VAD processing.
    let (audioStream, audioContinuation) = AsyncStream<[Float]>.makeStream()

    let capture = try StreamInputCapture(device: device) { samples in
      audioContinuation.yield(samples)
    }
    try capture.start()
    defer { capture.stop() }
    logPhase("stream [vad]: capturing")

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
      let result = try await transcribeOnce(asr, samples)
      let text = applyInverseTextNormalization(result.text)
      guard !text.isEmpty else { return }
      logPhase("stream [vad]: pasting \(text.count) chars")
      await StreamInjection.pasteOnly(text + " ")
    } catch {
      logPhase("stream [vad]: transcription error: \(error)")
    }
  }

  // MARK: Live mode

  static func runLiveMode(models: AsrModels, deviceRef: String?) async throws {
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)
    let device = try resolveStreamInputDevice(deviceRef: deviceRef, mode: "live")

    let (audioStream, audioContinuation) = AsyncStream<[Float]>.makeStream()

    let capture = try StreamInputCapture(device: device) { samples in
      audioContinuation.yield(samples)
    }
    try capture.start()
    defer { capture.stop() }
    logPhase("stream [live]: capturing")
    if liveStreamDebugEnabled() {
      logPhase(
        "stream [live][debug] CODICTATE_LIVE_DEBUG on — logging partials, commits, discards")
    }

    // The 1s floor below dates from FluidAudio < 0.13.7, which rejected < 1s of audio
    // (`invalidAudioData`); it now rejects < 300ms. The 1s floor and padding are kept as
    // tuned, not re-tuned for the lower limit. Do not zero-pad partial snapshots — padding
    // makes TDT hallucinate long junk, then finals are shorter and the UI deletes huge
    // spans. Partials only run on real ≥1s buffers; short tails are padded only once at
    // utterance end.
    let rmsThreshold: Float = 0.010
    // ~1.5s @ 16kHz — longer than brief phrase gaps so one PTT hold stays fewer segments / less churn.
    let silenceCommit = 24_000
    let minUtterance = 2_400
    // First partial waits for 1s of real audio (see above).
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
          let partialText = try await transcribeOnce(asr, utterance).text
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
          let rawFinal = try await transcribeOnce(asr, finalInput).text
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
            let rawFinal = try await transcribeOnce(asr, finalInput).text
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
