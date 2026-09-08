'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { redactSensitive } = require('./memory-os');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function clean(value, max = 8000) {
  return redactSensitive(String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)).text;
}

class TurnJournal extends EventEmitter {
  constructor(options = {}) {
    super();
    this.file = options.file;
    this.now = options.now || Date.now;
    this.materialize = options.materialize || (() => {});
    this.retryMs = options.retryMs || 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxBytes = options.maxBytes || 8 * 1024 * 1024;
    this.retentionFiles = options.retentionFiles || 5;
    this.turns = new Map();
    this.pending = new Map();
    this.watchdogTimer = null;
    this._load();
  }

  createTurn(source = 'voice') {
    return `${source}-${this.now()}-${crypto.randomBytes(5).toString('hex')}`;
  }

  append(turnId, type, data = {}) {
    if (!turnId || !type) throw new Error('turnId va type kerak');
    const at = this.now();
    const safeData = this._sanitize(data);
    const event = { version: 1, turnId: clean(turnId, 300), type: clean(type, 80), at, data: safeData };
    this._appendDurably(event);
    const turn = this._reduce(event);
    this._materialize(turn, 0);
    return JSON.parse(JSON.stringify(turn));
  }

  get(turnId) {
    const turn = this.turns.get(String(turnId));
    return turn ? JSON.parse(JSON.stringify(turn)) : null;
  }

  replay(options = {}) {
    const terminalOnly = options.terminalOnly !== false;
    let replayed = 0;
    let skipped = 0;
    for (const turn of this.turns.values()) {
      if (!turn.user || (terminalOnly && !TERMINAL_STATUSES.has(turn.status))) {
        skipped += 1;
        continue;
      }
      this._materialize(turn, 0, 'replay');
      replayed += 1;
    }
    const result = { replayed, skipped, total: this.turns.size };
    this.emit('replayed', result);
    return result;
  }

  sweepStale(maxAgeMs, reason = 'turn watchdog timeout') {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('maxAgeMs musbat son bo‘lishi kerak');
    const cutoff = this.now() - maxAgeMs;
    const staleIds = [...this.turns.values()]
      .filter(turn => turn.user && !TERMINAL_STATUSES.has(turn.status) && turn.updatedAt <= cutoff)
      .map(turn => turn.turnId);
    for (const turnId of staleIds) this.append(turnId, 'turn.failed', { reason });
    if (staleIds.length) this.emit('stale', { turnIds: staleIds, reason });
    return staleIds;
  }

  startWatchdog(options = {}) {
    const maxAgeMs = options.maxAgeMs;
    const intervalMs = options.intervalMs || Math.max(1000, Math.min(60000, Math.floor(maxAgeMs / 4)));
    this.stopWatchdog();
    this.sweepStale(maxAgeMs, options.reason);
    this.watchdogTimer = setInterval(() => this.sweepStale(maxAgeMs, options.reason), intervalMs);
    this.watchdogTimer.unref?.();
    return this.watchdogTimer;
  }

  stopWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  _sanitize(value) {
    if (Array.isArray(value)) return value.slice(0, 50).map(item => this._sanitize(item));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (/audio|pcm|buffer|base64/i.test(key)) continue;
        out[clean(key, 100)] = this._sanitize(item);
      }
      return out;
    }
    if (typeof value === 'string') return clean(value);
    return value;
  }

  _appendDurably(event) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._rotateIfNeeded(Buffer.byteLength(JSON.stringify(event)) + 1);
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch (_) {}
  }

  _rotateIfNeeded(incomingBytes) {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (_) { return; }
    if (size + incomingBytes <= this.maxBytes) return;
    for (let index = this.retentionFiles - 1; index >= 1; index--) {
      const from = `${this.file}.${index}`;
      const to = `${this.file}.${index + 1}`;
      if (index + 1 > this.retentionFiles) { try { fs.rmSync(from, { force: true }); } catch (_) {} }
      else if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(this.file, `${this.file}.1`);
    this.emit('rotated', { file: this.file, size });
  }

  _load() {
    if (!this.file) return;
    const files = [];
    for (let index = this.retentionFiles; index >= 1; index--) {
      const archived = `${this.file}.${index}`;
      if (fs.existsSync(archived)) files.push(archived);
    }
    if (fs.existsSync(this.file)) files.push(this.file);
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this._reduce(JSON.parse(line)); } catch (_) {}
      }
    }
  }

  _reduce(event) {
    const current = this.turns.get(event.turnId) || {
      turnId: event.turnId, source: 'voice', status: 'accepted', createdAt: event.at,
      updatedAt: event.at, user: '', assistant: '', tools: []
    };
    const wasTerminal = TERMINAL_STATUSES.has(current.status);
    current.updatedAt = Math.max(current.updatedAt, event.at);
    const data = event.data || {};
    if (event.type === 'user.accepted') {
      current.user = data.text || current.user;
      current.source = data.source || current.source;
      if (!wasTerminal) current.status = 'accepted';
    } else if (event.type === 'assistant.recorded' || event.type === 'assistant.completed') {
      current.assistant = data.text || current.assistant;
      if (!wasTerminal && event.type === 'assistant.completed') current.status = 'completed';
    } else if (event.type === 'tool.started') {
      current.tools.push({ callId: data.callId || '', description: data.description || '', status: 'running', startedAt: event.at });
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed' || event.type === 'tool.cancelled') {
      let tool = [...current.tools].reverse().find(item => item.callId === data.callId);
      if (!tool) {
        tool = { callId: data.callId || '', description: data.description || '', startedAt: event.at };
        current.tools.push(tool);
      }
      tool.result = data.result || data.error || '';
      tool.status = event.type.split('.')[1];
      tool.completedAt = event.at;
    } else if (event.type === 'turn.cancelled' || event.type === 'turn.failed') {
      if (!wasTerminal) {
        current.status = event.type.split('.')[1];
        current.error = data.error || data.reason || '';
      }
    }
    this.turns.set(event.turnId, current);
    return current;
  }

  _materialize(turn, attempt, origin = 'append') {
    const startedAt = this.now();
    try {
      this.materialize(JSON.parse(JSON.stringify(turn)));
      clearTimeout(this.pending.get(turn.turnId));
      this.pending.delete(turn.turnId);
      this.emit('materialized', turn, { durationMs: Math.max(0, this.now() - startedAt), attempt, origin });
    } catch (error) {
      if (this.listenerCount('error')) this.emit('error', error, { turnId: turn.turnId, attempt });
      if (attempt >= this.maxRetries) return;
      clearTimeout(this.pending.get(turn.turnId));
      const timer = setTimeout(() => this._materialize(this.turns.get(turn.turnId), attempt + 1, origin), this.retryMs * (attempt + 1));
      timer.unref?.();
      this.pending.set(turn.turnId, timer);
    }
  }
}

module.exports = { TurnJournal };