import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

// CLI:
//   MicRecorder --mic-authorization
//   MicRecorder --list-devices
//       One line of JSON: {"0":{"index":0,"name":"…","id":"<device UID>","transport":"usb","isDefault":false},…}
//       Indices are positions in a list sorted by AudioDeviceID, so they shift as devices come
//       and go; the UID does not.
//   MicRecorder record <wavPath> <deviceUIDOrIndex> <maxSeconds>
//       16 kHz mono 16-bit WAV, written as it records. Stop early: SIGINT (graceful) or SIGTERM.
//   MicRecorder duck <level 0-100> <speakers 0|1> <headphones 0|1> <delayMs> <stateFile> <excludePid>
//   MicRecorder duck-restore <stateFile>
//       Audio Ducking: see `audio-ducking.ts`. `excludePid` is for the Windows helper's sake.
//
// `record` reads from the chosen device directly and never touches the system default input.
// It used to switch the default to the chosen mic for the length of the Dictation and back,
// which re-routed every other app following the default and could pull Bluetooth headphones
// into their call profile mid-song.

// MARK: - Core Audio properties

private func address(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

private func systemDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = address(selector)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}

private func allDevices() -> [AudioDeviceID] {
    var addr = address(kAudioHardwarePropertyDevices)
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    let err = withUnsafeMutablePointer(to: &value) { ptr in
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
    }
    guard err == noErr, let value else { return nil }
    return value as String
}

private func deviceName(_ id: AudioDeviceID) -> String {
    stringProperty(id, kAudioObjectPropertyName) ?? "Device \(id)"
}

private func deviceUID(_ id: AudioDeviceID) -> String? {
    stringProperty(id, kAudioDevicePropertyDeviceUID)
}

private func deviceWithUID(_ uid: String) -> AudioDeviceID? {
    allDevices().first { deviceUID($0) == uid }
}

private func transportType(_ id: AudioDeviceID) -> UInt32 {
    var transport: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = address(kAudioDevicePropertyTransportType)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &transport) == noErr else { return 0 }
    return transport
}

private func inputChannelCount(_ id: AudioDeviceID) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

// MARK: - Input devices

/// Sorted by AudioDeviceID, so `--list-devices` and the Parakeet helper number them alike.
func listInputDevices() -> [AudioDeviceID] {
    allDevices().filter { inputChannelCount($0) > 0 }.sorted()
}

/// The `MicrophoneTransport` names in `src/shared/microphone.ts`.
private func microphoneTransport(_ id: AudioDeviceID) -> String {
    switch transportType(id) {
    case kAudioDeviceTransportTypeBuiltIn: return "built-in"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate,
        kAudioDeviceTransportTypeAutoAggregate:
        return "virtual"
    default: return "other"
    }
}

private func printInputDevices() {
    let defaultInput = systemDevice(kAudioHardwarePropertyDefaultInputDevice)
    var listing: [String: Any] = [:]
    for (index, id) in listInputDevices().enumerated() {
        var entry: [String: Any] = [
            "index": index,
            "name": deviceName(id),
            "transport": microphoneTransport(id),
            "isDefault": id == defaultInput,
        ]
        if let uid = deviceUID(id) { entry["id"] = uid }
        listing[String(index)] = entry
    }
    if let data = try? JSONSerialization.data(withJSONObject: listing),
        let line = String(data: data, encoding: .utf8)
    {
        print(line)
    } else {
        print("{}")
    }
}

/// A device UID, or for a device without one the `--list-devices` index.
private func resolveInputDevice(_ ref: String) -> AudioDeviceID? {
    let devices = listInputDevices()
    if let id = devices.first(where: { deviceUID($0) == ref }) { return id }
    if let index = Int(ref), devices.indices.contains(index) { return devices[index] }
    return nil
}

// MARK: - Stop signals

/// Blocks until SIGINT, SIGTERM, a `stop` line on stdin or the end of stdin (when `watchStdin`).
private final class StopSignal: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private var sources: [DispatchSourceSignal] = []

    init(watchStdin: Bool) {
        signal(SIGPIPE, SIG_IGN)
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInitiated))
            source.setEventHandler { [weak self] in self?.fire() }
            source.resume()
            sources.append(source)
        }
        if watchStdin {
            Thread.detachNewThread { [weak self] in
                while let line = readLine() {
                    if line.trimmingCharacters(in: .whitespaces).lowercased() == "stop" { break }
                }
                self?.fire()
            }
        }
    }

    func fire() { semaphore.signal() }

    /// True when stopped, false on timeout.
    func wait(timeout: TimeInterval? = nil) -> Bool {
        guard let timeout else {
            semaphore.wait()
            return true
        }
        return semaphore.wait(timeout: .now() + timeout) == .success
    }
}

