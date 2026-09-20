"use strict";

const EventEmitter = require('events');
const WebSocket = require('ws');

// Minimal VoiceLive wake-only worker. Connects to the provided provider.url
// (the same URL buildVoiceProviders builds) and keeps a lightweight session
// configured for transcription/turn_detection only. Emits:
//  - 'transcript' => { text }
//  - 'speech_started'
//  - 'speech_stopped'
//  - 'ready'
//  - 'error'

class VoiceLiveWake extends EventEmitter {
  constructor({ provider, apiVersion, voice, prefixPaddingMs = 80, silenceMs = 200, model, wsClass, inputRate = 16000 } = {}) {
    super();
    this.provider = provider;
    this.apiVersion = apiVersion;
    this.voice = voice;
    this.prefixPaddingMs = prefixPaddingMs;
    this.silenceMs = silenceMs;
    this.model = model;
    this.inputRate = Number.isFinite(inputRate) ? Number(inputRate) : 16000;
    this._WebSocket = wsClass || WebSocket;
    this.ws = null;
    this.ready = false;
    this._buffering = false;
    this._queue = [];
    this._maxQueue = 64; // max chunks to buffer while connecting
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
  }

  start() {
    if (!this.provider) return;
      try {
      this.ws = new this._WebSocket(this.provider.url, { headers: this.provider.headers, handshakeTimeout: 10000 });
    } catch (e) {
      this.emit('error', e);
      return;
    }

    this.ws.on('open', () => {
      this.emit('connect');
      // send a minimal session.update for transcription + server_vad
      const turn_detection = { type: 'server_vad', prefix_padding_ms: this.prefixPaddingMs, silence_duration_ms: this.silenceMs, create_response: false, interrupt_response: false };
      const transcription = { model: this.model || (this.provider && this.provider.model) || 'gpt-realtime' };
      const session = {
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: [],
          audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection }
          }
        }
      };
      try {
        // Diagnostic: log the session update payload (provider id/voice for debugging)
        try {
          const providerId = this.provider && this.provider.id ? this.provider.id : 'unknown-provider';
          const voiceName = this.voice || (this.provider && this.provider.voice) || 'unknown-voice';
          const payloadPreview = { provider: providerId, voice: voiceName, session: session.session };
          const { inf } = require('./log');
          inf('[VoiceLiveWake] sending session.update payload: ' + JSON.stringify(payloadPreview));
        } catch (e) { /* ignore logging failures */ }
        this.ws.send(JSON.stringify(session));
      } catch (e) { /* ignore */ }
      // flush any queued audio
      try {
        while (this._queue && this._queue.length) {
          const item = this._queue.shift();
          try { this.ws.send(item); } catch (e) { break; }
        }
      } catch (e) {}
    });

    this.ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      try {
        switch (msg.type) {
          case 'session.updated':
            this.ready = true;
            this.emit('ready');
            break;
          case 'input_audio_buffer.speech_started':
            this.emit('speech_started');
            break;
          case 'input_audio_buffer.speech_stopped':
            this.emit('speech_stopped');
            break;
          case 'conversation.item.input_audio_transcription.completed':
            this.emit('transcript', { text: msg.transcript || '' });
            break;
          default:
            break;
        }
      } catch (e) { this.emit('error', e); }
    });

    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', () => this.emit('disconnect'));
    this.ws.on('close', () => {
      this.ready = false;
      // also emit a generic close/disconnect
      this.emit('close');
      // schedule reconnect with backoff
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        try { this.start(); } catch (e) { this.emit('error', e); }
      }, this._reconnectDelay);
      this._reconnectDelay = Math.min(60000, Math.floor(this._reconnectDelay * 1.8));
    });
  }

  feedAudio(pcmChunk) {
    // Ensure input is 16-bit PCM Buffer
    let buffer = Buffer.from(pcmChunk);
    // If mic/sample rate isn't the same as session input (24000) resample
    if (this.inputRate && this.inputRate !== 24000) {
      try {
        buffer = VoiceLiveWake.resample16To24(buffer, this.inputRate);
      } catch (e) {
        // On resample failure, still attempt to send original buffer
        this.emit('error', new Error('resample_failed: ' + String(e && e.message ? e.message : e)));
      }
    }
    const b64 = Buffer.from(buffer).toString('base64');
    const payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 });
    if (!this.ws || this.ws.readyState !== this._WebSocket.OPEN) {
      // queue for later flush
      try {
        if (this._queue.length < this._maxQueue) this._queue.push(payload);
      } catch (e) {}
      return false;
    }
    try {
      this.ws.send(payload);
      return true;
    } catch (e) {
      // on send failure, try to queue
      try { if (this._queue.length < this._maxQueue) this._queue.push(payload); } catch (e) {}
      return false;
    }
  }

  // Simple linear resampling from arbitrary inputRate -> 24000 (PCM16LE)
  // Only supports mono 16-bit signed integer PCM buffers.
  static resample16To24(pcm16leBuffer, inputRate) {
    // If already 24k assume it's correct
    if (!pcm16leBuffer || inputRate === 24000) return Buffer.from(pcm16leBuffer);
    const inRate = Number.isFinite(inputRate) ? Number(inputRate) : 16000;
    const inSamples = Math.floor(pcm16leBuffer.length / 2);
    const outSamples = Math.floor(inSamples * 24000 / inRate);
    if (outSamples <= 0) return Buffer.alloc(0);
    const out = Buffer.alloc(outSamples * 2);
    // Read input samples as int16
    for (let i = 0; i < outSamples; i++) {
      const pos = i * (inSamples - 1) / Math.max(1, outSamples - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(inSamples - 1, i0 + 1);
      const frac = pos - i0;
      const s0 = pcm16leBuffer.readInt16LE(i0 * 2);
      const s1 = pcm16leBuffer.readInt16LE(i1 * 2);
      const v = Math.round(s0 + (s1 - s0) * frac);
      out.writeInt16LE(v, i * 2);
    }
    return out;
  }

  close() {
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

module.exports = { VoiceLiveWake };
