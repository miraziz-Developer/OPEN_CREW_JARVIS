#!/usr/bin/env node
/**
 * PAUSE SENTINEL: fully pause/wake JARVIS with Fn+Shift.
 * Runs INDEPENDENTLY of jarvis_daemon.js (its own LaunchAgent), so this listener
 * keeps running while JARVIS is paused and can wait for the "wake" gesture. It is
 * very light (it only listens to the fnkey binary) and uses almost no RAM.
 *
 * IMPORTANT: ONLY this process spawns the fnkey binary (a single CGEventTap).
 * jarvis_daemon.js used to start its own fnkey copy (for push-to-talk); two
 * processes watching the same physical key sometimes interfered (e.g. when the
 * daemon restarted) and produced false COMBO signals (JARVIS pausing itself). Fn
 * DOWN/UP events are therefore forwarded to jarvis_daemon.js over a local Unix
 * socket (a broker): one hardware hook, two consumers.
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

// When launchd redirects stdout to a file, console.log sometimes flushes late. Important
// lines are also written to the file synchronously so diagnostics show up in real time.
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
  } catch (e) { log('TTS error: ' + e.message); }
}

// IMPORTANT: com.jarvis.openclaw runs under launchd with KeepAlive=true, so killing
// its process with kill/pkill is NOT ENOUGH: launchd restarts it immediately. To stop
// it properly, remove it from launchd (`launchctl bootout`); to start it again, use
// `launchctl bootstrap`.
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const PLIST_LABEL = 'com.jarvis.openclaw';
const PLIST_PATH = path.join(require('os').homedir(), 'Library', 'LaunchAgents', PLIST_LABEL + '.plist');
// Local "brain" services (if installed) stop during pause too, so RAM is fully freed.
const BRAIN_LABELS = ['com.jarvis.brain', 'com.jarvis.ollama'];
const agentPlist = label => path.join(require('os').homedir(), 'Library', 'LaunchAgents', label + '.plist');

let toggleBusy = false;
let lastComboAt = 0;

async function pause() {
  log('Pausing...');
  speak('Standing down.');
  try { execSync('launchctl bootout gui/' + UID + '/' + PLIST_LABEL, { timeout: 15000 }); } catch (e) { log('bootout (continuing): ' + e.message); }
  // To be safe, the supervisor script is not sent "stop": it does not understand the
  // argument and might even restart the daemon. Processes are stopped directly; the
  // pause marker keeps the supervisor from starting them again.
  for (const script of ['jarvis_daemon.js', 'telegram-bot.js']) {
    for (const owner of findMatchingProcesses(path.join(PROJECT_DIR, script))) {
      try { process.kill(owner.pid, 'SIGTERM'); } catch (e) { log(`PID ${owner.pid} stop error: ${e.message}`); }
    }
  }
  try { execSync('openclaw gateway stop', { timeout: 15000 }); } catch (e) {}
  // Brain first (it shuts down the Bonsai process itself), then Ollama (with its loaded models).
  for (const label of BRAIN_LABELS) {
    if (!fs.existsSync(agentPlist(label))) continue;
    try { execSync('launchctl bootout gui/' + UID + '/' + label, { timeout: 15000 }); } catch (e) {}
  }
  fs.writeFileSync(PAUSE_MARKER, String(Date.now()));
  log('Pauzada. RAM bo\'shatildi.');
}

async function resume() {
  log('Uyg\'otilmoqda...');
  try { fs.unlinkSync(PAUSE_MARKER); } catch (e) {}
  for (const label of BRAIN_LABELS.slice().reverse()) {
    if (!fs.existsSync(agentPlist(label))) continue;
    try { execSync('launchctl bootstrap gui/' + UID + ' "' + agentPlist(label) + '"', { timeout: 15000 }); } catch (e) {}
  }
  try {
    execSync('launchctl bootstrap gui/' + UID + ' "' + PLIST_PATH + '"', { timeout: 15000 });
    log('launchctl bootstrap sent.');
  } catch (e) {
    log('bootstrap error: ' + e.message);
  }
  log('Wake request sent; waiting for services to become ready.');
  const ready = await waitUntilReady(45000);
  speak(ready ? 'Back online.' : 'Coming online. This may take a moment.');
  log(ready ? 'Jarvis services ready.' : 'Jarvis readiness timeout.');
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

// ── Fn-key broker: forwards DOWN/UP events to jarvis_daemon.js (for push-to-talk)
// over a local Unix socket, so this process remains the ONLY owner of the fnkey
// binary.
let _brokerClients = [];
function broadcastToBroker(line) {
  for (const c of _brokerClients) { try { c.write(line + '\n'); } catch (e) {} }
}
function startBroker() {
  try { fs.unlinkSync(FNKEY_SOCK); } catch (e) {}
  const server = net.createServer((conn) => {
    _brokerClients.push(conn);
    // If the daemon was left in a stale Fn DOWN state, it is cleared on every reconnect.
    try { conn.write('RESET\n'); } catch (e) {}
    conn.on('close', () => { _brokerClients = _brokerClients.filter(c => c !== conn); });
    conn.on('error', () => {});
  });
  server.on('error', (e) => log('Fn-key broker error: ' + e.message));
  server.listen(FNKEY_SOCK, () => log('Fn-key broker ready: ' + FNKEY_SOCK));
}

let fnProc = null;
let fnRestartTimer = null;
let fnLastEventAt = 0;

function scheduleListenerRestart(delayMs, reason) {
  if (fnRestartTimer) return;
  log('Restarting fnkey (' + reason + ', ' + delayMs + 'ms)');
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
      if (!fs.existsSync(source)) throw new Error('source not found: ' + source);
      log('fnkey binary not found; building it automatically...');
      execSync('/usr/bin/xcrun swiftc "' + source + '" -o "' + FNKEY_BIN + '"', { timeout: 120000 });
      fs.chmodSync(FNKEY_BIN, 0o755);
      log('fnkey binary built.');
    } catch (e) {
      log('fnkey build error; retrying in 60 s: ' + e.message);
      scheduleListenerRestart(60000, 'build error');
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
      if (t === 'READY') log('Fn/Fn+Shift listener ready (pid=' + proc.pid + ')');
      else if (t === 'COMBO') { log('Fn+Shift COMBO received'); toggle(); }
      else if (t.startsWith('ERROR')) log('fnkey error: ' + t);
      if (t === 'DOWN' || t === 'UP') { log('Fn event: ' + t); broadcastToBroker(t); }
    }
  });
  proc.stderr.on('data', (d) => log('fnkey stderr: ' + String(d).trim()));
  proc.on('error', (e) => {
    if (fnProc === proc) fnProc = null;
    log('fnkey spawn error: ' + e.message);
    scheduleListenerRestart(3000, 'spawn error');
  });
  proc.on('exit', (code) => {
    if (fnProc === proc) fnProc = null;
    broadcastToBroker('RESET');
    log('fnkey process exited (code=' + code + '); restarting in 3 s');
    scheduleListenerRestart(3000, 'exit code=' + code);
  });
}

log('Pause sentinel started (Fn+Shift = pause/wake)');
startBroker();
startListener();

// Recovers the case where the sentinel itself is alive but its child died silently.
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
