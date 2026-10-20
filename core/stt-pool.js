'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const NOISE_ONLY = /^(?:\([^)]+\)|[[({<].*?[\])}>]|[*_~.?!,\s]+)$/;

function whisperBinary() {
  if (process.env.WHISPER_WAKE_BINARY) return process.env.WHISPER_WAKE_BINARY;
  return fs.existsSync('/opt/homebrew/bin/whisper-cli') ? '/opt/homebrew/bin/whisper-cli' : 'whisper-cli';
}

/**
 * Transcribes with local whisper.cpp. Asynchronous on purpose: this runs inside the voice
 * daemon, and a synchronous call would freeze microphone capture and audio playback.
 * Resolves to the text, or null when there is no speech / whisper is unavailable.
 */
async function transcribeWithWhisper(audioWavBuffer, projectDir, locale = 'auto') {
  const model = path.join(projectDir, 'models', 'whisper', 'ggml-base.bin');
  if (!fs.existsSync(model)) return null;

  const tmpWav = path.join(os.tmpdir(), `whisper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  const rawLang = String(locale || 'auto').trim().toLowerCase().split(/[-_]/)[0];
  const lang = rawLang && rawLang !== 'auto' ? rawLang : 'auto';
  try {
    await fs.promises.writeFile(tmpWav, audioWavBuffer);
    const out = await new Promise((resolve, reject) => {
      execFile(whisperBinary(), ['-m', model, '-f', tmpWav, '-nt', '-ng', '-l', lang], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` }
      }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    const text = out
      .replace(/\[\d+:\d+:\d+\.\d+ --> \d+:\d+:\d+\.\d+\]/g, '')
      .replace(/\[(?:BLANK_AUDIO|no speech detected)\]/gi, '')
      .trim();
    // Sighs, background music and similar annotations are not speech.
    return text && !NOISE_ONLY.test(text) ? text : null;
  } catch (_) {
    return null;
  } finally {
    fs.promises.unlink(tmpWav).catch(() => {});
  }
}

function recordCloudStt(provider) {
  try { require('./usage-meter').sharedMeter().add(`stt_${provider}_requests`, 1); } catch (_) {}
}

let gemini = null;
try { gemini = require('./gemini'); } catch (_) {}

/**
 * Speech-to-text with a cost-ordered fallback chain:
 *   1. local whisper.cpp (free)
 *   2. Gemini audio understanding
 *   3. a pool of pre-spawned Azure STT workers
 * Pass `{ localOnly: true }` for wake-word checks, so background noise never reaches a paid API.
 */
class STTPool {
  constructor({ size = 2, projectDir, env } = {}) {
    this.size = size;
    this.projectDir = projectDir;
    this.pool = [];
    this.env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      GEMINI_API_KEY: env('GEMINI_API_KEY'),
      GOOGLE_API_KEY: env('GOOGLE_API_KEY'),
      JARVIS_BRAIN: env('JARVIS_BRAIN') || 'gemini',
      DEFAULT_MODEL: env('DEFAULT_MODEL') || 'gemini-3.8-flash',
      AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'),
      AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'),
      AZURE_SPEECH_LANGUAGE: env('AZURE_SPEECH_LANGUAGE'),
      AZURE_TRANSCRIBE_ENDPOINT: env('AZURE_TRANSCRIBE_ENDPOINT'),
      AZURE_TRANSCRIBE_KEY: env('AZURE_TRANSCRIBE_KEY'),
      AZURE_TRANSCRIBE_DEPLOYMENT: env('AZURE_TRANSCRIBE_DEPLOYMENT')
    };
    for (let i = 0; i < size; i++) this._spawn(i);
  }

  _spawn(idx) {
    const proc = spawn('node', ['skills/azure-stt/index.js'], { cwd: this.projectDir, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc._busy = false;
    proc._idx = idx;
    proc._buffer = '';
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('error', () => { this._respawn(idx); });
    proc.on('exit', () => { this._respawn(idx); });
    this.pool[idx] = proc;
  }

  _respawn(idx) {
    try { this.pool[idx]?.kill?.(); } catch (_) {}
    this._spawn(idx);
  }

  async recognize(audioWavBuffer, locale = 'auto', { localOnly = false } = {}) {
    const whisperText = await transcribeWithWhisper(audioWavBuffer, this.projectDir, locale);
    if (whisperText) return { status: 'ok', text: whisperText, confidence: 0.96, provider: 'whisper-metal' };
    if (localOnly) return { status: 'error', text: '', reason: 'no-speech' };

    if (gemini && gemini.hasGemini()) {
      try {
        recordCloudStt('gemini');
        const text = await gemini.transcribeAudio({ audioBuffer: audioWavBuffer, locale });
        if (text) return { status: 'ok', text, confidence: 0.98, provider: 'gemini-direct' };
      } catch (_) {}
    }

    if (!this.pool.length) return { status: 'error', text: '', reason: 'no-provider' };
    recordCloudStt('azure');
    return this._recognizeWithWorker(audioWavBuffer, locale);
  }

  _recognizeWithWorker(audioWavBuffer, locale) {
    let child = this.pool.find(p => !p._busy);
    if (!child) {
      // All workers busy: reuse the one with the least buffered output.
      child = this.pool.reduce((a, b) => (a._buffer.length < b._buffer.length ? a : b));
      child._buffer = '';
    }
    child._busy = true;
    child._buffer = '';

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        child.stdout.off('data', onData); // otherwise listeners pile up and corrupt later calls
        child._busy = false;
        resolve({ status: 'error', text: '', reason: 'timeout' });
      }, 12000);
      const onData = d => {
        child._buffer += d;
        for (const rawLine of child._buffer.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.status || parsed.error) {
              clearTimeout(timeout);
              child.stdout.off('data', onData);
              child._busy = false;
              resolve(parsed.status === 'ok' ? parsed : { status: 'error', text: '', reason: parsed.error || 'unknown' });
              return;
            }
          } catch (_) {}
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ audioBase64: audioWavBuffer.toString('base64'), locale }) + '\n');
    });
  }

  killAll() { this.pool.forEach(p => { try { p.kill('SIGKILL'); } catch (_) {} }); }
}

module.exports = { STTPool, transcribeWithWhisper };
