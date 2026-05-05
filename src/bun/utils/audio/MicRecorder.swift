import AVFoundation
import CoreAudio
import Darwin
import Foundation

// macOS marks AVAudioSession / duckOthers as unavailable, so we approximate “duck” by briefly
// lowering the default output device’s hardware volume.
// There is no public API to lower other apps but exclude the host (Codictate) — the scalar is
// device-wide. After `record()` starts, we delay ducking by `duckDelayMs` (from the WAV length +
// pad, passed from Bun) so the start chime finishes, then enabled output is ducked to the
// configured scalar. Bluetooth/USB and name hints (headphones, AirPods) are opt-in.

private func getDefaultOutputDevice() -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    return id
}

private func getDeviceTransportType(_ id: AudioDeviceID) -> UInt32 {
    var transport: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport) == noErr else {
        return 0
    }
    return transport
}

private enum OutputDeviceKind { case builtIn, headphone, other }

private func classifyOutputDevice(_ id: AudioDeviceID) -> OutputDeviceKind {
    guard id != 0 else { return .other }
    let transport = getDeviceTransportType(id)
    if transport == kAudioDeviceTransportTypeAggregate || transport == kAudioDeviceTransportTypeVirtual {
        return .other
    }
    let name = deviceName(id)
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
        mElement: kAudioObjectPropertyElementMain
    )
}

/// Lowers default output volume; returns the previous scalar for restore, or nil if unchanged / unsupported.
/// Built-in speakers and headphones share the configured duck target when enabled:
/// - `builtInEnabled`: apply ducking to built-in speaker output.
/// - `headphonesEnabled`: apply ducking to headphone/BT/USB output.
/// - `duckLevel`: 0 = fully mute, 100 = no change, values in between are proportional.
private func tryApplyOutputDuck(
    builtInEnabled: Bool,
    headphonesEnabled: Bool,
    duckLevel: Int
) -> SavedOutputVolume? {
    let device = getDefaultOutputDevice()
    let kind = classifyOutputDevice(device)
    guard (kind == .builtIn && builtInEnabled) || (kind == .headphone && headphonesEnabled) else { return nil }

    var addr = outputVolumeScalarAddress()
    guard AudioObjectHasProperty(device, &addr) else { return nil }
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(device, &addr, &settable) == noErr, settable.boolValue else {
        return nil
    }
    var current: Float32 = 1
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &current) == noErr else { return nil }

    let ducked = Float32(max(0, min(100, duckLevel))) / 100.0
    guard ducked + 0.02 < current else { return nil }
    var toWrite = ducked
    guard AudioObjectSetPropertyData(device, &addr, 0, nil, size, &toWrite) == noErr else { return nil }
    return SavedOutputVolume(device: device, scalar: current)
}

private func restoreOutputDuck(_ saved: SavedOutputVolume) {
    var addr = outputVolumeScalarAddress()
    guard AudioObjectHasProperty(saved.device, &addr) else {
        fputs("MicRecorder: output device gone, cannot restore volume\n", stderr)
        return
    }
    let size = UInt32(MemoryLayout<Float32>.size)
    var scalar = saved.scalar
    if AudioObjectSetPropertyData(saved.device, &addr, 0, nil, size, &scalar) != noErr {
        fputs("MicRecorder: failed to restore output volume\n", stderr)
    }
}

// CLI: MicRecorder --list-devices  → one line JSON {"0":"Mic Name",...}
//      MicRecorder record <path> <index> <maxSeconds> [duckDelayMs] [duckLevel] [duckHeadphones] [duckBuiltIn]
// duckDelayMs:    optional 0…10000, ms to wait after record() before lowering output (default 248).
// duckLevel:      optional 0…100 (default 0). Duck target for enabled outputs:
//                 0 = fully mute, 100 = no change.
// duckHeadphones: optional 0 or 1 (default 0). Set to 1 to also duck headphone/BT/USB output.
// duckBuiltIn:    optional 0 or 1 (default 1). Set to 0 to skip ducking built-in speaker output.
// Stop early: SIGINT (graceful WAV finalize) or SIGTERM.

