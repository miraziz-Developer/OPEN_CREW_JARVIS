'use strict';

const fs = require('fs');
const path = require('path');

const VOICE_MILESTONES = Object.freeze({
  WAKE_DETECTED: 'voice.wake.detected',
  STT_FINISHED: 'voice.stt.finished',
  PROVIDER_REQUEST_SENT: 'voice.provider.request.sent',
  FIRST_AUDIO_BYTE_RECEIVED: 'voice.first_audio_byte.received',
  PLAYBACK_STARTED: 'voice.playback.started'
});

class VoiceTelemetry {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), '.run', 'voice-latency.jsonl');
    this.now = options.now || Date.now;
    this.sessionId = options.sessionId || null;
    this._writeChain = Promise.resolve();
    this._directoryReady = false;
  }

  event(type, data = {}, context = {}) {
    const record = {
      type,
      atMs: this.now(),
      sessionId: context.sessionId || this.sessionId || null,
      turnId: context.turnId || null,
      data: this._sanitize(data)
    };
    // Never await logging from microphone/WebSocket callbacks. A failed local
    // telemetry write must not affect the voice turn.
    this._writeChain = this._writeChain.then(async () => {
      if (!this._directoryReady) {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this._directoryReady = true;
      }
      await fs.promises.appendFile(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
    }).catch(() => {});
    return record;
  }

  flush() { return this._writeChain; }

  _sanitize(data) {
    const out = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (/audio|pcm|buffer|chunk|transcript|text|prompt/i.test(key)) continue;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
    return out;
  }
}

module.exports = { VoiceTelemetry, VOICE_MILESTONES };