// MARK: - record

/// Writes 16 kHz mono 16-bit PCM as it arrives, with placeholder sizes until `finish`.
/// `growing-wav.ts` reads the data chunk up to the end of the file while it is written.
private final class WavWriter {
    private let handle: FileHandle
    private var dataBytes: UInt32 = 0
    static let sampleRate: UInt32 = 16_000

    init(path: String) throws {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: path, contents: nil) else {
            throw NSError(
                domain: "MicRecorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "cannot create \(path)"])
        }
        handle = try FileHandle(forWritingTo: url)
        try handle.write(contentsOf: Self.header(dataBytes: 0))
    }

    private static func header(dataBytes: UInt32) -> Data {
        var data = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8))
        u32(36 + dataBytes)
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16)
        u16(1)  // PCM
        u16(1)  // mono
        u32(sampleRate)
        u32(sampleRate * 2)
        u16(2)
        u16(16)
        data.append(contentsOf: Array("data".utf8))
        u32(dataBytes)
        return data
    }

    func write(_ samples: UnsafeBufferPointer<Int16>) {
        guard !samples.isEmpty else { return }
        let data = Data(buffer: samples)
        do {
            try handle.write(contentsOf: data)
            dataBytes &+= UInt32(data.count)
        } catch {
            fputs("MicRecorder: write failed: \(error)\n", stderr)
        }
    }

    func finish() {
        do {
            try handle.seek(toOffset: 0)
            try handle.write(contentsOf: Self.header(dataBytes: dataBytes))
            try handle.close()
        } catch {
            fputs("MicRecorder: finalize failed: \(error)\n", stderr)
        }
    }
}

/// Captures from one device through an input-only AUHAL and writes 16 kHz mono WAV.
///
/// Not AVAudioEngine: its input node starts out bound to the system default input, and opening
/// it, even before `kAudioOutputUnitProperty_CurrentDevice` points it elsewhere, is enough to
/// switch AirPods that are the default input into their call profile. The music drops out for a
/// second and comes back on the call profile's own volume, so Audio Ducking appears to undo
/// itself mid-Dictation. An AUHAL with output disabled and its device set before
/// `AudioUnitInitialize` opens the chosen device and nothing else.
private final class DeviceRecorder {
    private var unit: AudioUnit?
    private let writer: WavWriter
    private let capture: AVAudioPCMBuffer
    private let converter: AVAudioConverter
    private let target: AVAudioFormat

