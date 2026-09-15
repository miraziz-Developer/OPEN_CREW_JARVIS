'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL_EVENTS = new Set(['turn.completed', 'turn.suppressed', 'turn.failed', 'turn.abandoned', 'session.ended']);

function finite(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function redactText(value, options = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return { chars: 0, words: 0, fingerprint: null };
  const secret = String(options.secret || 'jarvis-local-flight-recorder');
  return {
    chars: text.length,
    words: text.split(' ').filter(Boolean).length,
    fingerprint: crypto.createHmac('sha256', secret).update(text.toLocaleLowerCase('uz-UZ')).digest('hex').slice(0, 16),
    ...(options.includeText === true ? { text: text.slice(0, options.maxTextChars || 500) } : {})
  };
}

class VoiceFlightRecorder {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), '.run', 'voice-flight-recorder.jsonl');
    this.now = options.now || (() => Date.now());
    this.sessionId = options.sessionId || null;
    this.includeText = options.includeText === true || process.env.JARVIS_FLIGHT_RECORDER_TEXT === '1';
    this.secret = options.secret || process.env.JARVIS_TELEMETRY_SECRET || 'jarvis-local-flight-recorder';
    this.maxTextChars = finite(options.maxTextChars, 500);
    this.activeTurnId = null;
    this.turnCounter = 0;
    this.turns = new Map();
    this.recent = [];
    this.maxRecent = finite(options.maxRecent, 120);
    this._writeChain = Promise.resolve();
    this._directoryReady = false;
  }

  beginSession(meta = {}) {
    this.sessionId = meta.sessionId || crypto.randomUUID();
    this.activeTurnId = null;
    this.turnCounter = 0;
    this._append({ type: 'session.started', at: this.now(), sessionId: this.sessionId, meta: this._sanitize(meta) });
    return this.sessionId;
  }

  beginTurn(meta = {}) {
    if (!this.sessionId) this.beginSession();
    if (this.activeTurnId) this.event('turn.abandoned', { reason: 'superseded-by-new-turn' }, this.activeTurnId);
    const turnId = meta.turnId || `${this.sessionId}:${++this.turnCounter}`;
    const at = this.now();
    this.activeTurnId = turnId;
    this.turns.set(turnId, {
      turnId,
      sessionId: this.sessionId,
      startedAt: at,
      responseStartedAt: null,
      firstAudioAt: null,
      events: []
    });
    this.event('turn.started', meta, turnId, at);
    return turnId;
  }

  event(type, data = {}, turnId = this.activeTurnId, at = this.now()) {
    const id = turnId || null;
    const turn = id ? this.turns.get(id) : null;
    const record = {
      type,
      at,
      sessionId: this.sessionId,
      turnId: id,
      sinceTurnMs: turn ? Math.max(0, at - turn.startedAt) : null,
      data: this._sanitize(data)
    };
    if (turn) {
      turn.events.push(record);
      if (type === 'command.accepted') turn.responseStartedAt = at;
      if (type === 'assistant.audio.first' && turn.firstAudioAt === null) turn.firstAudioAt = at;
    }
    this._append(record);
    if (TERMINAL_EVENTS.has(type) && id) this._finalizeTurn(id, type, at);
    return record;
  }

  textEvent(type, text, data = {}, turnId = this.activeTurnId) {
    return this.event(type, { ...data, text: redactText(text, this) }, turnId);
  }

  endSession(reason = 'ended') {
    if (this.activeTurnId) this.event('session.ended', { reason }, this.activeTurnId);
    else this.event('session.ended', { reason }, null);
    this.activeTurnId = null;
  }

  snapshot() {
    const turns = this.recent.slice();
    const ttfa = turns.map(turn => turn.responseToFirstAudioMs).filter(Number.isFinite);
    const suppressed = turns.filter(turn => turn.outcome === 'turn.suppressed').length;
    const failed = turns.filter(turn => turn.outcome === 'turn.failed').length;
    return {
      sessionId: this.sessionId,
      activeTurnId: this.activeTurnId,
      privacy: { rawAudioStored: false, transcriptTextStored: this.includeText },
      totals: { turns: turns.length, suppressed, failed },
      latency: { timeToFirstAudioP50Ms: percentile(ttfa, 0.5), timeToFirstAudioP95Ms: percentile(ttfa, 0.95) },
      recentTurns: turns.slice(-20)
    };
  }

  _finalizeTurn(turnId, outcome, at) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const summary = {
      turnId,
      sessionId: turn.sessionId,
      startedAt: turn.startedAt,
      endedAt: at,
      durationMs: Math.max(0, at - turn.startedAt),
      timeToFirstAudioMs: turn.firstAudioAt === null ? null : Math.max(0, turn.firstAudioAt - turn.startedAt),
      responseToFirstAudioMs: turn.firstAudioAt === null || turn.responseStartedAt === null
        ? null
        : Math.max(0, turn.firstAudioAt - turn.responseStartedAt),
      outcome,
      eventCount: turn.events.length,
      eventTypes: turn.events.map(event => event.type)
    };
    this.recent.push(summary);
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent);
    this.turns.delete(turnId);
    if (this.activeTurnId === turnId) this.activeTurnId = null;
    this._append({ type: 'turn.summary', at, sessionId: this.sessionId, turnId, data: summary });
  }

  _sanitize(value, key = '') {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value)) return { bytes: value.length };
    if (Array.isArray(value)) return value.slice(0, 30).map(item => this._sanitize(item, key));
    if (typeof value === 'object') {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (/audio|pcm|buffer|chunk/i.test(childKey) && (Buffer.isBuffer(childValue) || typeof childValue === 'string')) {
          out[childKey] = { bytes: Buffer.isBuffer(childValue) ? childValue.length : Buffer.byteLength(childValue) };
        } else if (/transcript|utterance|question|answer|description|output|result/i.test(childKey) && typeof childValue === 'string') {
          out[childKey] = redactText(childValue, this);
        } else {
          out[childKey] = this._sanitize(childValue, childKey);
        }
      }
      return out;
    }
    if (typeof value === 'string' && /text/i.test(key)) return redactText(value, this);
    if (typeof value === 'string') return value.slice(0, 300);
    return value;
  }

  _append(record) {
    this._writeChain = this._writeChain.then(async () => {
      if (!this._directoryReady) {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this._directoryReady = true;
      }
      await fs.promises.appendFile(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
    }).catch(() => {});
  }

  flush() { return this._writeChain; }
}

module.exports = { VoiceFlightRecorder, redactText, percentile };