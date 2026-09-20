'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { ok, inf, wrn } = require('./log');

function parseWakeWorkerLine(line) {
  const match = String(line || '').trim().match(/^DETECT\s+(?:(\S+)\s+)?([0-9]*\.?[0-9]+)$/);
  if (!match) return null;
  return { model: match[1] || 'hey_jarvis', score: Number(match[2]) };
}

// Bepul va to'liq lokal hey_jarvis modeli. Python worker ishlamay qolsa
// daemon qulamaydi: Azure STT backup hotword ishlashda davom etadi.
class OpenWakeWordDetector {
  constructor({ projectDir, pythonPath, env, sampleRate = 16000, spawnProcess = spawn, restartBaseMs, restartMaxMs } = {}) {
    this.detected = null;
    this.ready = false;
    this.closed = false;
    this.lineBuffer = '';
    this.sampleRate = sampleRate;
    this.projectDir = projectDir;
    this.pythonPath = pythonPath;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.restartBaseMs = Math.max(1000, Number(restartBaseMs || env('OPENWAKEWORD_RESTART_BASE_MS') || 2000));
    this.restartMaxMs = Math.max(this.restartBaseMs, Number(restartMaxMs || env('OPENWAKEWORD_RESTART_MAX_MS') || 30000));
    this.restartCount = 0;
    this.restartTimer = null;
    this.lastError = null;
    this.lastExit = null;
    this.worker = null;
    this._startWorker();
  }

  _startWorker() {
    if (this.closed) return;
    this.ready = false;
    this.lineBuffer = '';
    this.worker = this.spawnProcess(this.pythonPath, ['-u', path.join(this.projectDir, 'scripts', 'openwakeword-worker.py')], {
      cwd: this.projectDir,
      env: {
        ...process.env,
        JARVIS_OWNER_PID: String(process.pid),
        OPENWAKEWORD_THRESHOLD: this.env('OPENWAKEWORD_THRESHOLD') || '0.18',
        OPENWAKEWORD_STRONG_THRESHOLD: this.env('OPENWAKEWORD_STRONG_THRESHOLD') || '0.55',
        OPENWAKEWORD_CONFIRM_THRESHOLD: this.env('OPENWAKEWORD_CONFIRM_THRESHOLD') || '0.06',
        OPENWAKEWORD_CONFIRM_WINDOW_FRAMES: this.env('OPENWAKEWORD_CONFIRM_WINDOW_FRAMES') || '4',
        OPENWAKEWORD_CONFIRM_COUNT: this.env('OPENWAKEWORD_CONFIRM_COUNT') || '2',
        OPENWAKEWORD_DIAGNOSTIC_FLOOR: this.env('OPENWAKEWORD_DIAGNOSTIC_FLOOR') || '0.03',
        OPENWAKEWORD_MODELS: this.env('OPENWAKEWORD_MODELS') || 'hey_jarvis'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.worker.stdout.on('data', data => this._handleOutput(data.toString()));
    this.worker.stderr.on('data', data => {
      const text = data.toString().trim();
      if (text) wrn('openWakeWord: ' + text.split('\n').pop());
    });
    this.worker.on('error', error => {
      this.lastError = error.message;
      wrn('openWakeWord worker ishga tushmadi: ' + error.message);
      this._scheduleRestart();
    });
    this.worker.on('close', (code, signal) => {
      this.ready = false;
      this.lastExit = { code, signal: signal || null, at: Date.now() };
      if (!this.closed && code !== 0) {
        this.lastError = 'worker exited with code ' + code;
        wrn('openWakeWord worker to\'xtadi (code=' + code + ') — bounded restart, fallback faol');
      }
      if (!this.closed) this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * (2 ** Math.min(this.restartCount, 6)));
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._startWorker();
    }, delay);
    this.restartTimer.unref?.();
  }

  _handleOutput(text) {
    this.lineBuffer += text;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop();
    for (const line of lines) {
      if (line === 'READY') {
        this.ready = true;
        this.restartCount = 0;
        this.lastError = null;
        ok('openWakeWord lokal worker tayyor (bepul)');
      } else if (line.startsWith('MODELS ')) {
        ok('openWakeWord modellar: ' + line.slice(7));
      } else if (line.startsWith('DETECT ')) {
        this.detected = parseWakeWorkerLine(line);
        if (this.detected) inf('openWakeWord model=' + this.detected.model + ' score=' + this.detected.score.toFixed(4));
      } else if (line.startsWith('SCORE ')) {
        inf('openWakeWord candidate score=' + line.slice(6));
      } else if (line.startsWith('ERROR ')) {
        wrn('openWakeWord: ' + line.slice(6));
      }
    }
  }

  processChunk(pcm16Buffer) {
    if (!this.closed && this.worker?.stdin?.writable && this.worker.stdin.writableLength < this.sampleRate * 2) {
      this.worker.stdin.write(pcm16Buffer);
    }
    const result = this.detected;
    this.detected = null;
    return result;
  }

  health() {
    return {
      status: this.ready ? 'ready' : this.closed ? 'stopped' : this.restartTimer ? 'restarting' : 'starting',
      ready: this.ready,
      pid: this.worker?.pid || null,
      restartCount: this.restartCount,
      lastError: this.lastError,
      lastExit: this.lastExit
    };
  }

  release() {
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try { this.worker?.stdin?.end(); } catch (e) {}
    try { this.worker?.kill(); } catch (e) {}
  }
}

module.exports = { OpenWakeWordDetector, parseWakeWorkerLine };
