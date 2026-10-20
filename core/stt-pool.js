'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function transcribeWithWhisper(audioWavBuffer, projectDir, locale = 'auto') {
  const model = path.join(projectDir, 'models', 'whisper', 'ggml-base.bin');
  if (!fs.existsSync(model)) return null;
  const whisperBin = fs.existsSync('/opt/homebrew/bin/whisper-cli') ? '/opt/homebrew/bin/whisper-cli' : 'whisper-cli';
  const tmpWav = path.join(os.tmpdir(), `whisper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  try {
    fs.writeFileSync(tmpWav, audioWavBuffer);
    const rawLang = String(locale || 'auto').trim().toLowerCase().split(/[-_]/)[0];
    const lang = (rawLang && rawLang !== 'auto') ? rawLang : 'auto';
    const out = execFileSync(whisperBin, ['-m', model, '-f', tmpWav, '-nt', '-ng', '-l', lang], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let text = out
      .replace(/\[\d+:\d+:\d+\.\d+ --> \d+:\d+:\d+\.\d+\]/g, '')
      .replace(/\[(?:BLANK_AUDIO|no speech detected)\]/gi, '')
      .trim();

    // Shovqin, xo'rsinish yoki fon musiqasi (sighs, upbeat music, crickets chirping) ni haqiqiy nutq deb olmaslik
    if (!text || /^\([^)]+\)$/.test(text) || /^[[({<].*?[\])}>]$/.test(text) || /^[*_~.?!,\s]+$/.test(text)) {
      return null;
    }
    return text;
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
}

// ════════════════════════════════════════════
// STT PROMISE POOL (pre-spawned children)
// ════════════════════════════════════════════
let gemini = null;
try { gemini = require('./gemini'); } catch (_) {}

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
    try { this.pool[idx]?.kill?.(); } catch(e){}
    this._spawn(idx);
  }

  async recognize(audioWavBuffer, locale = 'auto') {
    // 1. Local Whisper.cpp (0 API quota, Apple Silicon Metal accelerated, ~200ms)
    const whisperText = transcribeWithWhisper(audioWavBuffer, this.projectDir, locale);
    if (whisperText && whisperText.length > 0) {
      return { status: 'ok', text: whisperText, confidence: 0.96, provider: 'whisper-metal' };
    }

    // 2. Direct Gemini Multimodal STT (if available)
    if (gemini && gemini.hasGemini()) {
      try {
        const text = await gemini.transcribeAudio({ audioBuffer: audioWavBuffer, locale });
        if (text && text.length > 0) {
          return { status: 'ok', text, confidence: 0.98, provider: 'gemini-direct' };
        }
      } catch (_) {}
    }

    // find idle child
    let child = this.pool.find(p => !p._busy);
    if (!child) {
      // all busy, just take the one with most data
      child = this.pool.reduce((a, b) => (a._buffer.length < b._buffer.length ? a : b));
      child._buffer = '';
    }
    child._busy = true;
    child._buffer = '';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.stdout.off('data', onData); // aks holda listener to'planib, keyingi chaqiruvlarni buzadi
        child._busy = false;
        resolve({ status: 'error', text: '', reason: 'timeout' });
      }, 12000);
      const onData = (d) => {
        child._buffer += d;
        const lines = child._buffer.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
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
          } catch(e) {}
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ audioBase64: audioWavBuffer.toString('base64'), locale }) + '\n');
    });
  }

  killAll() { this.pool.forEach(p => { try { p.kill('SIGKILL'); } catch(e){} }); }
}

module.exports = { STTPool };
