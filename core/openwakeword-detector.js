'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { ok, inf, wrn } = require('./log');

// Bepul va to'liq lokal hey_jarvis modeli. Python worker ishlamay qolsa
// daemon qulamaydi: Azure STT backup hotword ishlashda davom etadi.
class OpenWakeWordDetector {
  constructor({ projectDir, pythonPath, env, sampleRate = 16000 } = {}) {
    this.detected = false;
    this.ready = false;
    this.closed = false;
    this.lineBuffer = '';
    this.sampleRate = sampleRate;
    this.worker = spawn(pythonPath, ['-u', path.join(projectDir, 'scripts', 'openwakeword-worker.py')], {
      cwd: projectDir,
      env: {
        ...process.env,
        JARVIS_OWNER_PID: String(process.pid),
        OPENWAKEWORD_THRESHOLD: env('OPENWAKEWORD_THRESHOLD') || '0.38',
        OPENWAKEWORD_STRONG_THRESHOLD: env('OPENWAKEWORD_STRONG_THRESHOLD') || '0.55'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.worker.stdout.on('data', data => this._handleOutput(data.toString()));
    this.worker.stderr.on('data', data => {
      const text = data.toString().trim();
      if (text) wrn('openWakeWord: ' + text.split('\n').pop());
    });
    this.worker.on('error', error => {
      this.closed = true;
      wrn('openWakeWord worker ishga tushmadi: ' + error.message);
    });
    this.worker.on('close', code => {
      this.closed = true;
      this.ready = false;
      if (code !== 0) wrn('openWakeWord worker to\'xtadi (code=' + code + ') — STT fallback faol');
    });
  }

  _handleOutput(text) {
    this.lineBuffer += text;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop();
    for (const line of lines) {
      if (line === 'READY') {
        this.ready = true;
        ok('openWakeWord "hey Jarvis" modeli tayyor (lokal, bepul)');
      } else if (line.startsWith('DETECT ')) {
        this.detected = true;
        inf('openWakeWord score=' + line.slice(7));
      } else if (line.startsWith('SCORE ')) {
        inf('openWakeWord candidate score=' + line.slice(6));
      } else if (line.startsWith('ERROR ')) {
        wrn('openWakeWord: ' + line.slice(6));
      }
    }
  }

  processChunk(pcm16Buffer) {
    if (!this.closed && this.worker.stdin.writable && this.worker.stdin.writableLength < this.sampleRate * 2) {
      this.worker.stdin.write(pcm16Buffer);
    }
    const result = this.detected;
    this.detected = false;
    return result;
  }

  release() {
    this.closed = true;
    try { this.worker.stdin.end(); } catch (e) {}
    try { this.worker.kill(); } catch (e) {}
  }
}

module.exports = { OpenWakeWordDetector };