private func deviceHasInput(_ id: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0
    else { return false }

    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return false }

    let list = raw.assumingMemoryBound(to: AudioBufferList.self)
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    var ch = 0
    for b in buffers { ch += Int(b.mNumberChannels) }
    return ch > 0
}

private func deviceName(_ id: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
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

/// Sorted by AudioDeviceID for stable indices across list + record.
func listInputDevices() -> [(AudioDeviceID, String)] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr
    else { return [] }

    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr
    else { return [] }

    var out: [(AudioDeviceID, String)] = []
    for id in ids where deviceHasInput(id) {
        out.append((id, deviceName(id)))
    }
    out.sort { $0.0 < $1.0 }
    return out
}

private func getDefaultInputDevice() -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    return id
}

private func setDefaultInputDevice(_ id: AudioDeviceID) -> Bool {
    var dev = id
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, size, &dev) == noErr
}

final class RecordSession: NSObject, AVAudioRecorderDelegate {
    var recorder: AVAudioRecorder?
    var savedInput: AudioDeviceID = 0
    var didSave = false
    var shouldStop = false
    private var savedOutputVolume: SavedOutputVolume?
    let lock = NSLock()
    var duckLevel: Int = 0
    var duckIncludeHeadphones: Bool = false
    var duckIncludeBuiltIn: Bool = true

    private func applyOutputDuckFromScheduledCallback() {
        lock.lock()
        let stopped = shouldStop
        lock.unlock()
        if stopped { return }
        guard let applied = tryApplyOutputDuck(
            builtInEnabled: duckIncludeBuiltIn,
            headphonesEnabled: duckIncludeHeadphones,
            duckLevel: duckLevel
        ) else { return }
        lock.lock()
        defer { lock.unlock() }
        if shouldStop {
            restoreOutputDuck(applied)
            return
        }
        if savedOutputVolume != nil { return }
        savedOutputVolume = applied
    }

    private func scheduleDelayedOutputDuckingIfNeeded(delay: TimeInterval) {
        if delay <= 0 {
            DispatchQueue.global().async { [weak self] in
                self?.applyOutputDuckFromScheduledCallback()
            }
        } else {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.applyOutputDuckFromScheduledCallback()
            }
        }
    }

    private func restoreOutputDuckingIfNeeded() {
        guard let s = savedOutputVolume else { return }
        savedOutputVolume = nil
        restoreOutputDuck(s)
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        shouldStop = true
        recorder?.stop()
        restoreOutputDuckingIfNeeded()
        if didSave {
            _ = setDefaultInputDevice(savedInput)
            didSave = false
        }
    }

    func run(path: String, deviceIndex: Int, maxSeconds: Int, outputDuckDelaySeconds: TimeInterval) -> Int32 {
        let devices = listInputDevices()
        guard !devices.isEmpty else {
            fputs("MicRecorder: no input devices\n", stderr)
            return 1
        }
        guard deviceIndex >= 0, deviceIndex < devices.count else {
            fputs("MicRecorder: device index out of range\n", stderr)
            return 1
        }
        let targetId = devices[deviceIndex].0

        savedInput = getDefaultInputDevice()
        didSave = true
        if !setDefaultInputDevice(targetId) {
            fputs("MicRecorder: could not set default input device\n", stderr)
            didSave = false
            return 1
        }

        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]

        do {
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.delegate = self
            recorder = r
            guard r.record() else {
                fputs("MicRecorder: record() failed\n", stderr)
                finish()
                return 1
            }
            scheduleDelayedOutputDuckingIfNeeded(delay: outputDuckDelaySeconds)
        } catch {
            fputs("MicRecorder: \(error)\n", stderr)
            finish()
            return 1
        }

        signal(SIGPIPE, SIG_IGN)
        let sem = DispatchSemaphore(value: 0)

        let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
        sigint.setEventHandler { [weak self] in self?.finish(); sem.signal() }
        signal(SIGINT, SIG_IGN)
        sigint.resume()

        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
        sigterm.setEventHandler { [weak self] in self?.finish(); sem.signal() }
        signal(SIGTERM, SIG_IGN)
        sigterm.resume()

        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(maxSeconds)) { [weak self] in
            self?.finish()
            sem.signal()
        }

        while true {
            lock.lock()
            let done = shouldStop
            lock.unlock()
            if done { break }
            Thread.sleep(forTimeInterval: 0.05)
        }

        _ = sem.wait(timeout: .now() + 0.5)
        finish()
        return 0
    }
}

