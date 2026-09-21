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

const NOTIFY_KINDS = new Set(['mission.completed', 'mission.blocked', 'mission.failed', 'mission.needs_approval']);
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
  return async text => {
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

  function heartbeat() {
    try { fs.writeFileSync(path.join(store.dir, 'runner.json'), JSON.stringify({ pid: process.pid, at: Date.now(), running: [...live.keys()] })); } catch (_) {}
  }

  async function tick() {
    applyInbox();
    for (const mission of store.list({ active: true })) {
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

  return { tick, run, recover, stop() { stopped = true; }, live };
}

function main() {
  const dir = path.join(PROJECT_DIR, '.run', 'missions');
  const store = new MissionStore({ dir });
  const engine = new GoalEngine({ store, llm, workers: createWorkers(), routineAutonomy: llm.env('MISSION_AUTONOMY', 'routine') !== 'strict' });
  const runner = createRunner({
    store, engine, concurrency: Math.max(1, parseInt(llm.env('MISSION_CONCURRENCY'), 10) || 2),
    notify: telegramNotifier(llm.env),
    remember: event => require('../skills/memory').writeMemory(`Mission ${event.n}`, event.text, ['mission', event.kind.replace('mission.', '')]),
    log: message => console.log(`[${new Date().toISOString()}] ${message}`)
  });
  console.log(`[${new Date().toISOString()}] mission-runner ishga tushdi (pid ${process.pid})`);
  process.on('SIGTERM', () => { runner.stop(); setTimeout(() => process.exit(0), 300); });
  runner.run().catch(error => { console.error(error); process.exit(1); });
}

if (require.main === module) main();

module.exports = { createRunner, telegramNotifier };
