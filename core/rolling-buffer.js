'use strict';

// ════════════════════════════════════════════
// ROLLING PCM BUFFER (overlap chunking)
// ════════════════════════════════════════════
class RollingBuffer {
  constructor(maxDurationMs = 5000, sampleRate = 16000) {
    this.sampleRate = sampleRate;
    this.maxSamples = (maxDurationMs * sampleRate) / 1000;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]).slice(-this.maxSamples * 2); }
  get samples() { return Math.floor(this.buf.length / 2); }

  // Extract last N milliseconds as PCM
  sliceLast(ms) {
    const bytes = (ms * this.sampleRate * 2) / 1000;
    return this.buf.slice(-bytes);
  }

  clear() { this.buf = Buffer.alloc(0); }
}

module.exports = { RollingBuffer };