    init(device: AudioDeviceID, writer: WavWriter) throws {
        func check(_ status: OSStatus, _ what: String) throws {
            guard status == noErr else {
                throw NSError(
                    domain: "MicRecorder", code: Int(status),
                    userInfo: [NSLocalizedDescriptionKey: "\(what): OSStatus \(status)"])
            }
        }
        self.writer = writer

        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0,
            componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw NSError(
                domain: "MicRecorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no HAL output component"])
        }
        var created: AudioUnit?
        try check(AudioComponentInstanceNew(component, &created), "AudioComponentInstanceNew")
        guard let unit = created else { throw NSError(domain: "MicRecorder", code: 1) }
        self.unit = unit

        let u32 = UInt32(MemoryLayout<UInt32>.size)
        var on: UInt32 = 1
        var off: UInt32 = 0
        try check(
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, u32),
            "enable input")
        try check(
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, u32),
            "disable output")
        var deviceId = device
        try check(
            AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceId,
                UInt32(MemoryLayout<AudioDeviceID>.size)),
            "select \(deviceName(device))")

        // The device side of element 1; the client side gets the same rate and channels as
        // deinterleaved Float32, since an AUHAL does not convert the sample rate of its input.
        var hardware = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(
            AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &asbdSize),
            "read device format")
        guard hardware.mSampleRate > 0, hardware.mChannelsPerFrame > 0,
            let client = AVAudioFormat(
                standardFormatWithSampleRate: hardware.mSampleRate,
                channels: hardware.mChannelsPerFrame)
        else {
            throw NSError(
                domain: "MicRecorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "unusable device format \(hardware)"])
        }
        var clientDescription = client.streamDescription.pointee
        try check(
            AudioUnitSetProperty(
                unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &clientDescription,
                asbdSize),
            "set client format")

        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: Double(WavWriter.sampleRate), channels: 1,
                interleaved: true),
            let converter = AVAudioConverter(from: client, to: target)
        else {
            throw NSError(
                domain: "MicRecorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "cannot convert from \(client)"])
        }
        self.target = target
        self.converter = converter

        try check(AudioUnitInitialize(unit), "AudioUnitInitialize")
        var maxFrames: UInt32 = 4096
        var maxFramesSize = u32
        _ = AudioUnitGetProperty(
            unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames,
            &maxFramesSize)
        guard let capture = AVAudioPCMBuffer(pcmFormat: client, frameCapacity: max(maxFrames, 4096))
        else { throw NSError(domain: "MicRecorder", code: 1) }
        self.capture = capture

        var callback = AURenderCallbackStruct(
            inputProc: { refCon, flags, timestamp, bus, frames, _ in
                Unmanaged<DeviceRecorder>.fromOpaque(refCon).takeUnretainedValue()
                    .render(flags: flags, timestamp: timestamp, bus: bus, frames: frames)
            },
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(
            AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback,
                UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "set input callback")
    }

    func start() throws {
        guard let unit else { return }
        let status = AudioOutputUnitStart(unit)
        guard status == noErr else {
            throw NSError(
                domain: "MicRecorder", code: Int(status),
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

        let capacity = AVAudioFrameCount(
            Double(frames) * target.sampleRate / capture.format.sampleRate + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return noErr }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return self.capture
        }
        if error == nil, let samples = out.int16ChannelData {
            writer.write(UnsafeBufferPointer(start: samples[0], count: Int(out.frameLength)))
        }
        return noErr
    }
}

private func record(path: String, deviceRef: String, maxSeconds: Int) -> Int32 {
    guard let device = resolveInputDevice(deviceRef) else {
        fputs("MicRecorder: input device \(deviceRef) not found\n", stderr)
        return 1
    }
    let writer: WavWriter
    let recorder: DeviceRecorder
    do {
        writer = try WavWriter(path: path)
        recorder = try DeviceRecorder(device: device, writer: writer)
        try recorder.start()
    } catch {
        fputs("MicRecorder: cannot record from \(deviceName(device)): \(error)\n", stderr)
        return 1
    }

    _ = StopSignal(watchStdin: false).wait(timeout: TimeInterval(maxSeconds))

    recorder.stop()
    writer.finish()
    return 0
}

// MARK: - Audio Ducking

/// The default output's volume, the way the volume keys move it. Works on devices that only
/// expose per-channel volume (AirPods and many USB devices), where the main element's
/// `kAudioDevicePropertyVolumeScalar` does not exist.
private var mainVolumeAddress = address(
    kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyScopeOutput)

private func mainVolume(_ device: AudioDeviceID) -> Float32? {
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectHasProperty(device, &mainVolumeAddress),
        AudioObjectGetPropertyData(device, &mainVolumeAddress, 0, nil, &size, &value) == noErr
    else { return nil }
    return value
}

private func canSetMainVolume(_ device: AudioDeviceID) -> Bool {
    var settable: DarwinBoolean = false
    return AudioObjectHasProperty(device, &mainVolumeAddress)
        && AudioObjectIsPropertySettable(device, &mainVolumeAddress, &settable) == noErr
        && settable.boolValue
}

private func setMainVolume(_ device: AudioDeviceID, _ value: Float32) {
    var v = max(0, min(1, value))
    _ = AudioObjectSetPropertyData(
        device, &mainVolumeAddress, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
}

/// 40 ms: too short to hear as a fade, long enough not to click.
private func rampMainVolume(_ device: AudioDeviceID, from: Float32, to: Float32) {
    let steps = 8
    for step in 1...steps {
        setMainVolume(device, from + (to - from) * Float32(step) / Float32(steps))
        if step < steps { usleep(5_000) }
    }
}

/// Within this of the volume we set, the user has not touched it.
private let untouchedTolerance: Float32 = 0.02

private enum OutputKind { case speakers, headphones }

private func outputKind(_ id: AudioDeviceID) -> OutputKind? {
    let transport = transportType(id)
    switch transport {
    case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate,
        kAudioDeviceTransportTypeVirtual:
        return nil
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE,
        kAudioDeviceTransportTypeUSB:
        return .headphones
    default:
        break
    }
    let name = deviceName(id)
    if ["headphone", "headset", "airpods"].contains(where: { name.localizedCaseInsensitiveContains($0) }) {
        return .headphones
    }
    // A MacBook's headphone jack is the built-in device with the headphones data source.
    if transport == kAudioDeviceTransportTypeBuiltIn {
        var source: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = address(kAudioDevicePropertyDataSource, kAudioDevicePropertyScopeOutput)
        if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &source) == noErr,
            source == 0x6864_706E  // 'hdpn'
        {
            return .headphones
        }
    }
    return .speakers
}

/// What `duck` changed, written before the change so a killed helper can be undone.
private struct DuckState: Codable {
    let uid: String
    let saved: Float32
    let ducked: Float32
}

private func writeState(_ state: DuckState, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(state) else { return false }
    return (try? data.write(to: url, options: .atomic)) != nil
}

/// Brings the volume back unless the user moved it while it was lowered.
private func restore(_ state: DuckState) {
    guard let device = deviceWithUID(state.uid), let current = mainVolume(device) else {
        fputs("MicRecorder: output device gone, nothing to restore\n", stderr)
        return
    }
    guard abs(current - state.ducked) <= untouchedTolerance else {
        fputs("MicRecorder: volume changed while ducked, keeping it\n", stderr)
        return
    }
    rampMainVolume(device, from: current, to: state.saved)
}

private func duck(
    level: Int, speakers: Bool, headphones: Bool, delayMs: Int, statePath: String
) -> Int32 {
    let stop = StopSignal(watchStdin: true)
    // Stopped before the start chime finished: nothing was lowered.
    if delayMs > 0, stop.wait(timeout: Double(delayMs) / 1000) { return 0 }

    let device = systemDevice(kAudioHardwarePropertyDefaultOutputDevice)
    guard device != 0, let kind = outputKind(device),
        (kind == .speakers && speakers) || (kind == .headphones && headphones),
        canSetMainVolume(device), let uid = deviceUID(device), let current = mainVolume(device)
    else {
        _ = stop.wait()
        return 0
    }
    let target = Float32(level) / 100
    guard target + untouchedTolerance < current else {
        _ = stop.wait()
        return 0
    }

    let state = DuckState(uid: uid, saved: current, ducked: target)
    guard writeState(state, to: statePath) else {
        fputs("MicRecorder: cannot write \(statePath), not ducking\n", stderr)
        _ = stop.wait()
        return 1
    }
    rampMainVolume(device, from: current, to: target)

    _ = stop.wait()
    restore(state)
    try? FileManager.default.removeItem(atPath: statePath)
    return 0
}

private func duckRestore(statePath: String) -> Int32 {
    guard let data = FileManager.default.contents(atPath: statePath) else { return 0 }
    if let state = try? JSONDecoder().decode(DuckState.self, from: data) {
        restore(state)
    } else {
        fputs("MicRecorder: unreadable \(statePath)\n", stderr)
    }
    try? FileManager.default.removeItem(atPath: statePath)
    return 0
}

// MARK: - main

private func usage() -> Never {
    fputs(
        """
        usage: MicRecorder --mic-authorization
               MicRecorder --list-devices
               MicRecorder record <wavPath> <deviceUIDOrIndex> <maxSeconds>
               MicRecorder duck <level> <speakers 0|1> <headphones 0|1> <delayMs> <stateFile> <excludePid>
               MicRecorder duck-restore <stateFile>

        """, stderr)
    exit(2)
}

let args = CommandLine.arguments

switch args.count >= 2 ? args[1] : "" {
case "--mic-authorization":
    // One-shot read for the Bun host. Prefer this over KeyListener for permission UI:
    // a long-lived process can keep a stale `authorizationStatus` after TCC grants access.
    let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    print("{\"microphone\": \(mic)}")
    exit(0)

case "--list-devices":
    printInputDevices()
    exit(0)

case "record":
    guard args.count >= 5, let maxSeconds = Int(args[4]), maxSeconds > 0 else { usage() }
    exit(record(path: args[2], deviceRef: args[3], maxSeconds: maxSeconds))

case "duck":
    guard args.count >= 7,
        let level = Int(args[2]), (0...100).contains(level),
        ["0", "1"].contains(args[3]), ["0", "1"].contains(args[4]),
        let delayMs = Int(args[5]), (0...10_000).contains(delayMs)
    else { usage() }
    exit(
        duck(
            level: level, speakers: args[3] == "1", headphones: args[4] == "1", delayMs: delayMs,
            statePath: args[6]))

case "duck-restore":
    guard args.count >= 3 else { usage() }
    exit(duckRestore(statePath: args[2]))

default:
    usage()
}