// MARK: - main

let args = CommandLine.arguments

/// One-shot read for the Bun host. Prefer this over KeyListener for permission UI:
/// a long-lived process can keep a stale `authorizationStatus` after TCC grants access.
if args.count >= 2, args[1] == "--mic-authorization" {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    print("{\"microphone\": \(mic)}")
    exit(0)
}

if args.count >= 2, args[1] == "--list-devices" {
    let devs = listInputDevices()
    var dict: [String: String] = [:]
    for (i, pair) in devs.enumerated() {
        dict[String(i)] = pair.1
    }
    if let data = try? JSONSerialization.data(withJSONObject: dict),
        let s = String(data: data, encoding: .utf8)
    {
        print(s)
    } else {
        print("{}")
    }
    exit(0)
}

guard args.count >= 5, args[1] == "record" else {
    fputs(
        "usage: MicRecorder --mic-authorization\n       MicRecorder --list-devices\n       MicRecorder record <wavPath> <deviceIndex> <maxSeconds> [duckDelayMs] [duckLevel] [duckHeadphones] [duckBuiltIn]\n",
        stderr
    )
    exit(2)
}

let outPath = args[2]
guard let idx = Int(args[3]), let maxSec = Int(args[4]), maxSec > 0 else {
    fputs("MicRecorder: bad index or duration\n", stderr)
    exit(2)
}

// Matches Bun fallback when WAV is missing: 220 ms + 28 ms pad.
var outputDuckDelaySeconds = 0.248
if args.count >= 6 {
    guard let ms = Int(args[5]), ms >= 0, ms <= 10_000 else {
        fputs("MicRecorder: duckDelayMs must be 0...10000\n", stderr)
        exit(2)
    }
    outputDuckDelaySeconds = Double(ms) / 1000.0
}

var duckLevel = 0
if args.count >= 7 {
    guard let level = Int(args[6]), level >= 0, level <= 100 else {
        fputs("MicRecorder: duckLevel must be 0...100\n", stderr)
        exit(2)
    }
    duckLevel = level
}

var duckIncludeHeadphones = false
if args.count >= 8 {
    guard args[7] == "0" || args[7] == "1" else {
        fputs("MicRecorder: duckHeadphones must be 0 or 1\n", stderr)
        exit(2)
    }
    duckIncludeHeadphones = args[7] == "1"
}

var duckIncludeBuiltIn = true
if args.count >= 9 {
    guard args[8] == "0" || args[8] == "1" else {
        fputs("MicRecorder: duckBuiltIn must be 0 or 1\n", stderr)
        exit(2)
    }
    duckIncludeBuiltIn = args[8] == "1"
}

let session = RecordSession()
session.duckLevel = duckLevel
session.duckIncludeHeadphones = duckIncludeHeadphones
session.duckIncludeBuiltIn = duckIncludeBuiltIn
exit(
    session.run(
        path: outPath,
        deviceIndex: idx,
        maxSeconds: maxSec,
        outputDuckDelaySeconds: outputDuckDelaySeconds
    )
)
