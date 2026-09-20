#!/usr/bin/env node
/**
 * PAUSE SENTINEL — Fn+Shift bilan Jarvisni to'liq to'xtatish/uyg'otish.
 * jarvis_daemon.js'dan MUSTAQIL ishlaydi (alohida LaunchAgent) — shuning
 * uchun Jarvis to'xtatilganda ham shu tinglovchi ishlab turadi va
 * "uyg'otish" ishorasini kuta oladi. O'zi juda yengil (faqat fnkey
 * binary'ni tinglaydi), RAM deyarli yemaydi.
 *
 * MUHIM: fnkey binary'ni FAQAT shu jarayon spawn qiladi (yagona CGEventTap).
 * Avval jarvis_daemon.js ham o'zining alohida fnkey nusxasini ishga
 * tushirar edi (push-to-talk uchun) — ikkita jarayon bir xil jismoniy
 * tugmani bir vaqtda kuzatishi ba'zan bir-biriga xalaqit berib (masalan
 * daemon qayta ishga tushganda), noto'g'ri COMBO signalini keltirib
 * chiqargan (Jarvis o'zi-o'zidan pauzaga tushib qolgan holat). Shuning
 * uchun endi DOWN/UP hodisalari mahalliy Unix socket orqali (broker)
 * jarvis_daemon.js'ga uzatiladi — bitta hardware hook, ikkita iste'molchi.
 */

const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const { PROJECT_DIR } = require('../core/paths');
const { findMatchingProcesses } = require('../core/runtime-health');
const FNKEY_BIN = path.join(PROJECT_DIR, 'skills', 'fn-key', 'fnkey');
const PAUSE_MARKER = path.join(PROJECT_DIR, '.jarvis-paused');
const JARVIS_SH = path.join(PROJECT_DIR, 'scripts', 'jarvis.sh');
const FNKEY_SOCK = path.join(PROJECT_DIR, '.run', 'fnkey.sock');

let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) {}
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

// launchd stdout faylga yo'naltirilganda console.log ba'zan kech flush bo'ladi.
// Diagnostika real vaqtda ko'rinishi uchun muhim logni faylga ham sinxron yozamiz.
const LOG_FILE = path.join(PROJECT_DIR, 'logs', 'pause-sentinel.log');
function log(m) {
  const line = '[' + new Date().toISOString() + '] ' + m + '\n';
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function isRunning() {
  return findMatchingProcesses(path.join(PROJECT_DIR, 'jarvis_daemon.js')).length > 0;
}

function waitUntilReady(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (isRunning()) {
        try {
          const body = execSync('curl -sf --max-time 2 http://127.0.0.1:7890/api/status', { encoding: 'utf8' });
          if (body) return resolve(true);
        } catch (e) {}
      }
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 1000);
    };
    check();
  });
}

function speak(text) {
  try {
    const tmpIn = '/tmp/pause_tts_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ text }), 'utf8');
    const out = execSync('node "' + path.join(PROJECT_DIR, 'skills', 'azure-tts', 'index.js') + '" < "' + tmpIn + '"', {
      cwd: PROJECT_DIR,
      env: { 
        ...process.env, 
        AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), 
        AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'), 
        AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || env('AZURE_VOICELIVE_VOICE') || 'en-US-AndrewNeural',
        AZURE_VOICELIVE_VOICE: env('AZURE_VOICELIVE_VOICE') || 'en-US-AndrewNeural'
      },
      encoding: 'utf8', timeout: 15000
    });
    fs.unlinkSync(tmpIn);
    const audioFile = JSON.parse(out.trim()).audioFile;
    if (audioFile) {
      execSync('afplay "' + audioFile + '"', { timeout: 15000 });
      fs.unlinkSync(audioFile);
    }
  } catch (e) { log('TTS xatolik: ' + e.message); }
}

// MUHIM: com.jarvis.openclaw launchd'da KeepAlive=true bilan boshqariladi —
// shuning uchun uning jarayonini oddiy kill/pkill bilan o'ldirish YETARLI
// EMAS, launchd uni darhol qayta ishga tushirib yuboradi. To'g'ri to'xtatish
// uchun launchd'ning o'zidan (`launchctl bootout`) chiqarish kerak; qayta
// yoqish uchun `launchctl bootstrap`.
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const PLIST_LABEL = 'com.jarvis.openclaw';
const PLIST_PATH = path.join(require('os').homedir(), 'Library', 'LaunchAgents', PLIST_LABEL + '.plist');

let toggleBusy = false;
let lastComboAt = 0;

async function pause() {
  log('Pauza qilinmoqda...');
  speak('Standing down.');
  try { execSync('launchctl bootout gui/' + UID + '/' + PLIST_LABEL, { timeout: 15000 }); } catch (e) { log('bootout (davom etamiz): ' + e.message); }
  // Ehtiyot uchun: supervisor skriptga "stop" berilmaydi — u argumentni
  // tushunmaydi va aksincha daemonni qayta yoqishi mumkin. Jarayonlar to'g'ridan
  // to'g'ri to'xtatiladi; pause marker supervisor qayta startini bloklaydi.
  for (const script of ['jarvis_daemon.js', 'telegram-bot.js']) {
    for (const owner of findMatchingProcesses(path.join(PROJECT_DIR, script))) {
      try { process.kill(owner.pid, 'SIGTERM'); } catch (e) { log(`PID ${owner.pid} stop xatolik: ${e.message}`); }
    }
  }
  try { execSync('openclaw gateway stop', { timeout: 15000 }); } catch (e) {}
  fs.writeFileSync(PAUSE_MARKER, String(Date.now()));
  log('Pauzada. RAM bo\'shatildi.');
}

