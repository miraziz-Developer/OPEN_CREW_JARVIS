'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACTIVE = new Set(['planning', 'running']);
const OPEN = new Set(['planning', 'running', 'paused', 'awaiting_approval']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Doimiy missiya saqlagichi. Ovozli daemon (yaratadi/boshqaradi) va missiya runner (bajaradi) alohida jarayonlar:
 *  - har missiya bitta JSON fayl (atomik yoziladi);
 *  - boshqaruv buyruqlari (pauza/bekor/tasdiq) `inbox/` orqali — poyga yo'q, runner o'zi qo'llaydi;
 *  - hodisalar `events.jsonl` ga qo'shiladi, daemon uni kuzatib ovozli xabar beradi.
 */
class MissionStore {
  constructor(options = {}) {
    this.dir = options.dir;
    this.now = options.now || Date.now;
    this.missionsDir = path.join(this.dir, 'missions');
    this.inboxDir = path.join(this.dir, 'inbox');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    fs.mkdirSync(this.missionsDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  _file(id) { return path.join(this.missionsDir, `${id}.json`); }

  list(filter = {}) {
    let names = [];
    try { names = fs.readdirSync(this.missionsDir).filter(name => name.endsWith('.json')); } catch (_) {}
    const missions = [];
    for (const name of names) {
      try { missions.push(JSON.parse(fs.readFileSync(path.join(this.missionsDir, name), 'utf8'))); } catch (_) {}
    }
    missions.sort((a, b) => a.n - b.n);
    if (filter.open) return missions.filter(m => OPEN.has(m.status));
    if (filter.active) return missions.filter(m => ACTIVE.has(m.status));
    return missions;
  }

  get(idOrNumber) {
    const key = String(idOrNumber ?? '').trim().replace(/^mission\s*/i, '');
    if (!key) return null;
    const all = this.list();
    return all.find(m => m.id === key) || all.find(m => String(m.n) === key) || null;
  }

  create(goal, options = {}) {
    const text = String(goal || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Missiya maqsadi kerak');
    const all = this.list();
    const now = this.now();
    const hours = Number.isFinite(options.maxHours) ? options.maxHours : 72;
    const mission = {
      id: `m-${now.toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      n: (all.reduce((max, m) => Math.max(max, m.n || 0), 0)) + 1,
      goal: text.slice(0, 2000), source: options.source || 'voice', status: 'planning',
      criteria: [], tasks: [], log: [], iteration: 0, consecutiveFailures: 0, summary: '',
      pendingApproval: null, result: null, notes: [],
      budget: {
        maxIterations: options.maxIterations || 300,
        maxHours: hours,
        taskTimeoutMs: options.taskTimeoutMs || 20 * 60 * 1000,
        maxConsecutiveFailures: options.maxConsecutiveFailures || 4,
        maxTaskAttempts: options.maxTaskAttempts || 3
      },
      createdAt: now, updatedAt: now, completedAt: null
    };
    this.save(mission);
    this.appendEvent({ kind: 'mission.created', missionId: mission.id, n: mission.n, text: `Mission ${mission.n} started: ${mission.goal.slice(0, 140)}` });
    return mission;
  }

  save(mission) {
    mission.updatedAt = this.now();
    atomicWriteJson(this._file(mission.id), mission);
    return mission;
  }

  enqueue(idOrNumber, action, payload = {}) {
    const mission = this.get(idOrNumber);
    if (!mission) throw new Error(`Missiya topilmadi: ${idOrNumber}`);
    const file = path.join(this.inboxDir, `${this.now()}-${crypto.randomBytes(2).toString('hex')}-${mission.id}.json`);
    atomicWriteJson(file, { id: mission.id, action, payload, at: this.now() });
    return mission;
  }

  drainInbox() {
    let names = [];
    try { names = fs.readdirSync(this.inboxDir).filter(name => name.endsWith('.json')).sort(); } catch (_) {}
    const commands = [];
    for (const name of names) {
      const file = path.join(this.inboxDir, name);
      try { commands.push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) {}
      try { fs.rmSync(file, { force: true }); } catch (_) {}
    }
    return commands;
  }

  appendEvent(event) {
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true });
    fs.appendFileSync(this.eventsFile, JSON.stringify({ at: this.now(), ...event }) + '\n', { mode: 0o600 });
  }

  eventsOffset() {
    try { return fs.statSync(this.eventsFile).size; } catch (_) { return 0; }
  }

  readEventsSince(offset = 0) {
    let size = 0;
    try { size = fs.statSync(this.eventsFile).size; } catch (_) { return { events: [], offset: 0 }; }
    if (size < offset) offset = 0;
    if (size === offset) return { events: [], offset };
    const fd = fs.openSync(this.eventsFile, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      const events = buffer.toString('utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
      return { events, offset: size };
    } finally { fs.closeSync(fd); }
  }

  // Ovoz uchun qisqa holat matni.
  describe(mission) {
    const done = mission.tasks.filter(t => t.status === 'done').length;
    const total = mission.tasks.length;
    const active = mission.tasks.find(t => t.status === 'running') || mission.tasks.find(t => t.status === 'pending');
    const parts = [`Mission ${mission.n} (${mission.status.replace('_', ' ')}): ${mission.goal.slice(0, 120)}`];
    if (total) parts.push(`${done} of ${total} tasks done`);
    if (mission.status === 'awaiting_approval' && mission.pendingApproval) parts.push(`waiting for approval: ${mission.pendingApproval.reason}`);
    else if (active && !TERMINAL.has(mission.status)) parts.push(`now: ${active.title}`);
    if (mission.summary) parts.push(mission.summary.slice(0, 160));
    if (mission.status === 'completed' && mission.result) parts.push(`result: ${String(mission.result).slice(0, 200)}`);
    return parts.join('. ');
  }
}

module.exports = { MissionStore, ACTIVE, OPEN, TERMINAL };
