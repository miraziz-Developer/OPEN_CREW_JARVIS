'use strict';

// ════════════════════════════════════════════
// PORCUPINE HOTWORD (frame-level, real-time)
// ════════════════════════════════════════════
class HotwordDetector {
  constructor(accessKey, PorcupineClass, keywordPath) {
    this.porcupine = new PorcupineClass(accessKey, [keywordPath], [0.7]);
    this.frameLength = this.porcupine.frameLength;  // e.g. 512 samples
    this.sampleRate = this.porcupine.sampleRate;    // 16000
    this.remainder = Buffer.alloc(0);
  }

  // Process new PCM chunk. Returns true once when hotword detected.
  processChunk(pcm16Buffer) {
    const pcm = Buffer.concat([this.remainder, pcm16Buffer]);
    const frameLen = this.frameLength * 2; // bytes per frame
    let detected = false;
    for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
      const frame = new Int16Array(this.frameLength);
      for (let j = 0; j < this.frameLength; j++) {
        frame[j] = pcm.readInt16LE(i + j * 2);
      }
      const keywordIndex = this.porcupine.process(frame);
      if (keywordIndex >= 0) { detected = true; }
    }
    this.remainder = pcm.slice(Math.floor(pcm.length / frameLen) * frameLen);
    return detected;
  }

  release() { this.porcupine.release(); }
}

module.exports = { HotwordDetector };
