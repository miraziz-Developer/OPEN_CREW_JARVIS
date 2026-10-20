'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_DIR } = require('./paths');

const DEFAULT_BINARY = path.join(PROJECT_DIR, '.run', 'bin', 'jarvis-voice-io');
const BUILD_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'build-voice-io.sh');

/**
 * macOS Voice Processing (AEC + noise suppression) microphone stream.
 * The jarvis-voice-io helper provides 16 kHz mono PCM16. If the helper is missing, not permitted or
 * fails, an 'unavailable'/'exit' event is emitted and the caller falls back to the plain microphone path.
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

/**
 * Builds the helper in the background when it is missing. Without it JARVIS falls
 * back to the software echo canceller, which lets its own voice through as a
 * false barge-in and pauses replies mid-sentence. Calls back with a status string.
 */
function ensureNativeMicBinary(options = {}) {
  const exists = options.exists || (file => fs.existsSync(file));
  const run = options.spawn || spawn;
  const binary = options.binary || DEFAULT_BINARY;
  const done = options.onDone || (() => {});
  if ((options.platform || process.platform) !== 'darwin') return done('unsupported-platform');
  if (exists(binary)) return done('present');
  let proc;
  try {
    proc = run('/bin/bash', [options.script || BUILD_SCRIPT], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) { return done('build-failed: ' + error.message); }
  let stderr = '';
  proc.stderr?.on('data', chunk => { stderr += chunk; });
  proc.on('error', error => done('build-failed: ' + error.message));
  proc.on('exit', code => done(code === 0 && exists(binary) ? 'built' : 'build-failed: ' + (stderr.trim().split('\n').pop() || `exit ${code}`)));
}

module.exports = { NativeMic, DEFAULT_BINARY, ensureNativeMicBinary };
