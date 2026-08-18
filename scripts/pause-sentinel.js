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

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const FNKEY_BIN = path.join(PROJECT_DIR, 'skills', 'fn-key', 'fnkey');
const PAUSE_MARKER = path.join(PROJECT_DIR, '.jarvis-paused');
const JARVIS_SH = path.join(PROJECT_DIR, 'scripts', 'jarvis.sh');
const FNKEY_SOCK = path.join(PROJECT_DIR, '.run', 'fnkey.sock');

let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) {}
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

function log(m) { console.log('[' + new Date().toISOString() + '] ' + m); }

function isRunning() {
  try {
    execSync('pgrep -f "node ' + PROJECT_DIR + '/jarvis_daemon.js"', { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

function speak(text) {
  try {
    const tmpIn = '/tmp/pause_tts_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ text }), 'utf8');
    const out = execSync('node "' + path.join(PROJECT_DIR, 'skills', 'azure-tts', 'index.js') + '" < "' + tmpIn + '"', {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'), AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'uz-UZ-SardorNeural' },
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

function pause() {
  log('Pauza qilinmoqda...');
  speak('Jarvis to\'xtadi');
  try { execSync('launchctl bootout gui/' + UID + '/' + PLIST_LABEL, { timeout: 15000 }); } catch (e) { log('bootout (davom etamiz): ' + e.message); }
  // Ehtiyot uchun — bootout yetarli bo'lmasa ham hammasi to'xtaganini kafolatlash
  try { execSync(JARVIS_SH + ' stop', { cwd: PROJECT_DIR, timeout: 15000 }); } catch (e) {}
  try { execSync('openclaw gateway stop', { timeout: 15000 }); } catch (e) {}
  fs.writeFileSync(PAUSE_MARKER, String(Date.now()));
  log('Pauzada. RAM bo\'shatildi.');
}

function resume() {
  log('Uyg\'otilmoqda...');
  try { fs.unlinkSync(PAUSE_MARKER); } catch (e) {}
  try {
    execSync('launchctl bootstrap gui/' + UID + ' "' + PLIST_PATH + '"', { timeout: 15000 });
    log('launchctl bootstrap yuborildi.');
  } catch (e) {
    log('bootstrap xatolik: ' + e.message);
  }
  setTimeout(() => speak('Jarvis uyg\'ondi'), 8000);
  log('Uyg\'onish so\'rovi yuborildi.');
}

function toggle() {
  if (isRunning()) pause();
  else resume();
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
    conn.on('close', () => { _brokerClients = _brokerClients.filter(c => c !== conn); });
    conn.on('error', () => {});
  });
  server.on('error', (e) => log('Fn-key broker xatolik: ' + e.message));
  server.listen(FNKEY_SOCK, () => log('Fn-key broker tayyor: ' + FNKEY_SOCK));
}

function startListener() {
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
      setTimeout(startListener, 60000);
      return;
    }
  }
  const proc = spawn(FNKEY_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t === 'READY') log('Fn+Shift pauza tinglovchisi tayyor');
      else if (t === 'COMBO') toggle();
      else if (t.startsWith('ERROR')) log('fnkey xatolik: ' + t);
      if (t === 'DOWN' || t === 'UP') broadcastToBroker(t);
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', (code) => {
    log('fnkey jarayoni tugadi (code=' + code + ') — 3s dan keyin qayta ishga tushirish');
    setTimeout(startListener, 3000);
  });
}

log('Pauza sentinel ishga tushdi (Fn+Shift = to\'xtat/uyg\'ot)');
startBroker();
startListener();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
