'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const TERMINAL_TASK_STATES = new Set(['verified', 'failed', 'cancelled']);
const ALLOWED_TASK_TRANSITIONS = {
  requested: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['completed', 'verified', 'failed', 'cancelled']),
  completed: new Set(['verified', 'failed']),
  verified: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('uz-UZ')
    .replace(/[‘’`ʻʼ]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprintText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}

class JarvisRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.now = options.now || (() => Date.now());
    this.statusFile = options.statusFile || null;
    this.commandWindowMs = options.commandWindowMs || 5000;
    this.responseWindowMs = options.responseWindowMs || 15000;
    this.maxTasks = options.maxTasks || 100;
    this.flushDelayMs = options.flushDelayMs || 75;
    this._flushTimer = null;
    this._sequence = 0;
    this._recentCommands = new Map();
    this._recentResponses = new Map();
    this._latencies = new Map();
    this._heartbeats = new Map();
    this._tasks = [];
    this._conversation = {
      id: null,
      mode: 'idle',
      source: null,
      startedAt: null,
      updatedAt: this.now(),
      lastUserText: '',
      lastAssistantText: ''
    };
  }

  beginConversation(source, id) {
    const now = this.now();
    this._conversation = {
      id: id || 'voice-' + now + '-' + (++this._sequence),
      mode: 'connecting',
      source: source || 'voice',
      startedAt: now,
      updatedAt: now,
      lastUserText: '',
      lastAssistantText: ''
    };
    this._recordEvent('conversation.started', { id: this._conversation.id, source: this._conversation.source });
    return this._conversation.id;
  }

  setConversationMode(mode, details = {}) {
    this._conversation.mode = mode;
    this._conversation.updatedAt = this.now();
    Object.assign(this._conversation, details);
    this._recordEvent('conversation.mode', { mode, ...details });
  }

  endConversation(reason) {
    if (!this._conversation.id) return;
    this._recordEvent('conversation.ended', { id: this._conversation.id, reason: reason || 'complete' });
    this._conversation.mode = 'idle';
    this._conversation.updatedAt = this.now();
    this._conversation.endedAt = this.now();
    this._conversation.endReason = reason || 'complete';
  }

  acceptCommand(text, options = {}) {
    const now = this.now();
    const normalized = normalizeText(text);
    if (!normalized) return { accepted: false, reason: 'empty', normalized };
    this._pruneMap(this._recentCommands, now - this.commandWindowMs);
    const source = options.source || 'voice';
    const key = source + ':' + fingerprintText(normalized);
    const previousAt = this._recentCommands.get(key);
    if (previousAt !== undefined && now - previousAt < (options.windowMs || this.commandWindowMs)) {
      this._recordEvent('command.duplicate', { source, text: normalized, ageMs: now - previousAt });
      return { accepted: false, reason: 'duplicate', normalized, ageMs: now - previousAt };
    }
    this._recentCommands.set(key, now);
    this._conversation.lastUserText = String(text || '').trim();
    this._conversation.updatedAt = now;
    this._recordEvent('command.accepted', { source, text: normalized });
    return { accepted: true, normalized };
  }

  acceptResponse(text, options = {}) {
    const now = this.now();
    const normalized = normalizeText(text);
    if (!normalized) return { accepted: false, reason: 'empty', normalized };
    this._pruneMap(this._recentResponses, now - this.responseWindowMs);
    const key = fingerprintText(normalized);
    const previousAt = this._recentResponses.get(key);
    if (previousAt !== undefined && now - previousAt < (options.windowMs || this.responseWindowMs)) {
      this._recordEvent('response.duplicate', { text: normalized.slice(0, 160), ageMs: now - previousAt });
      return { accepted: false, reason: 'duplicate', normalized, ageMs: now - previousAt };
    }
    this._recentResponses.set(key, now);
    this._conversation.lastAssistantText = String(text || '').trim();
    this._conversation.updatedAt = now;
    this._recordEvent('response.accepted', { text: normalized.slice(0, 160) });
    return { accepted: true, normalized };
  }

  requestTask(description, options = {}) {
    const now = this.now();
    const task = {
      id: options.id || 'task-' + now + '-' + (++this._sequence),
      description: String(description || '').trim(),
      source: options.source || 'unknown',
      conversationId: options.conversationId || this._conversation.id,
      state: 'requested',
      requestedAt: now,
      updatedAt: now,
      result: null,
      verification: null,
      error: null
    };
    const existing = this._tasks.find(item => item.id === task.id);
    if (existing) return existing;
    this._tasks.push(task);
    if (this._tasks.length > this.maxTasks) this._tasks.splice(0, this._tasks.length - this.maxTasks);
    this._recordEvent('task.requested', { id: task.id, description: task.description, source: task.source });
    return task;
  }

  transitionTask(id, nextState, details = {}) {
    const task = this._tasks.find(item => item.id === id);
    if (!task) throw new Error('Noma\'lum task: ' + id);
    if (task.state === nextState) return task;
    const allowed = ALLOWED_TASK_TRANSITIONS[task.state];
    if (!allowed || !allowed.has(nextState)) {
      throw new Error('Noto\'g\'ri task transition: ' + task.state + ' -> ' + nextState);
    }
    const now = this.now();
    task.state = nextState;
    task.updatedAt = now;
    if (nextState === 'running') task.startedAt = details.startedAt || now;
    if (nextState === 'completed') task.completedAt = details.completedAt || now;
    if (nextState === 'verified') {
      task.completedAt = task.completedAt || now;
      task.verifiedAt = details.verifiedAt || now;
      task.verification = details.verification || { method: 'executor-result', ok: true };
    }
    if (nextState === 'failed') {
      task.completedAt = now;
      task.error = String(details.error || 'Noma\'lum xatolik');
    }
    if (nextState === 'cancelled') task.completedAt = now;
    if (Object.prototype.hasOwnProperty.call(details, 'result')) task.result = details.result;
    this._recordEvent('task.' + nextState, { id, description: task.description });
    return task;
  }

  completeTask(id, result, verification) {
    const text = String(result || '').trim();
    const failed = !text || /(^|\b)(error|xatolik|failed|bajarilmadi|muvaffaqiyatsiz)(\b|:)/i.test(text);
    if (failed) return this.transitionTask(id, 'failed', { result: text, error: text || 'Bo\'sh natija' });
    return this.transitionTask(id, 'verified', {
      result: text,
      verification: verification || { method: 'executor-result', ok: true }
    });
  }

  heartbeat(component, details = {}) {
    this._heartbeats.set(component, { at: this.now(), ...details });
    this._scheduleFlush();
  }

  observeLatency(name, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const values = this._latencies.get(name) || [];
    values.push(Math.round(durationMs));
    if (values.length > 100) values.shift();
    this._latencies.set(name, values);
    this._scheduleFlush();
  }

  snapshot() {
    const now = this.now();
    const latencies = {};
    for (const [name, values] of this._latencies) {
      const sorted = values.slice().sort((a, b) => a - b);
      latencies[name] = {
        count: values.length,
        latestMs: values[values.length - 1],
        averageMs: Math.round(values.reduce((sum, n) => sum + n, 0) / values.length),
        p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
      };
    }
    const components = {};
    for (const [name, heartbeat] of this._heartbeats) {
      components[name] = { ...heartbeat, ageMs: now - heartbeat.at };
    }
    return {
      version: 1,
      pid: process.pid,
      generatedAt: new Date(now).toISOString(),
      conversation: { ...this._conversation },
      tasks: this._tasks.slice().reverse(),
      activeTaskCount: this._tasks.filter(task => !TERMINAL_TASK_STATES.has(task.state)).length,
      components,
      latency: latencies
    };
  }

  flush() {
    if (!this.statusFile) return;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    atomicWriteJson(this.statusFile, this.snapshot());
  }

  close() {
    this.flush();
    this.removeAllListeners();
  }

  _recordEvent(type, payload) {
    const event = { type, at: this.now(), ...payload };
    this.emit(type, event);
    this.emit('event', event);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (!this.statusFile || this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      try { this.flush(); } catch (error) { this.emit('runtime.error', error); }
    }, this.flushDelayMs);
    this._flushTimer.unref?.();
  }

  _pruneMap(map, threshold) {
    for (const [key, at] of map) if (at < threshold) map.delete(key);
  }
}

module.exports = {
  JarvisRuntime,
  normalizeText,
  fingerprintText,
  atomicWriteJson,
  TERMINAL_TASK_STATES
};