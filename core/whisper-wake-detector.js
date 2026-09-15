'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pcmToWavBuffer } = require('./audio-utils');

function normalizeTranscript(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isJarvisWakeTranscript(transcript) {
  return /(?:^|\s)jarvis(?:\s|$)/.test(normalizeTranscript(transcript));
}

// whisper.cpp CLI stdin uchun barqaror streaming protocol bermaydi. Shu sabab
// audio capture persistent qoladi, worker esa vaqt bo'yicha chegaralangan eng
// so'nggi PCM oynani bitta CLI invocation bilan taniydi. Eski oynalar queue
// qilinmaydi: wake detector realtime audio yoki daemon memory'ni egallamaydi.
class WhisperWakeDetector {
  constructor(options = {}) {
    this.binaryPath = options.binaryPath;
    this.modelPath = options.modelPath;
    this.language = options.language || 'en';
    this.sampleRate = options.sampleRate || 16000;
    this.windowMs = options.windowMs || 3000;
    this.intervalMs = options.intervalMs || 1500;
    this.cooldownMs = options.cooldownMs || 5000;
    this.timeoutMs = options.timeoutMs || 15000;
    this.now = options.now || Date.now;
    this.spawn = options.spawn || spawn;
    this.onWake = options.onWake || (() => {});
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.started = false;
    this.closed = false;
    this.inFlight = false;
    this.lastRunAt = 0;
    this.lastWakeAt = 0;
    this.buffers = [];
    this.bufferBytes = 0;
    this.maxBytes = Math.ceil(this.sampleRate * 2 * this.windowMs / 1000);
  }

  start() {
    if (this.started) return true;
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) {
      this.onError(new Error('whisper.cpp binary topilmadi: ' + (this.binaryPath || '(bo\'sh)')));
      return false;
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      this.onError(new Error('whisper.cpp model topilmadi: ' + (this.modelPath || '(bo\'sh)')));
      return false;
    }
    this.started = true;
    this.onReady();
    return true;
  }

  feedChunk(chunk) {
    if (!this.started || this.closed || !Buffer.isBuffer(chunk) || !chunk.length) return false;
    const copy = Buffer.from(chunk);
    this.buffers.push(copy);
    this.bufferBytes += copy.length;
    while (this.bufferBytes > this.maxBytes && this.buffers.length) this.bufferBytes -= this.buffers.shift().length;
    const now = this.now();
    if (!this.inFlight && this.bufferBytes >= this.maxBytes && now - this.lastRunAt >= this.intervalMs) {
      this.lastRunAt = now;
      this._transcribe(Buffer.concat(this.buffers)).catch(error => this.onError(error));
      return true;
    }
    return false;
  }

  async _transcribe(pcm) {
    this.inFlight = true;
    const token = `jarvis-whisper-${process.pid}-${this.now()}-${Math.random().toString(16).slice(2)}`;
    const wavFile = path.join(os.tmpdir(), token + '.wav');
    const outputBase = path.join(os.tmpdir(), token);
    const transcriptFile = outputBase + '.txt';
    try {
      fs.writeFileSync(wavFile, pcmToWavBuffer(pcm));
      await this._runCli(wavFile, outputBase);
      const transcript = fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf8').trim() : '';
      const now = this.now();
      if (!this.closed && isJarvisWakeTranscript(transcript) && now - this.lastWakeAt >= this.cooldownMs) {
        this.lastWakeAt = now;
        this.onWake({ transcript, detectedAt: now });
      }
    } finally {
      this.inFlight = false;
      for (const file of [wavFile, transcriptFile]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  }

  _runCli(wavFile, outputBase) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = this.spawn(this.binaryPath, ['-m', this.modelPath, '-f', wavFile, '-l', this.language, '-nt', '-otxt', '-of', outputBase], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        finish(new Error(`whisper.cpp ${this.timeoutMs}ms ichida tugamadi`));
      }, this.timeoutMs);
      timer.unref?.();
      child.stderr?.on('data', data => { stderr = (stderr + data).slice(-1000); });
      child.once('error', error => finish(error));
      child.once('close', code => finish(code === 0 ? null : new Error(`whisper.cpp exited with ${code}: ${stderr.trim()}`)));
    });
  }

  release() {
    this.closed = true;
    this.buffers = [];
    this.bufferBytes = 0;
  }
}

module.exports = { WhisperWakeDetector, normalizeTranscript, isJarvisWakeTranscript };