// CodictateMediaHelper: turns any audio or video file AVFoundation can read into the
// 16 kHz mono 16-bit PCM WAV every Speech Engine accepts, and shows the Save dialog for a
// Transcript Export.
//
//   CodictateMediaHelper extract-audio <input> <output.wav>
//   CodictateMediaHelper save-dialog --name <file name> --directory <folder> --extension <ext> [--title <title>]
//
// Used by File Transcription (src/bun/file-transcription/), which owns the temp directory the
// output goes into. Every audio track is mixed down, so a screen recording with a microphone track and a
// system-audio track is transcribed whole. Prints nothing on success.
//
// Exit codes, read by src/bun/file-transcription/extract-audio.ts:
//   0  the WAV was written
//   2  usage error
//   3  the input could not be opened or decoded as media
//   4  the input opened but has no audio track
//   5  the output could not be written
//
// `save-dialog` is the system Save dialog (NSSavePanel), read by
// src/bun/window-file-transcriptions/native.ts. It prints exactly one JSON line on stdout:
// `{"path":"<chosen path>"}` when the user saves, `{"cancelled":true}` when they cancel. The
// panel asks before replacing an existing file. Exit codes:
//   0  the user answered (saved or cancelled)
//   2  usage error
// The Bun side treats any other exit, or any other output, as a failed dialog.
//
// macOS only. On Windows, `CodictateWindowsHelper` does both with Media Foundation and
// IFileSaveDialog, with the same argv, output and exit codes (it adds 1: the dialog could not
// be shown).

import AVFoundation
import AppKit
import Foundation
import UniformTypeIdentifiers

enum Exit: Int32 {
    case usage = 2
    case unreadable = 3
    case noAudio = 4
    case writeFailed = 5
}

func fail(_ code: Exit, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code.rawValue)
}

let sampleRate = 16_000
let channels = 1
let bitsPerSample = 16

func wavHeader(dataBytes: UInt32) -> Data {
    var header = Data()
    func append<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { header.append(contentsOf: $0) }
    }
    let blockAlign = UInt16(channels * bitsPerSample / 8)
    header.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36) &+ dataBytes)
    header.append(contentsOf: Array("WAVE".utf8))
    header.append(contentsOf: Array("fmt ".utf8))
    append(UInt32(16))
    append(UInt16(1))  // PCM
    append(UInt16(channels))
    append(UInt32(sampleRate))
    append(UInt32(sampleRate) * UInt32(blockAlign))
    append(blockAlign)
    append(UInt16(bitsPerSample))
    header.append(contentsOf: Array("data".utf8))
    append(dataBytes)
    return header
}

