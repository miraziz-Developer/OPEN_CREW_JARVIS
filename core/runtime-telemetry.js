'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./jarvis-runtime');

const RECENT_LIMIT = 50;
const ERROR_MAX_CHARS = 300;

function truncateError(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX_CHARS);
}

function blankState() {
  return {
    version: 2,
    updatedAt: null,
    vad: { speechStarted: 0, speechStopped: 0, unmatchedSpeechStops: 0, watchdogTimeouts: 0, lastEventAt: null, speakingSince: null, lastTurnDurationMs: null, recentTurnDurationsMs: [] },
    providers: {},
    latency: { recent: [], summary: {} },
    openClawAttempts: [],
    selfHealAttempts: []
  };
}

function number(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }

function summarizeLatency(recent = []) {
  const averages = {};
  let slowestStage = null;
  for (const stage of ['stt_ms', 'agent_ms', 'tts_ms', 'total_ms']) {
    const values = recent.map(entry => entry[stage]).filter(Number.isFinite);
    if (!values.length) continue;
    const averageMs = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    averages[stage] = { count: values.length, averageMs };
    if (!slowestStage || averageMs > slowestStage.averageMs) slowestStage = { stage, averageMs };
  }
  return { count: recent.length, averages, slowestStage };
}

class RuntimeTelemetry {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), '.run', 'telemetry.json');
    this.now = options.now || Date.now;
    this.recentLimit = options.recentLimit || RECENT_LIMIT;
  }

  _load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = blankState();
      return {
        ...base, ...stored,
        vad: { ...base.vad, ...(stored.vad || {}) },
        providers: stored.providers || {},
        latency: { ...base.latency, ...(stored.latency || {}) },
        openClawAttempts: Array.isArray(stored.openClawAttempts) ? stored.openClawAttempts : [],
        selfHealAttempts: Array.isArray(stored.selfHealAttempts) ? stored.selfHealAttempts : []
      };
    } catch (_) { return blankState(); }
  }

  _withLock(work) {
    const lock = this.file + '.lock';
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 1000;
    while (true) {
      let descriptor;
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600);
        try { return work(); } finally { fs.closeSync(descriptor); fs.rmSync(lock, { force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true }); } catch (_) {}
        if (Date.now() >= deadline) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  _update(mutator) {
    return this._withLock(() => {
      const state = this._load();
      mutator(state);
      state.updatedAt = new Date(this.now()).toISOString();
      state.latency.summary = summarizeLatency(state.latency.recent);
      atomicWriteJson(this.file, state);
      return state;
    });
  }

  speechStarted() {
    return this._update(state => {
      const at = this.now();
      state.vad.speechStarted = number(state.vad.speechStarted) + 1;
      state.vad.lastEventAt = at;
      state.vad.speakingSince = at;
    });
  }

  speechStopped() {
    return this._update(state => {
      const at = this.now();
      state.vad.speechStopped = number(state.vad.speechStopped) + 1;
      state.vad.lastEventAt = at;
      if (!Number.isFinite(state.vad.speakingSince)) {
        state.vad.unmatchedSpeechStops = number(state.vad.unmatchedSpeechStops) + 1;
        return;
      }
      const durationMs = Math.max(0, at - state.vad.speakingSince);
      state.vad.lastTurnDurationMs = durationMs;
      state.vad.recentTurnDurationsMs = [...state.vad.recentTurnDurationsMs, durationMs].slice(-this.recentLimit);
      state.vad.speakingSince = null;
    });
  }

  vadWatchdogTimeout() {
    return this._update(state => {
      state.vad.watchdogTimeouts = number(state.vad.watchdogTimeouts) + 1;
      state.vad.lastEventAt = this.now();
      state.vad.speakingSince = null;
    });
  }

  providerPool(providers) {
    return this._update(state => {
      for (const item of providers || []) {
        const health = item.health || {};
        const previous = state.providers[item.id] || {};
        state.providers[item.id] = {
          successCount: number(previous.successCount), failureCount: number(previous.failureCount), calls: number(health.calls),
          lastError: health.lastError ? truncateError(health.lastError) : previous.lastError || null,
          circuit: number(health.circuitOpenUntil) > this.now() ? 'open' : 'closed',
          circuitOpenUntil: number(health.circuitOpenUntil) || null, updatedAt: this.now()
        };
      }
    });
  }

  providerResult(provider, error) {
    return this._update(state => {
      const previous = state.providers[provider] || {};
      state.providers[provider] = {
        ...previous,
        successCount: number(previous.successCount) + (error ? 0 : 1),
        failureCount: number(previous.failureCount) + (error ? 1 : 0),
        lastError: error ? truncateError(error) : previous.lastError || null,
        updatedAt: this.now()
      };
    });
  }

  latency(profile = {}) {
    return this._update(state => {
      const entry = { at: this.now() };
      for (const key of ['requestId', 'taskId', 'source', 'provider', 'stt_ms', 'agent_ms', 'tts_ms', 'total_ms', 'error', 'errorType', 'httpStatus', 'exitCode', 'signal', 'attempt', 'retryable']) if (profile[key] !== undefined) entry[key] = profile[key];
      if (entry.error) entry.error = truncateError(entry.error);
      state.latency.recent = [...state.latency.recent, entry].slice(-this.recentLimit);
    });
  }

  openClawAttempt(attempt = {}) {
    return this._update(state => {
      const entry = {};
      for (const key of [
        'attemptId', 'taskId', 'stepIndex', 'executionId', 'phase',
        'sessionKey', 'openClawSessionId', 'openClawRunId', 'childPid',
        'startedAt', 'finishedAt', 'elapsedMs', 'exitCode', 'signal',
        'timeout', 'stdoutBytes', 'stderrBytes', 'diagnosticSummary'
      ]) if (attempt[key] !== undefined) entry[key] = attempt[key];
      state.openClawAttempts = [...state.openClawAttempts, entry].slice(-this.recentLimit);
    });
  }

  selfHealAttempt(attempt = {}) {
    return this._update(state => {
      const entry = {};
      for (const key of ['taskId', 'stepIndex', 'attempt', 'classification', 'dependency', 'manager', 'status', 'startedAt', 'finishedAt', 'elapsedMs', 'diagnosticSummary', 'escalationReason']) if (attempt[key] !== undefined) entry[key] = attempt[key];
      state.selfHealAttempts = [...state.selfHealAttempts, entry].slice(-this.recentLimit);
    });
  }

  snapshot() {
    const state = this._load();
    state.latency.summary = summarizeLatency(state.latency.recent);
    state.vad.speakingAgeMs = Number.isFinite(state.vad.speakingSince) ? Math.max(0, this.now() - state.vad.speakingSince) : null;
    return state;
  }
}

module.exports = { RuntimeTelemetry, truncateError, summarizeLatency };