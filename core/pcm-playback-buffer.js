'use strict';

/**
 * Collects a small buffer at the start of a realtime PCM stream. When network or model
 * chunks arrive unevenly, the audio device would immediately starve and leave silence
 * mid-sentence, so this buffer sits ready inside the sox pipe.
 */
class PcmPlaybackBuffer {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 24000;
    this.channels = options.channels || 1;
    this.bytesPerSample = options.bytesPerSample || 2;
    this.prebufferMs = Math.max(0, options.prebufferMs ?? 240);
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? 320);
    this.onData = options.onData || (() => {});
    this._chunks = [];
    this._bytes = 0;
    this._started = false;
    this._timer = null;
  }

  get queuedMs() {
    return this._bytes / (this.sampleRate * this.channels * this.bytesPerSample) * 1000;
  }

  push(chunk) {
    if (!chunk?.length) return;
    const copy = Buffer.from(chunk);
    if (this._started) {
      this.onData(copy);
      return;
    }

    this._chunks.push(copy);
    this._bytes += copy.length;
    if (this.queuedMs >= this.prebufferMs || this.prebufferMs === 0) {
      this._release();
    } else if (!this._timer && this.maxWaitMs > 0) {
      // A very short reply may never reach the prebuffer threshold; the audio is still
      // never held forever, even if the server's done event does not arrive.
      this._timer = setTimeout(() => this._release(), this.maxWaitMs);
      this._timer.unref?.();
    }
  }

  finish() {
    this._release();
  }

  reset() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._chunks = [];
    this._bytes = 0;
    this._started = false;
  }

  _release() {
    if (this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._started = true;
    if (!this._bytes) return;
    const audio = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._bytes);
    this._chunks = [];
    this._bytes = 0;
    this.onData(audio);
  }
}

module.exports = { PcmPlaybackBuffer };