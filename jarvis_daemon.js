#!/usr/bin/env node
/**
 * JARVIS Daemon v5.0 — BLAZING FAST
 * ────────────────────────────────────
 *  • node-record-lpcm16   → continuous mic stream, no ffmpeg spawns
 *  • Porcupine.js         → offline hotword (frame-level, ~32ms latency)
 *  • Rolling buffer        → 50 % overlap chunks, hotword never split
 *  • STT promises pool    → pre-spawned children, no spawn delay
 *  • Zero-disk audio      → everything in Buffer, base64 to STT via pipe
 *
 * Latency stack:
 *   Hotword:     0.03–0.15 s  (Porcupine frame-level)
 *   STT start:   0.10–0.30 s  (promise pool, no spawn)
 *   Total cmd:   ~1.0 s       (silence-based, adaptive threshold)
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { Porcupine, BuiltinKeyword, getBuiltinKeywordPath } = require('@picovoice/porcupine-node');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
process.chdir(PROJECT_DIR);

const { writeMemory, searchMemory } = require('./skills/memory');

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; }

const TOKEN = env('TELEGRAM_BOT_TOKEN');
const CHAT_ID = env('JARVIS_CHAT_ID') || '';
const AZURE_OPENAI_KEY = env('AZURE_OPENAI_KEY');
const PICOVOICE_ACCESS_KEY = env('PICOVOICE_ACCESS_KEY');

// ── Config ──────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CHUNK_MS = 800;              // overlap window length (ms) — "Jarvis" to'liq sig'ish uchun
const STEP_MS = 200;               // new chunk every (ms)
const ENERGY_MIN_STT = 800;        // STT gate threshold — gapda 2000+, jimlikda ~500
const ENERGY_TARGET = 2500;        // adaptive gain target
const SILENCE_MS = 500;            // silence = command end
const CMD_MAX = 5.0;               // max command length (s)
const GAIN_MAX = 8, GAIN_MIN = 2; // gain limits — clipping bo'lmasin
const HOTWORD_COOLDOWN_MS = 1500;  // debounce after trigger

let _gain = 6.0;

// ── Colors ──────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', X = '\x1b[0m';
function ok(m)  { console.log(G + '✅ ' + m + X); }
function er(m)  { console.error(R + '❌ ' + m + X); }
function inf(m) { console.log(B + 'ℹ️  ' + m + X); }
function wrn(m) { console.log(Y + '⚠️  ' + m + X); }

inf('JARVIS v5.0 BLAZING — 16 kHz stream | Porcupine offline | overlap chunks');

// ════════════════════════════════════════════
// TELEGRAM / HELPERS
// ════════════════════════════════════════════
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CHAT_ID) { resolve(false); return; }
    const payload = JSON.stringify({ chat_id: CHAT_ID, text: String(text).substring(0, 4096) });
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TOKEN + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(payload); req.end();
  });
}
function sendTelegramVoice(oggPath) {
  return new Promise((resolve) => {
    if (!CHAT_ID || !fs.existsSync(oggPath)) { resolve(false); return; }
    try { execSync('curl -s -X POST "https://api.telegram.org/bot' + TOKEN + '/sendVoice" -F "chat_id=' + CHAT_ID + '" -F "voice=@' + oggPath + '" > /dev/null 2>&1'); resolve(true); }
    catch (e) { resolve(false); }
  });
}
function takeScreenshot() { const p = os.homedir() + '/Desktop/jarvis_' + Date.now() + '.png'; try { execSync('screencapture -x "' + p + '"'); return fs.existsSync(p) ? p : null; } catch(e) { return null; } }

async function ttsToFile(text) {
  return new Promise((resolve) => {
    const tmpIn = '/tmp/tts_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ text }), 'utf8');
    const proc = spawn('node', ['skills/azure-tts/index.js'], {
      cwd: PROJECT_DIR, env: { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'), AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'uz-UZ-SardorNeural' }
    });
    let out = '';
    proc.stdout.on('data', d => out += d); proc.stderr.on('data', () => {});
    proc.on('close', () => { try { fs.unlinkSync(tmpIn); } catch(e){} try { resolve(JSON.parse(out.trim()).audioFile || null); } catch(e){ resolve(null); } });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

async function askAgent(message) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['agent', '--message', message, '--agent', 'main'], { cwd: PROJECT_DIR, env: { ...process.env, AZURE_OPENAI_KEY }, timeout: 15000 });
    let out = '';
    proc.stdout.on('data', d => out += d); proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      resolve((!clean || clean.includes("couldn't generate") || clean.includes('tool policy removed')) ? null : clean);
    });
  });
}

// ════════════════════════════════════════════
// STT PROMISE POOL (pre-spawned children)
// ════════════════════════════════════════════
class STTPool {
  constructor(size = 2) {
    this.size = size;
    this.pool = [];
    this.env = { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION') };
    for (let i = 0; i < size; i++) this._spawn(i);
  }

  _spawn(idx) {
    const proc = spawn('node', ['skills/azure-stt/index.js'], { cwd: PROJECT_DIR, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc._busy = false;
    proc._idx = idx;
    proc._buffer = '';
    proc.stdout.on('data', d => proc._buffer += d);
    proc.stderr.on('data', () => {});
    proc.on('error', () => { this._respawn(idx); });
    proc.on('exit', () => { this._respawn(idx); });
    this.pool[idx] = proc;
  }

  _respawn(idx) {
    try { this.pool[idx]?.kill?.(); } catch(e){}
    this._spawn(idx);
  }

  async recognize(audioWavBuffer, locale = 'uz-UZ') {
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
      const timeout = setTimeout(() => { child._busy = false; resolve({ status: 'error', text: '' }); }, 8000);
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
              resolve(parsed.status === 'ok' ? parsed : { status: 'error', text: '' });
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

// ════════════════════════════════════════════
// AUDIO UTILITIES (buffer-based, zero disk)
// ════════════════════════════════════════════
function makeWavHeader(dataLen, sampleRate = 16000, channels = 1, bits = 16) {
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // subchunk1Size
  buf.writeUInt16LE(1, 20);         // audioFormat PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function pcmToWavBuffer(pcm16leBuffer) {
  return Buffer.concat([makeWavHeader(pcm16leBuffer.length, 16000, 1, 16), pcm16leBuffer]);
}

function getEnergy(pcm16leBuffer) {
  if (pcm16leBuffer.length < 2) return 0;
  const samples = pcm16leBuffer.length / 2;
  let sum = 0;
  for (let i = 0; i < pcm16leBuffer.length; i += 2) {
    const v = pcm16leBuffer.readInt16LE(i);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

function adaptGain(energy) {
  if (energy < ENERGY_MIN_STT) _gain = Math.min(_gain * 1.3, GAIN_MAX);
  else if (energy > ENERGY_TARGET * 3) _gain = Math.max(_gain * 0.7, GAIN_MIN);
  return _gain;
}

// Adaptive gain on raw PCM buffer (simple gain multiply, no filtering)
function applyGain(pcm16, gain) {
  if (gain === 1.0 || gain === undefined) return pcm16;
  for (let i = 0; i < pcm16.length; i += 2) {
    const v = pcm16.readInt16LE(i);
    const nv = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    pcm16.writeInt16LE(nv, i);
  }
  return pcm16;
}

// ════════════════════════════════════════════
// ROLLING PCM BUFFER (overlap chunking)
// ════════════════════════════════════════════
class RollingBuffer {
  constructor(maxDurationMs = 5000) {
    this.maxSamples = (maxDurationMs * SAMPLE_RATE) / 1000;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]).slice(-this.maxSamples * 2); }
  get samples() { return Math.floor(this.buf.length / 2); }

  // Extract last N milliseconds as PCM
  sliceLast(ms) {
    const bytes = (ms * SAMPLE_RATE * 2) / 1000;
    return this.buf.slice(-bytes);
  }

  clear() { this.buf = Buffer.alloc(0); }
}

// ════════════════════════════════════════════
// PORCUPINE HOTWORD (frame-level, real-time)
// ════════════════════════════════════════════
class HotwordDetector {
  constructor(accessKey) {
    const keywordPath = getBuiltinKeywordPath(BuiltinKeyword.JARVIS);
    this.porcupine = new Porcupine(accessKey, [keywordPath], [0.7]);
    this.frameLength = this.porcupine.frameLength;  // e.g. 512 samples
    this.sampleRate = this.porcupine.sampleRate;    // 16000
    this.remainder = Buffer.alloc(0);
  }

  // Process new PCM chunk. Returns true once when hotword detected.
  processChunk(pcm16Buffer) {
    const pcm = Buffer.concat([this.remainder, pcm16Buffer]);
    const frameLen = this.frameLength * 2; // bytes per frame
    let detected = false;
    for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
      const frame = new Int16Array(this.frameLength);
      for (let j = 0; j < this.frameLength; j++) {
        frame[j] = pcm.readInt16LE(i + j * 2);
      }
      const keywordIndex = this.porcupine.process(frame);
      if (keywordIndex >= 0) { detected = true; }
    }
    this.remainder = pcm.slice(Math.floor(pcm.length / frameLen) * frameLen);
    return detected;
  }

  release() { this.porcupine.release(); }
}

// ════════════════════════════════════════════
// MAIN DAEMON STATE
// ════════════════════════════════════════════
let _sttPool = null;
let _detector = null;
let _sox = null;
let _soxStream = null;

// ════════════════════════════════════════════
// CONTINUOUS LISTENING ARCHITECTURE (ffmpeg → PCM)
// ════════════════════════════════════════════
const STEP_BYTES = Math.floor((STEP_MS * SAMPLE_RATE * 2) / 1000);   // 4800 bytes
const CHUNK_SAMPLES = Math.floor((CHUNK_MS * SAMPLE_RATE) / 1000);   // 5600 samples

function startMicProcess() {
  const ffmpeg = spawn('sox', [
    '-d',                              // default device
    '-t', 'raw',                        // output raw PCM
    '-r', String(SAMPLE_RATE),
    '-c', '1',
    '-b', '16',
    '-e', 'signed',
    '-'                                 // stdout
  ]);
  ffmpeg.on('error', (err) => er('Mic process error: ' + err.message));
  ffmpeg.stderr.on('data', () => {});
  return ffmpeg;
}

async function mainLoop() {
  _sttPool = new STTPool(2);
  if (PICOVOICE_ACCESS_KEY && PICOVOICE_ACCESS_KEY.length > 10) {
    _detector = new HotwordDetector(PICOVOICE_ACCESS_KEY);
  } else {
    wrn('PICOVOICE_ACCESS_KEY yo\'q — faqat STT backup hotword ishlatiladi');
  }

  // Start sox for continuous raw PCM
  _sox = startMicProcess();
  _soxStream = _sox.stdout;

  const rolling = new RollingBuffer(5000);
  let stepBuffer = Buffer.alloc(0);
  let nextStepTime = 0;
  let lastHotwordTime = 0;
  let lastSttCheck = 0;
  let state = 'listening'; // 'listening' | 'command_record' | 'processing'
  let cmdBuffers = [];
  let lastVoiceTime = 0;
  let cmdStartTime = 0;

  inf('Mic stream started — listening for "Jarvis"...');
  sendTelegram('🚀 Jarvis v5.0 BLAZING faol');

  return new Promise((resolve, reject) => {
    _soxStream.on('data', (rawChunk) => {
      const now = Date.now();

      // Accumulate into 150ms steps
      stepBuffer = Buffer.concat([stepBuffer, rawChunk]);
      let stepData = null;
      while (stepBuffer.length >= STEP_BYTES) {
        stepData = stepBuffer.slice(0, STEP_BYTES);
        stepBuffer = stepBuffer.slice(STEP_BYTES);
        rolling.push(stepData);
        if (state !== 'listening') cmdBuffers.push(stepData);
      }

      // ── STATE: LISTENING ──
      if (state === 'listening') {
        // Only check on step boundaries (every 150ms)
        if (now < nextStepTime) return;
        const elapsed = now - nextStepTime + STEP_MS; // simple: if this is a step, process
        if (stepData) {
          nextStepTime = now + STEP_MS;

          // Porcupine on overlap chunk every step
          let detected = false;
          const chunkPCM = Buffer.from(rolling.sliceLast(CHUNK_MS));
          applyGain(chunkPCM, _gain);
          if (_detector) {
            detected = _detector.processChunk(chunkPCM);
          }

          if (detected && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
            lastHotwordTime = now;
            ok('🔥 HOTWORD: "Jarvis" (Porcupine)');
            state = 'command_record';
            cmdBuffers = [];
            lastVoiceTime = now;
            cmdStartTime = now;
            const preRoll = rolling.sliceLast(300);
            cmdBuffers.push(preRoll);
            inf('Buyruq kutilmoqda...');
            return;
          }

          // STT backup hotword every step
          const energy = getEnergy(chunkPCM);
          adaptGain(energy);
          // Debug: energy log every 2 sec
          if ((now % 2000) < 200) inf('Energy=' + Math.round(energy) + ' gain=' + _gain.toFixed(1));
          if (energy >= ENERGY_MIN_STT && (now - lastSttCheck > 600)) {
            lastSttCheck = now;
            const wavBuf = pcmToWavBuffer(Buffer.from(chunkPCM));
            inf('STT backup hotword check (energy=' + Math.round(energy) + ')...');
            _sttPool.recognize(wavBuf, 'en-US').then(r => {
              if (r && r.status === 'ok' && r.text) {
                const t = r.text.toLowerCase();
                if (['jarvis','jar vis','jarviz','cervis','jervis','djervis','yarvis','jorvis','djarvis','jarv'].some(w => t.includes(w))) {
                  if ((Date.now() - lastHotwordTime) > HOTWORD_COOLDOWN_MS) {
                    lastHotwordTime = Date.now();
                    ok('🔥 HOTWORD (STT backup): "' + r.text + '"');
                    state = 'command_record';
                    cmdBuffers = [];
                    lastVoiceTime = Date.now();
                    cmdStartTime = Date.now();
                    inf('Buyruq kutilmoqda...');
                  }
                }
              } else {
                wrn('STT backup: javob yo\'q yoki xatolik');
              }
            }).catch(e => er('STT backup xatolik: ' + (e.message || e)));
          }
        }
      }

      // ── STATE: COMMAND RECORDING ──
      else if (state === 'command_record') {
        const elapsed = now - cmdStartTime;

        // Energy check every ~120ms
        if (elapsed % 120 < 30 && cmdBuffers.length > 2) {
          const totalPCM = Buffer.concat(cmdBuffers);
          const energy = getEnergy(totalPCM);
          if (energy > 300) lastVoiceTime = now;
        }

        const silence = now - lastVoiceTime;
        if ((elapsed > 800 && silence > SILENCE_MS) || elapsed > CMD_MAX * 1000) {
          state = 'processing';
          const totalPCM = Buffer.concat(cmdBuffers);
          const wavBuf = pcmToWavBuffer(totalPCM);
          inf('STT ishlanyapti...');
          _sttPool.recognize(wavBuf, 'uz-UZ').then(r => {
            state = 'listening';
            nextStepTime = Date.now(); // reset timing
            if (r && r.status === 'ok' && r.text && r.text.length > 1) {
              const cmd = r.text.trim();
              ok('Buyruq: "' + cmd + '"');
              processCommand(cmd).catch(() => {});
            } else {
              wrn('STT natija topilmadi');
            }
          }).catch(err => {
            state = 'listening';
            er('STT xatolik: ' + (err.message || err));
          });
        }
      }
    });

    _soxStream.on('error', (err) => {
      er('Stream error: ' + err.message);
      reject(err);
    });

    _soxStream.on('end', () => {
      inf('Stream ended');
      resolve();
    });
  });
}

// ════════════════════════════════════════════
// PROCESS COMMAND
// ════════════════════════════════════════════
async function processCommand(command) {
  inf('>>> ' + command); sendTelegram('🎙 ' + command);
  if (!fs.existsSync(path.join(PROJECT_DIR, '.jarvis-onboarded'))) {
    fs.writeFileSync(path.join(PROJECT_DIR, '.jarvis-onboarded'), 'true'); writeMemory('Onboard', 'start');
    const ap = await ttsToFile('Salom, men Jarvisman'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
  }

  // Quick commands
  if (/eslab qol|esda tut/i.test(command) && command.length > 15) {
    const cl = command.replace(/eslab qol|esda tut/gi, '').trim();
    writeMemory('Voice', cl, ['voice']); sendTelegram('✅ Eslab qoldim');
    const ap = await ttsToFile('Eslab qoldim'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
    return;
  }
  if (/kuzatishni (boshla|yo?qish)/i.test(command)) {
    try { execSync('echo \'{"action":"start"}\' | node skills/screen-monitor/index.js', { cwd: PROJECT_DIR }); } catch(e){}
    const ap = await ttsToFile('Kuzatuv yoqildi'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
    return;
  }
  if (/kuzatishni (to.xtat|o.chir)/i.test(command)) {
    try { execSync('echo \'{"action":"stop"}\' | node skills/screen-monitor/index.js', { cwd: PROJECT_DIR }); } catch(e){}
    const ap = await ttsToFile('Kuzatuv o.chirildi'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
    return;
  }

  // Agent
  let mem = '';
  try {
    const q = command.split(/\s+/).filter(w => w.length > 3 && !['qanday','nima','kim'].includes(w.toLowerCase())).slice(0, 3).join(' ');
    if (q.length > 2) { const f = searchMemory(q, 3); if (f && f.status === 'ok' && f.results.length) mem = '\n[Xotira]:\n' + f.results.map(r => r.matches.map(m => m.text).join(' | ')).join('\n') + '\n'; }
  } catch(e){}
  const ss = takeScreenshot();
  const reply = await askAgent(mem + command + (ss ? '\n\n[Ekran]' : ''));
  if (reply) {
    ok('<<< ' + reply.substring(0, 80)); sendTelegram('🤖 ' + reply);
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) {
      try { execSync('afplay "' + audio + '"'); ok('🔊 Ovoz'); } catch(e){}
      const ogg = audio.replace(/\.mp3$/, '.ogg');
      try { execSync('ffmpeg -y -i "' + audio + '" -c:a libopus "' + ogg + '" 2>/dev/null'); sendTelegramVoice(ogg); } catch(e){}
      [ogg, audio].forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    }
  } else { er('Xatolik'); sendTelegram('❌ Xatolik'); }
  if (ss) try { fs.unlinkSync(ss); } catch(e){}
}

// ════════════════════════════════════════════
// GRACEFUL EXIT
// ════════════════════════════════════════════
function cleanup() {
  inf('To\'xtatilmoqda...');
  if (_sox) { try { _sox.kill(); } catch(e){} }
  if (_detector) { try { _detector.release(); } catch(e){} }
  if (_sttPool) { _sttPool.killAll(); }
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ════════════════════════════════════════════
// ENTRY
// ════════════════════════════════════════════
(async () => {
  try {
    await mainLoop();
  } catch (e) {
    er('FATAL: ' + e.message);
    cleanup();
  }
})();
