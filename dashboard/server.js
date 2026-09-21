#!/usr/bin/env node
/**
 * JARVIS DASHBOARD — mahalliy veb-server
 * Faqat 127.0.0.1'da ishlaydi (tashqi tarmoqqa ochiq emas).
 * Statik HUD sahifasini va real holat/vazifa/faoliyat ma'lumotlarini
 * JSON API orqali beradi. Yangi npm paket kerak emas — faqat Node'ning
 * o'zidagi `http` moduli.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROJECT_DIR } = require('../core/paths');
const { findMatchingProcesses } = require('../core/runtime-health');

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 7890;

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const mem = require(path.join(PROJECT_DIR, 'skills', 'memory'));
const tasks = require(path.join(PROJECT_DIR, 'skills', 'tasks'));
const { loadVoiceTelemetry } = require(path.join(PROJECT_DIR, 'core', 'voice-telemetry'));
const { RuntimeTelemetry } = require(path.join(PROJECT_DIR, 'core', 'runtime-telemetry'));
const { createAgentBridge, needsPersistentExecution } = require(path.join(PROJECT_DIR, 'core', 'agent-bridge'));
const { resolveOpenClawEnvironment } = require(path.join(PROJECT_DIR, 'core', 'openclaw-credentials'));
const { createSkillPlatform } = require(path.join(PROJECT_DIR, 'skills', 'platform'));
const runtimeTelemetry = new RuntimeTelemetry({ file: path.join(PROJECT_DIR, '.run', 'telemetry.json') });
const agentBridge = createAgentBridge({
  projectDir: PROJECT_DIR, env, azureOpenAiKey: env('AZURE_OPENAI_KEY'),
  openClawEnvironment: resolveOpenClawEnvironment({ projectDir: PROJECT_DIR }),
  skillPlatform: createSkillPlatform({ projectDir: PROJECT_DIR, env }), runtime: {}, telemetry: runtimeTelemetry
});

// Mahalliy (timezone) sanani beradi — toISOString() UTC qaytaradi, shuning
// uchun UTC+8'da mahalliy soat 08:00gacha dashboard "kechagi kun" faylini
// ko'rsatib qolardi.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ── Yordamchi funksiyalar ───────────────────────────────────────────────
function isAlive(scriptPath) {
  return findMatchingProcesses(scriptPath).length > 0;
}

function gatewayHealthy() {
  try {
    execFileSync('curl', ['-sf', '--max-time', '3', 'http://127.0.0.1:18789/health'], { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

function readJsonSafe(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

// ── /api/status ──────────────────────────────────────────────────────────
function getStatus() {
  const paused = fs.existsSync(path.join(PROJECT_DIR, '.jarvis-paused'));
  const runtime = readJsonSafe(path.join(PROJECT_DIR, '.jarvis-runtime.json'), null);
  return {
    paused,
    gateway: gatewayHealthy(),
    bot: isAlive(PROJECT_DIR + '/telegram-bot.js'),
    daemon: isAlive(PROJECT_DIR + '/jarvis_daemon.js'),
    monitor: isAlive(path.join(PROJECT_DIR, 'skills', 'screen-monitor', 'index.js')),
    sentinel: isAlive(path.join(PROJECT_DIR, 'scripts', 'pause-sentinel.js')),
    runtime,
    model: {
      primary: env('AZURE_OPENAI_DEPLOYMENT', 'gpt-6-astra'),
      realtime: env('AZURE_REALTIME_DEPLOYMENT', 'gpt-realtime-2.1'),
      vision: env('AZURE_OPENAI_VISION_DEPLOYMENT', 'gpt-4.1'),
      expert: env('DEEP_THINK_MODEL', env('AZURE_OPENAI_DEPLOYMENT', 'gpt-6-astra'))
    },
    now: new Date().toISOString()
  };
}

// ── /api/activity — bugungi (va kechagi, agar bo'sh bo'lsa) xotira yozuvlari ──
function parseMemoryFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  const entries = [];
  for (const block of blocks) {
    const m = block.match(/^## (\d{2}:\d{2}) — (.+)$/m);
    if (!m) continue;
    const rest = block.slice(block.indexOf('\n') + 1).replace(/\*\*Teglar:\*\*.*$/ms, '').trim();
    entries.push({ time: m[1], topic: m[2], content: rest.slice(0, 400) });
  }
  return entries.reverse(); // eng yangisi birinchi
}

function getActivity(limit) {
  const today = localDateStr();
  let entries = parseMemoryFile(path.join(mem.MEMORY_DIR, today + '.md'));
  if (!entries.length) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    entries = parseMemoryFile(path.join(mem.MEMORY_DIR, localDateStr(y) + '.md'));
  }
  return entries.slice(0, limit || 30);
}

// ── /api/tasks — kunlik vazifalar + bugun bajarilganlari ──────────────────
function getTasks() {
  const list = tasks.listTasks().tasks;
  const state = readJsonSafe(path.join(PROJECT_DIR, '.daily-tasks-state.json'), { completed: [] });
  return list.map(t => ({ text: t.text, doneToday: (state.completed || []).includes(t.text) }));
}

// ── /api/realtime-tasks — jonli suhbat paytida parallel bajarilayotgan/
// bajarilgan vazifalar (multi-tasking holati) ──────────────────────────────
function getRealtimeTasks() {
  const s = readJsonSafe(path.join(PROJECT_DIR, '.realtime-tasks-state.json'), []);
  return Array.isArray(s) ? s.slice().reverse() : [];
}

function getAgentTasks() {
  return agentBridge.checkpoints.list().map(task => ({
    id: task.id, request: String(task.request || '').slice(0, 500), status: task.status,
    persistent: Boolean(task.persistent), createdAt: task.createdAt, updatedAt: task.updatedAt,
    retryCount: task.retryCount || 0, nextRetryAt: task.nextRetryAt || null,
    steps: (task.steps || []).map(step => ({ index: step.index, status: step.status, executionId: step.executionId || null, startedAt: step.startedAt || null, recoveryCount: step.recoveryCount || 0 }))
  }));
}

// Avtonom missiyalar (core/mission-runner.js): ovozli daemon va runner umumiy `.run/missions` papkasidan o'qiydi.
function getMissions() {
  const { MissionStore } = require('../core/missions/store');
  const store = new MissionStore({ dir: path.join(PROJECT_DIR, '.run', 'missions') });
  const runner = readJsonSafe(path.join(PROJECT_DIR, '.run', 'missions', 'runner.json'), null);
  return {
    runnerAlive: Boolean(runner && Date.now() - runner.at < 15000),
    missions: store.list().slice(-12).reverse().map(m => ({
      n: m.n, goal: m.goal.slice(0, 200), status: m.status, iteration: m.iteration,
      tasks: m.tasks.map(t => ({ id: t.id, title: t.title, worker: t.worker, status: t.status })),
      summary: m.summary, pendingApproval: m.pendingApproval, result: m.result ? String(m.result).slice(0, 300) : null,
      createdAt: m.createdAt, updatedAt: m.updatedAt, completedAt: m.completedAt
    }))
  };
}

function getVoiceTelemetry() {
  return loadVoiceTelemetry(path.join(PROJECT_DIR, '.run', 'voice-flight-recorder.jsonl'), { maxLines: 3000 });
}

function getRuntimeTelemetry() { return runtimeTelemetry.snapshot(); }

// ── /api/profile — so'nggi o'rganilgan naqshlar ────────────────────────────
function getProfile() {
  const pr = mem.readProfile();
  if (pr.status !== 'ok') return [];
  const sections = pr.content.split(/^## /m).slice(1);
  return sections
    .filter(s => s.startsWith('O\'rganilgan naqshlar'))
    .slice(-5)
    .reverse()
    .map(s => {
      const lines = s.split('\n');
      return { title: lines[0].trim(), body: lines.slice(1).join('\n').trim().slice(0, 600) };
    });
}

// ── /api/chat — dashboard'dan to'g'ridan-to'g'ri Jarvisga yozish ──────────
function askAgent(message) {
  return agentBridge.askAgent(message, 'agent:main:dashboard', {
    source: 'dashboard-chat',
    persistent: needsPersistentExecution(message),
    onProgress: () => {}
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch (e) { payload = {}; }
  const message = (payload.message || '').trim();
  if (!message) { return json(res, { error: 'A message is required.' }, 400); }

  const reply = await askAgent(message);
  if (reply) {
    try { mem.writeMemory('Dashboard chat', 'Foydalanuvchi: ' + message + '\nJarvis: ' + reply.slice(0, 500), ['dashboard', 'chat']); } catch (e) {}
  }
  json(res, { reply: reply || 'I could not respond right now.' });
}

// ── HTTP server ─────────────────────────────────────────────────────────
const STATIC_DIR = path.join(PROJECT_DIR, 'dashboard');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(req, res).catch(e => json(res, { error: e.message }, 500));
  }

  try {
    if (url.pathname === '/api/status') return json(res, getStatus());
    if (url.pathname === '/api/activity') return json(res, getActivity(parseInt(url.searchParams.get('limit'), 10)));
    if (url.pathname === '/api/tasks') return json(res, getTasks());
    if (url.pathname === '/api/realtime-tasks') return json(res, getRealtimeTasks());
    if (url.pathname === '/api/agent-tasks') return json(res, getAgentTasks());
    if (url.pathname === '/api/missions') return json(res, getMissions());
    if (url.pathname === '/api/runtime') return json(res, readJsonSafe(path.join(PROJECT_DIR, '.jarvis-runtime.json'), {}));
    if (url.pathname === '/api/voice-telemetry') return json(res, getVoiceTelemetry());
    if (url.pathname === '/api/telemetry') return json(res, getRuntimeTelemetry());
    if (url.pathname === '/api/profile') return json(res, getProfile());
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  // Statik fayllar (faqat dashboard papkasi ichida)
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(STATIC_DIR, filePath);
  if (!full.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

function json(res, obj, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('Jarvis Dashboard: http://localhost:' + PORT);
});
