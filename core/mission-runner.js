#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { PROJECT_DIR } = require('./paths');
const llm = require('./llm');
const { MissionStore } = require('./missions/store');
const { GoalEngine } = require('./missions/engine');
const { createWorkers } = require('./workers');

const NOTIFY_KINDS = new Set(['mission.completed', 'mission.blocked', 'mission.failed', 'mission.needs_approval', 'usage.alert']);
const MEMORY_KINDS = new Set(['mission.completed', 'mission.blocked', 'mission.failed']);

function telegramNotifier(env) {
  const { parseOwnerIds } = require('./telegram-owner');
  const post = (token, chatId, text) => new Promise(resolve => {
    const payload = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500) });
    const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(payload); req.end();
  });
  const briefer = new (require('./telegram-brief').TelegramBrief)({ llm: require('./llm') });
  return async text => {
    text = await briefer.prepare(text);
    if (!text) return false;
    // .env ni har safar yangidan o'qiymiz: egalar o'zgarganda qayta ishga tushirish shart emas.
    let fresh = {};
    try { fresh = require('./config').parseEnv(fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8')); } catch (_) {}
    const token = (fresh.TELEGRAM_BOT_TOKEN) || env('TELEGRAM_BOT_TOKEN');
    const owners = parseOwnerIds(fresh.TELEGRAM_CHAT_ID || env('TELEGRAM_CHAT_ID'), fresh.TELEGRAM_OWNER_IDS || env('TELEGRAM_OWNER_IDS'));
    if (!token || !owners.length) return false;
    const results = await Promise.all(owners.map(owner => post(token, owner, text)));
    return results.some(Boolean);
  };
}

/**
 * Missiya runner: doimiy jarayon. Ovozli daemon'dan mustaqil — uzoq (soatlab/kunlab) missiyalar ovoz suhbatiga
 * hech qachon xalaqit bermaydi. Har tickda: inbox buyruqlari → faol missiyalarning keyingi iteratsiyasi (parallel).
 */
function createRunner(options = {}) {
  const store = options.store;
  const engine = options.engine;
  const concurrency = options.concurrency || 2;
  const notify = options.notify || (async () => false);
  const remember = options.remember || (() => {});
  const usage = options.usage || null;
  const tokenBudget = options.tokenBudget || 0;            // kunlik LLM token chegarasi (0 — cheksiz)
  const voiceMinutesAlert = options.voiceMinutesAlert || 0; // kunlik ovoz daqiqalari ogohlantirishi
  const spawnFn = options.spawn || require('child_process').spawn;
  let awake = null;
  const live = new Map();            // missionId -> in-memory mission (buyruqlar shu obyektga qo'llanadi)
  const log = options.log || (() => {});
  let eventOffset = store.eventsOffset();
  let stopped = false;

  function recover() {
    let recovered = 0;
    for (const mission of store.list({ open: true })) {
      let changed = false;
      for (const task of mission.tasks) if (task.status === 'running') { task.status = 'pending'; task.attempts = Math.max(0, task.attempts - 1); changed = true; }
      if (changed) { store.save(mission); recovered += 1; }
    }
    return recovered;
  }

  async function forwardEvents() {
    const { events, offset } = store.readEventsSince(eventOffset);
    eventOffset = offset;
    for (const event of events) {
      if (MEMORY_KINDS.has(event.kind)) { try { remember(event); } catch (_) {} }   // Obsidian xotira: JARVIS keyin eslay oladi
      if (NOTIFY_KINDS.has(event.kind)) { try { await notify(event.text); } catch (_) {} }
    }
  }

  function applyInbox() {
    for (const command of store.drainInbox()) {
      const mission = live.get(command.id) || store.get(command.id);
      if (!mission) continue;
      engine.applyCommand(mission, command);
      if (!live.has(mission.id)) store.save(mission);
    }
  }

  // Missiya ishlayotganda Mac uyquga ketmasin (soatlab/kunlab ishlaydigan vazifalar uchun). Runner tugasa `caffeinate` ham tugaydi.
  function ensureAwake(need) {
    if (need && !awake) {
      try {
        awake = spawnFn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        awake.on?.('exit', () => { awake = null; });
        awake.on?.('error', () => { awake = null; });
        awake.unref?.();
      } catch (_) { awake = null; }
    } else if (!need && awake) {
      try { awake.kill('SIGTERM'); } catch (_) {}
      awake = null;
    }
  }

  async function checkUsage() {
    if (!usage) return { overBudget: false };
    const totals = usage.totals();
    if (voiceMinutesAlert && (totals.voice_seconds || 0) / 60 >= voiceMinutesAlert && usage.once('voice-alert')) {
      try { await notify(`Voice listening used ${Math.round((totals.voice_seconds || 0) / 60)} minutes of cloud audio today (alert at ${voiceMinutesAlert}).`); } catch (_) {}
    }
    // Byudjet oshsa missiyalar TO'XTAMAYDI — faqat bir marta xabar beriladi (kuniga bir marta, keyin har +50% da).
    let freshLevel = false;
    for (const step of [1, 1.5, 2, 3]) {
      if (tokenBudget && (totals.llm_tokens || 0) >= tokenBudget * step && usage.once(`token-budget-${step}`)) freshLevel = true;
    }
    if (freshLevel) {
      store.appendEvent({ kind: 'usage.alert', missionId: null, n: 0,
        text: `Heads up: missions used ${Math.round((totals.llm_tokens || 0) / 1000)}k tokens today (limit ${Math.round(tokenBudget / 1000)}k). They keep running.` });
    }
    return { overBudget: false };
  }

  function heartbeat() {
    try { fs.writeFileSync(path.join(store.dir, 'runner.json'), JSON.stringify({ pid: process.pid, at: Date.now(), running: [...live.keys()] })); } catch (_) {}
  }

  async function tick() {
    applyInbox();
    const { overBudget } = await checkUsage();
    const active = store.list({ active: true });
    ensureAwake(active.length > 0 || live.size > 0);
    for (const mission of active) {
      if (overBudget) break;
      if (live.has(mission.id) || live.size >= concurrency) continue;
      live.set(mission.id, mission);
      engine.step(mission)
        .catch(error => {
          log(`step xatosi (${mission.id}): ${error.message}`);
          mission.consecutiveFailures = (mission.consecutiveFailures || 0) + 1;
          try { store.save(mission); } catch (_) {}
        })
        .finally(() => live.delete(mission.id));
    }
    await forwardEvents();
    heartbeat();
  }

  async function run(pollMs = 2000) {
    recover();
    while (!stopped) {
      try { await tick(); } catch (error) { log('tick xatosi: ' + error.message); }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  return { tick, run, recover, stop() { stopped = true; ensureAwake(false); }, live, isAwake: () => Boolean(awake) };
}

function main() {
  const dir = path.join(PROJECT_DIR, '.run', 'missions');
  const store = new MissionStore({ dir });
  const { StandingApprovals } = require('./missions/standing');
  const engine = new GoalEngine({ store, llm, workers: createWorkers(), routineAutonomy: llm.env('MISSION_AUTONOMY', 'routine') !== 'strict',
    standing: new StandingApprovals({ file: path.join(dir, 'standing-approvals.json') }) });
  const runner = createRunner({
    store, engine, concurrency: Math.max(1, parseInt(llm.env('MISSION_CONCURRENCY'), 10) || 2),
    notify: telegramNotifier(llm.env),
    usage: require('./usage-meter').sharedMeter(),
    tokenBudget: parseInt(llm.env('MISSION_DAILY_TOKEN_BUDGET'), 10) || 3000000,
    voiceMinutesAlert: parseInt(llm.env('DAILY_VOICE_MINUTES_ALERT'), 10) || 240,
    remember: event => require('../skills/memory').writeMemory(`Mission ${event.n}`, event.text, ['mission', event.kind.replace('mission.', '')]),
    log: message => console.log(`[${new Date().toISOString()}] ${message}`)
  });
  console.log(`[${new Date().toISOString()}] mission-runner ishga tushdi (pid ${process.pid})`);
  process.on('SIGTERM', () => { runner.stop(); setTimeout(() => process.exit(0), 300); });
  runner.run().catch(error => { console.error(error); process.exit(1); });
}

if (require.main === module) main();

module.exports = { createRunner, telegramNotifier };
