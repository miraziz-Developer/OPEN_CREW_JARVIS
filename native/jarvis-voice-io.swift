// jarvis-voice-io: a clean microphone stream through macOS Voice Processing (AEC + noise suppression).
//
// The same system-level echo cancellation FaceTime uses: JARVIS's voice from the speakers (any
// process, including sox) is removed from the microphone at the OS level. Measured: echo of an
// external tone 0.46 -> 0.014 (~ -30 dB).
//
// Output: stdout — 16000 Hz, mono, PCM16 little-endian.
// Status: stderr — "READY" or "ERROR: ..." (exit codes 2..4).
import AVFoundation
import Foundation

setvbuf(stderr, nil, _IOLBF, 0)

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("ERROR: \(message)\n".data(using: .utf8)!)
    exit(code)
}

let micRate = 16000.0
let engine = AVAudioEngine()
let input = engine.inputNode

do {
    try input.setVoiceProcessingEnabled(true)
} catch {
    fail("could not enable voice processing: \(error)", 2)
}
if #available(macOS 14.0, *) {
    // Do not needlessly duck other apps' audio (music).
    input.voiceProcessingOtherAudioDuckingConfiguration =
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
}

// With Voice Processing on, the format is multi-channel; channel 0 is the processed (echo-free) voice.
let tapFormat = input.outputFormat(forBus: 0)
guard tapFormat.sampleRate > 0,
      let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: tapFormat.sampleRate, channels: 1, interleaved: false),
      let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true),
      let micConverter = AVAudioConverter(from: monoFormat, to: outFormat) else {
    fail("invalid microphone format (permission may not have been granted)", 3)
}
let stdout = FileHandle.standardOutput

input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { buffer, _ in
    guard let channel = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    guard let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength) else { return }
    mono.frameLength = buffer.frameLength
    memcpy(mono.floatChannelData![0], channel[0], Int(buffer.frameLength) * MemoryLayout<Float>.size)
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * micRate / tapFormat.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    micConverter.convert(to: out, error: &error) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }
        supplied = true
        status.pointee = .haveData
        return mono
    }
    if error == nil, out.frameLength > 0, let data = out.int16ChannelData {
        stdout.write(Data(bytes: data[0], count: Int(out.frameLength) * 2))
    }
}

do {
    engine.prepare()
    try engine.start()
} catch {
    fail("engine did not start: \(error)", 4)
}

// When the parent process closes (stdin EOF) the helper stops too.
DispatchQueue.global(qos: .utility).async {
    while true { if FileHandle.standardInput.availableData.isEmpty { exit(0) } }
}
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
FileHandle.standardError.write("READY\n".data(using: .utf8)!)
RunLoop.main.run()