async function resume() {
  log('Uyg\'otilmoqda...');
  try { fs.unlinkSync(PAUSE_MARKER); } catch (e) {}
  try {
    execSync('launchctl bootstrap gui/' + UID + ' "' + PLIST_PATH + '"', { timeout: 15000 });
    log('launchctl bootstrap yuborildi.');
  } catch (e) {
    log('bootstrap xatolik: ' + e.message);
  }
  log('Uyg\'onish so\'rovi yuborildi; servislar tayyorligi kutilmoqda.');
  const ready = await waitUntilReady(45000);
  speak(ready ? 'Back online.' : 'Coming online. This may take a moment.');
  log(ready ? 'Jarvis servislar tayyor.' : 'Jarvis readiness timeout.');
}

async function toggle() {
  const now = Date.now();
  if (toggleBusy || now - lastComboAt < 1500) return;
  lastComboAt = now;
  toggleBusy = true;
  try {
    if (isRunning()) await pause();
    else await resume();
  } finally {
    toggleBusy = false;
  }
}

// ── Fn-key broker: DOWN/UP hodisalarini jarvis_daemon.js'ga (push-to-talk
// uchun) mahalliy Unix socket orqali uzatadi — shu jarayon fnkey binary'ning
// YAGONA egasi bo'lib qoladi.
let _brokerClients = [];
function broadcastToBroker(line) {
  for (const c of _brokerClients) { try { c.write(line + '\n'); } catch (e) {} }
}
function startBroker() {
  try { fs.unlinkSync(FNKEY_SOCK); } catch (e) {}
  const server = net.createServer((conn) => {
    _brokerClients.push(conn);
    // Daemon eski Fn DOWN holatida qolgan bo'lsa, har reconnectda tozalanadi.
    try { conn.write('RESET\n'); } catch (e) {}
    conn.on('close', () => { _brokerClients = _brokerClients.filter(c => c !== conn); });
    conn.on('error', () => {});
  });
  server.on('error', (e) => log('Fn-key broker xatolik: ' + e.message));
  server.listen(FNKEY_SOCK, () => log('Fn-key broker tayyor: ' + FNKEY_SOCK));
}

let fnProc = null;
let fnRestartTimer = null;
let fnLastEventAt = 0;

function scheduleListenerRestart(delayMs, reason) {
  if (fnRestartTimer) return;
  log('fnkey qayta ishga tushiriladi (' + reason + ', ' + delayMs + 'ms)');
  fnRestartTimer = setTimeout(() => {
    fnRestartTimer = null;
    startListener();
  }, delayMs);
}

function startListener() {
  if (fnProc && fnProc.exitCode === null && !fnProc.killed) return;
  if (!fs.existsSync(FNKEY_BIN)) {
    const source = path.join(PROJECT_DIR, 'skills', 'fn-key', 'fnkey.swift');
    try {
      if (!fs.existsSync(source)) throw new Error('source topilmadi: ' + source);
      log('fnkey binary topilmadi — avtomatik build qilinmoqda...');
      execSync('/usr/bin/xcrun swiftc "' + source + '" -o "' + FNKEY_BIN + '"', { timeout: 120000 });
      fs.chmodSync(FNKEY_BIN, 0o755);
      log('fnkey binary build qilindi.');
    } catch (e) {
      log('fnkey build xatolik — 60s dan keyin qayta uriniladi: ' + e.message);
      scheduleListenerRestart(60000, 'build xatolik');
      return;
    }
  }
  const proc = spawn(FNKEY_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  fnProc = proc;
  fnLastEventAt = Date.now();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      fnLastEventAt = Date.now();
      if (t === 'READY') log('Fn/Fn+Shift tinglovchisi tayyor (pid=' + proc.pid + ')');
      else if (t === 'COMBO') { log('Fn+Shift COMBO qabul qilindi'); toggle(); }
      else if (t.startsWith('ERROR')) log('fnkey xatolik: ' + t);
      if (t === 'DOWN' || t === 'UP') { log('Fn event: ' + t); broadcastToBroker(t); }
    }
  });
  proc.stderr.on('data', (d) => log('fnkey stderr: ' + String(d).trim()));
  proc.on('error', (e) => {
    if (fnProc === proc) fnProc = null;
    log('fnkey spawn xatolik: ' + e.message);
    scheduleListenerRestart(3000, 'spawn xatolik');
  });
  proc.on('exit', (code) => {
    if (fnProc === proc) fnProc = null;
    broadcastToBroker('RESET');
    log('fnkey jarayoni tugadi (code=' + code + ') — 3s dan keyin qayta ishga tushirish');
    scheduleListenerRestart(3000, 'exit code=' + code);
  });
}

log('Pauza sentinel ishga tushdi (Fn+Shift = to\'xtat/uyg\'ot)');
startBroker();
startListener();

// Sentinelning o'zi tirik, child esa jim o'lib qolgan holatni tiklaydi.
setInterval(() => {
  if (!fnProc || fnProc.exitCode !== null || fnProc.killed) {
    broadcastToBroker('RESET');
    scheduleListenerRestart(0, 'watchdog child yo\'q');
  }
}, 5000).unref();

function shutdown() {
  try { if (fnProc) fnProc.kill('SIGTERM'); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