func extractAudio(input: String, output: String) async {
    let inputURL = URL(fileURLWithPath: input)
    guard FileManager.default.isReadableFile(atPath: inputURL.path) else {
        fail(.unreadable, "cannot read \(input)")
    }

    let asset = AVURLAsset(url: inputURL)
    let tracks: [AVAssetTrack]
    do {
        tracks = try await asset.loadTracks(withMediaType: .audio)
    } catch {
        fail(.unreadable, "not a readable audio or video file: \(error.localizedDescription)")
    }
    guard !tracks.isEmpty else {
        fail(.noAudio, "the file has no audio track")
    }

    let reader: AVAssetReader
    do {
        reader = try AVAssetReader(asset: asset)
    } catch {
        fail(.unreadable, "cannot decode the file: \(error.localizedDescription)")
    }
    // The mix output resamples and downmixes as it decodes, so what comes out is already the
    // format the engines want and nothing is converted twice.
    let output16k = AVAssetReaderAudioMixOutput(
        audioTracks: tracks,
        audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: bitsPerSample,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
    output16k.alwaysCopiesSampleData = false
    guard reader.canAdd(output16k) else {
        fail(.unreadable, "cannot decode the audio track")
    }
    reader.add(output16k)

    guard FileManager.default.createFile(atPath: output, contents: wavHeader(dataBytes: 0)),
        let handle = FileHandle(forWritingAtPath: output)
    else {
        fail(.writeFailed, "cannot write \(output)")
    }
    handle.seekToEndOfFile()

    guard reader.startReading() else {
        fail(.unreadable, "cannot decode the file: \(reader.error?.localizedDescription ?? "unknown error")")
    }

    var dataBytes: UInt64 = 0
    while let buffer = output16k.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        let length = CMBlockBufferGetDataLength(block)
        if length == 0 { continue }
        var chunk = Data(count: length)
        let status = chunk.withUnsafeMutableBytes { raw -> OSStatus in
            CMBlockBufferCopyDataBytes(
                block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
        }
        guard status == kCMBlockBufferNoErr else {
            fail(.unreadable, "cannot decode the audio track (status \(status))")
        }
        handle.write(chunk)
        dataBytes += UInt64(length)
    }

    if reader.status == .failed {
        fail(.unreadable, "cannot decode the file: \(reader.error?.localizedDescription ?? "unknown error")")
    }
    // RIFF sizes are 32-bit: 16 kHz mono 16-bit runs out after about 37 hours.
    guard dataBytes <= UInt64(UInt32.max - 36) else {
        fail(.unreadable, "the audio is too long to transcribe in one file")
    }

    handle.seek(toFileOffset: 0)
    handle.write(wavHeader(dataBytes: UInt32(dataBytes)))
    handle.closeFile()
}

struct SaveDialogRequest {
    var name: String
    var directory: String
    var fileExtension: String
    var title: String?
}

let saveDialogUsage =
    "usage: CodictateMediaHelper save-dialog --name <file name> --directory <folder> --extension <ext> [--title <title>]"

/// `--flag value` pairs, each flag at most once. `nil` for anything else.
func parseSaveDialogArgs(_ args: ArraySlice<String>) -> SaveDialogRequest? {
    var values: [String: String] = [:]
    var rest = args
    while let flag = rest.popFirst() {
        guard ["--name", "--directory", "--extension", "--title"].contains(flag),
            values[flag] == nil,
            let value = rest.popFirst()
        else { return nil }
        values[flag] = value
    }
    var fileExtension = values["--extension"] ?? ""
    if fileExtension.hasPrefix(".") { fileExtension.removeFirst() }
    guard let name = values["--name"], !name.isEmpty,
        let directory = values["--directory"], !directory.isEmpty,
        !fileExtension.isEmpty,
        fileExtension.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
    else { return nil }
    return SaveDialogRequest(
        name: name, directory: directory, fileExtension: fileExtension, title: values["--title"])
}

func printJSONLine(_ object: [String: Any]) {
    // Only strings and booleans go in, so this cannot throw.
    var line = try! JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    line.append(0x0A)
    FileHandle.standardOutput.write(line)
}

/// The helper has no window of its own, so it becomes an accessory app (no Dock icon, no menu
/// bar) and activates itself: the panel then opens in front of Codictate's window with the
/// name field focused, instead of behind it.
@MainActor
func runSaveDialog(_ request: SaveDialogRequest) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)

    let panel = NSSavePanel()
    // Types before the name: `.srt` has no registered type, and a dynamic type set after the
    // name makes the panel append the extension again (`talk.srt.srt`).
    if let type = UTType(filenameExtension: request.fileExtension) {
        panel.allowedContentTypes = [type]
    }
    panel.nameFieldStringValue = request.name
    panel.directoryURL = URL(fileURLWithPath: request.directory, isDirectory: true)
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    if let title = request.title { panel.title = title }

    if panel.runModal() == .OK, let url = panel.url {
        printJSONLine(["path": url.path])
    } else {
        printJSONLine(["cancelled": true])
    }
    exit(0)
}

let args = CommandLine.arguments
if args.count >= 2, args[1] == "save-dialog" {
    guard let request = parseSaveDialogArgs(args.dropFirst(2)) else {
        fail(.usage, saveDialogUsage)
    }
    runSaveDialog(request)
}
guard args.count == 4, args[1] == "extract-audio" else {
    fail(.usage, "usage: CodictateMediaHelper extract-audio <input> <output.wav>")
}
await extractAudio(input: args[2], output: args[3])
exit(0)
