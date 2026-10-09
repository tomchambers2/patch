// patch-audio — the desktop shell's native audio helper (macOS 14.4+).
//
//   patch-audio tap        system audio → stdout, raw 16 kHz mono signed 16-bit PCM;
//                          prints `ready` on stderr once audio is flowing
//   patch-audio mic-watch  one JSON line per change: which processes have a mic open
//
// `tap` is a Core Audio process tap: audio only, no screen capture, so macOS shows
// no picker and no screen-sharing indicator. It follows the default output device
// (headphones in or out mid-call). `mic-watch` is how a meeting is noticed: a call
// app opening the microphone. NO FALLBACK: any failure is a message on stderr and a
// non-zero exit, which the shell surfaces.

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("patch-audio: \(message)\n".utf8))
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

let system = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

// MARK: - tap

final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "patch-audio.tap", qos: .userInteractive)
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    func start() {
        var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        check(AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &device), "read default output device")
        if device == AudioObjectID(kAudioObjectUnknown) { fail("no default output device") }

        addr = address(kAudioDevicePropertyDeviceUID)
        var uidRef: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        check(AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uidRef), "read output device UID")
        guard let outputUID = uidRef?.takeRetainedValue() as String? else { fail("no output device UID") }

        // Leave this helper's own process out; it makes no sound.
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Patch"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        check(AudioHardwareCreateProcessTap(description, &tapID), "create audio tap (is System Audio Recording allowed for Patch?)")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Patch Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "create aggregate device")

        var asbd = AudioStreamBasicDescription()
        size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        addr = address(kAudioTapPropertyFormat)
        check(AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd), "read tap format")
        guard let format = AVAudioFormat(streamDescription: &asbd),
              let converter = AVAudioConverter(from: format, to: target) else { fail("unsupported tap format") }

        let out = FileHandle.standardOutput
        check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [target] _, input, _, _, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / format.sampleRate) + 1024
                guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
                var consumed = false
                var error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return buffer
                }
                if let error { fail("convert audio: \(error.localizedDescription)") }
                guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
                out.write(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
            },
            "create audio callback"
        )
        check(AudioDeviceStart(aggregateID, procID), "start audio tap")
        FileHandle.standardError.write(Data("ready\n".utf8))
    }

    func stop() {
        if let procID, aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != AudioObjectID(kAudioObjectUnknown) { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

func runTap() -> Never {
    let tap = SystemTap()
    tap.start()

    // The tap clocks off the output device: rebuild it when the default changes.
    var changed = address(kAudioHardwarePropertyDefaultOutputDevice)
    AudioObjectAddPropertyListenerBlock(system, &changed, .main) { _, _ in
        tap.stop()
        tap.start()
    }

    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            tap.stop()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
    dispatchMain()
}

var signalSources: [DispatchSourceSignal] = []

// MARK: - mic-watch

struct MicProcess: Hashable {
    let pid: Int32
    let bundleId: String
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = address(selector)
    check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value), "read audio process property")
    return value
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var addr = address(selector)
    check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value), "read audio process property")
    return value?.takeRetainedValue() as String?
}

func processesUsingMic() -> Set<MicProcess> {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    check(AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size), "list audio processes")
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    check(AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &objects), "list audio processes")

    var found: Set<MicProcess> = []
    for object in objects where readUInt32(object, kAudioProcessPropertyIsRunningInput) != 0 {
        guard let bundleId = readString(object, kAudioProcessPropertyBundleID), !bundleId.isEmpty else { continue }
        found.insert(MicProcess(pid: Int32(truncatingIfNeeded: readUInt32(object, kAudioProcessPropertyPID)), bundleId: bundleId))
    }
    return found
}

func runMicWatch() -> Never {
    var last: Set<MicProcess>?
    while true {
        let now = processesUsingMic()
        if now != last {
            let list = now.sorted { $0.pid < $1.pid }.map { ["pid": Int($0.pid), "bundleId": $0.bundleId] as [String: Any] }
            let data = try! JSONSerialization.data(withJSONObject: ["processes": list], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data("\n".utf8))
            last = now
        }
        Thread.sleep(forTimeInterval: 1)
    }
}

// MARK: - main

switch CommandLine.arguments.dropFirst().first {
case "tap": runTap()
case "mic-watch": runMicWatch()
default: fail("usage: patch-audio tap | mic-watch")
}
