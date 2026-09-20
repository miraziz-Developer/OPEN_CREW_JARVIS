'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_DIR } = require('./paths');

const DEFAULT_BINARY = path.join(PROJECT_DIR, '.run', 'bin', 'jarvis-voice-io');

/**
 * macOS Voice Processing (AEC + shovqin bostirish) mikrofon oqimi.
 * jarvis-voice-io yordamchisi 16 kHz mono PCM16 beradi. Yordamchi yo'q, ruxsat berilmagan yoki
 * ishlamay qolsa 'unavailable'/'exit' hodisasi chiqadi va chaqiruvchi oddiy mikrofon yo'liga qaytadi.
 */
class NativeMic extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binary = options.binary || DEFAULT_BINARY;
    this._spawn = options.spawn || spawn;
    this._exists = options.exists || (file => fs.existsSync(file));
    this.proc = null;
    this.ready = false;
    this.stopped = false;
  }

  static isSupported(binary = DEFAULT_BINARY) {
    return process.platform === 'darwin' && fs.existsSync(binary);
  }

  start() {
    if (this.proc || this.stopped) return false;
    if (process.platform !== 'darwin' || !this._exists(this.binary)) {
      this.emit('unavailable', 'binary-missing');
      return false;
    }
    let proc;
    try {
      proc = this._spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.emit('unavailable', error.message);
      return false;
    }
    this.proc = proc;
    let stderr = '';
    proc.stdout.on('data', chunk => this.emit('data', chunk));
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (!this.ready && /READY/.test(stderr)) { this.ready = true; this.emit('ready'); }
    });
    proc.stdin.on('error', () => {});
    proc.on('error', error => { this.proc = null; this.emit('unavailable', error.message); });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.ready = false;
      this.emit('exit', { code, signal, error: /ERROR:\s*(.*)/.exec(stderr)?.[1] || '' });
    });
    return true;
  }

  stop() {
    this.stopped = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch (e) {}
    try { proc.kill('SIGTERM'); } catch (e) {}
  }
}

module.exports = { NativeMic, DEFAULT_BINARY };
