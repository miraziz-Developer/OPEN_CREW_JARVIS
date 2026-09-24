#!/usr/bin/env node
'use strict';

/**
 * Server (Docker) rejimidagi jarayon boshqaruvchisi. Mikrofon/ekran/telefon kerak bo'lmagan
 * qismlarni ishga tushiradi va o'lib qolsa qayta ko'taradi:
 *   gateway (OpenClaw)  →  telegram-bot  ·  mission-runner  ·  dashboard  ·  jobs
 * Hech qanday tashqi bog'liqlik yo'q (faqat Node).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const env = { ...process.env, JARVIS_PROJECT_DIR: ROOT, OPENCLAW_CONFIG_PATH: path.join(ROOT, 'openclaw.json'), DASHBOARD_HOST: process.env.DASHBOARD_HOST || '0.0.0.0', FORCE_COLOR: '0' };

// .env dagi qiymatlarni ham jarayon muhitiga qo'shamiz (gateway va agent CLI uchun kerak).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[2].trim() && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// Doimiy holat: kod loyiha ildizida ko'p holat fayllarini yozadi. Docker'da ular /data volume'ga
// ko'chiriladi (symlink) — konteyner qayta qurilsa ham xotira, tokenlar va missiyalar saqlanadi.
const DATA = process.env.JARVIS_DATA_DIR || '/data';
const STATE_DIRS = ['.run', 'logs', 'vault'];
const STATE_FILES = ['.google-tokens.json', '.jarvis-memory-os.json', '.jarvis-world-model.json', '.jarvis-runtime.json', '.morning-brief-state.json', '.daily-report-state.json', '.daily-tasks-state.json', '.synthesis-state.json', '.realtime-tasks-state.json', '.fast-actions-learned.json', '.memory-embeddings.json'];
if (fs.existsSync(DATA)) {
  for (const d of STATE_DIRS) {
    try {
      fs.mkdirSync(path.join(DATA, d), { recursive: true });
      const link = path.join(ROOT, d);
      if (d !== 'vault' && !fs.existsSync(link)) fs.symlinkSync(path.join(DATA, d), link);
    } catch (_) {}
  }
  for (const f of STATE_FILES) {
    try { const link = path.join(ROOT, f); if (!fs.existsSync(link) && !fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(path.join(DATA, f), link); } catch (_) {}
  }
  env.OBSIDIAN_VAULT = env.OBSIDIAN_VAULT || path.join(DATA, 'vault');
}

// openclaw agent skill/core kodni ~/.openclaw/workspace dan o'qiydi — har ishga tushishda yangilaymiz.
try { execFileSync('bash', [path.join(ROOT, 'scripts', 'sync-workspace.sh')], { env, stdio: 'ignore', timeout: 30000 }); log('supervisor', 'workspace sinxronlandi'); }
catch (e) { log('supervisor', 'workspace sinxronlanmadi: ' + e.message); }

const has = k => Boolean(env[k] && String(env[k]).trim());
const SERVICES = [
  { name: 'gateway', cmd: 'openclaw', args: ['gateway', 'run', '--port', '18789', '--bind', 'loopback'], required: true },
  { name: 'runner', cmd: 'node', args: ['core/mission-runner.js'], after: 'gateway' },
  { name: 'bot', cmd: 'node', args: ['telegram-bot.js'], after: 'gateway', enabled: () => has('TELEGRAM_BOT_TOKEN') },
  { name: 'dashboard', cmd: 'node', args: ['dashboard/server.js'], after: 'gateway' },
  { name: 'jobs', cmd: 'node', args: ['server/jobs.js'], after: 'gateway', enabled: () => has('TELEGRAM_BOT_TOKEN') }
];

let stopping = false;
const children = new Map();

function healthy(port, pathName) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 2000 }, res => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 1500)); } return false; }

function start(svc, attempt = 0) {
  if (stopping) return;
  const child = spawn(svc.cmd, svc.args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(svc.name, child);
  const pipe = stream => stream.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log(svc.name, l)));
  pipe(child.stdout); pipe(child.stderr);
  const started = Date.now();
  child.on('exit', (code, signal) => {
    children.delete(svc.name);
    if (stopping) return;
    // Barqaror ishlagan bo'lsa urinishlar hisobi nolga qaytadi; tez-tez o'lsa kutish oshadi (2s → 60s).
    const next = Date.now() - started > 60000 ? 0 : attempt + 1;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(next, 5));
    log('supervisor', `${svc.name} to'xtadi (code=${code} signal=${signal}) — ${Math.round(delay / 1000)}s dan keyin qayta`);
    setTimeout(() => start(svc, next), delay);
  });
  log('supervisor', `${svc.name} ishga tushdi (pid ${child.pid})`);
}

async function main() {
  const gateway = SERVICES[0];
  start(gateway);
  const up = await waitFor(() => healthy(18789, '/health'), 90000);
  log('supervisor', up ? 'gateway tayyor' : 'gateway 90s ichida javob bermadi — qolganlarni baribir ishga tushiraman');
  for (const svc of SERVICES.slice(1)) {
    if (svc.enabled && !svc.enabled()) { log('supervisor', `${svc.name} o'tkazib yuborildi (sozlanmagan)`); continue; }
    start(svc);
  }
}

function shutdown() {
  if (stopping) return; stopping = true;
  log('supervisor', "to'xtatilmoqda…");
  for (const child of children.values()) { try { child.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

main().catch(e => { log('supervisor', 'xato: ' + e.message); process.exit(1); });
