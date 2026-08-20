'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./jarvis-runtime');

const TERMINAL = new Set(['verified', 'failed', 'cancelled']);
const STEP_TERMINAL = new Set(['verified', 'failed', 'cancelled']);

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class MissionControl extends EventEmitter {
  constructor(options = {}) {
    super();
    this.file = options.file || null;
    this.journalFile = options.journalFile || (this.file ? this.file.replace(/\.json$/, '.jsonl') : null);
    this.now = options.now || (() => Date.now());
    this.defaultMaxAttempts = options.defaultMaxAttempts || 3;
    this.retryBaseMs = options.retryBaseMs || 5000;
    this.leaseMs = options.leaseMs || 120000;
    this.maxEvents = options.maxEvents || 500;
    this.state = this._load();
  }

  createMission(goal, options = {}) {
    const idempotencyKey = options.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = this.state.missions.find(m => m.idempotencyKey === idempotencyKey);
      if (existing) return clone(existing);
    }
    const now = this.now();
    const id = options.id || stableId('mission', `${goal}:${now}`);
    const byId = this._mission(id, false);
    if (byId) return clone(byId);
    const rawSteps = options.steps?.length ? options.steps : [{ description: goal }];
    const steps = rawSteps.map((step, index) => ({
      id: step.id || `step-${index + 1}`,
      description: String(step.description || step.goal || '').trim(),
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice() : (index ? [rawSteps[index - 1].id || `step-${index}`] : []),
      status: 'pending', attempts: 0, maxAttempts: step.maxAttempts || options.maxAttempts || this.defaultMaxAttempts,
      retryAt: null, lease: null, result: null, error: null, evidence: [], verification: null,
      createdAt: now, updatedAt: now
    }));
    this._validatePlan(steps);
    const mission = {
      id, goal: String(goal || '').trim(), source: options.source || 'unknown', idempotencyKey,
      status: 'planned', priority: options.priority || 'normal', metadata: options.metadata || {},
      steps, createdAt: now, updatedAt: now, completedAt: null
    };
    this.state.missions.push(mission);
    this._record('mission.created', mission, { goal: mission.goal, stepCount: steps.length });
    return clone(mission);
  }

  claimNext(missionId, worker = 'default') {
    const mission = this._mission(missionId);
    this._recoverMission(mission);
    if (TERMINAL.has(mission.status)) return null;
    const now = this.now();
    for (const step of mission.steps) {
      if (step.status === 'retry_wait' && step.retryAt <= now) step.status = 'pending';
    }
    const step = mission.steps.find(item => item.status === 'pending' && item.dependsOn.every(id => mission.steps.find(s => s.id === id)?.status === 'verified'));
    if (!step) { this._refreshMission(mission); this._persist(); return null; }
    step.status = 'running';
    step.attempts += 1;
    step.lease = { worker, claimedAt: now, expiresAt: now + this.leaseMs };
    step.updatedAt = now;
    mission.status = 'running'; mission.updatedAt = now;
    this._record('step.claimed', mission, { stepId: step.id, worker, attempt: step.attempts });
    return clone(step);
  }

  submitResult(missionId, stepId, result, evidence = []) {
    const { mission, step } = this._step(missionId, stepId);
    if (step.status !== 'running' && step.status !== 'awaiting_verification') throw new Error(`Step result qabul qilmaydi: ${step.status}`);
    step.result = result;
    step.evidence.push(...this._normalizeEvidence(evidence));
    step.status = 'awaiting_verification'; step.lease = null; step.updatedAt = this.now();
    mission.status = 'verifying'; mission.updatedAt = this.now();
    this._record('step.result_submitted', mission, { stepId, evidenceCount: step.evidence.length });
    return clone(step);
  }

  verifyStep(missionId, stepId, verification = {}) {
    const { mission, step } = this._step(missionId, stepId);
    if (step.status !== 'awaiting_verification') throw new Error(`Step verification kutmayapti: ${step.status}`);
    const validEvidence = step.evidence.some(item => item && item.type && (item.value !== undefined || item.uri || item.summary));
    const ok = verification.ok === true && validEvidence;
    step.verification = { ...verification, ok, verifiedAt: this.now(), evidenceRequired: true };
    if (!ok) return this.failStep(missionId, stepId, verification.error || (validEvidence ? 'Verifier rad etdi' : 'Dalil yo‘q'));
    step.status = 'verified'; step.updatedAt = this.now();
    mission.updatedAt = this.now();
    this._record('step.verified', mission, { stepId, method: verification.method || 'unspecified' });
    this._refreshMission(mission);
    return clone(step);
  }

  failStep(missionId, stepId, error, options = {}) {
    const { mission, step } = this._step(missionId, stepId);
    if (STEP_TERMINAL.has(step.status)) return clone(step);
    step.error = String(error || 'Noma’lum xato'); step.lease = null; step.updatedAt = this.now();
    const retryable = options.retryable !== false && step.attempts < step.maxAttempts;
    if (retryable) {
      step.status = 'retry_wait';
      step.retryAt = this.now() + (options.retryAfterMs ?? this.retryBaseMs * (2 ** Math.max(0, step.attempts - 1)));
      mission.status = 'waiting_retry';
      this._record('step.retry_scheduled', mission, { stepId, attempt: step.attempts, retryAt: step.retryAt, error: step.error });
    } else {
      step.status = 'failed'; mission.status = 'failed'; mission.completedAt = this.now();
      for (const dependent of mission.steps) if (dependent.dependsOn.includes(stepId) && dependent.status === 'pending') dependent.status = 'blocked';
      this._record('step.failed', mission, { stepId, attempt: step.attempts, error: step.error });
    }
    mission.updatedAt = this.now(); this._persist();
    return clone(step);
  }

  cancelMission(missionId, reason = 'cancelled') {
    const mission = this._mission(missionId);
    if (TERMINAL.has(mission.status)) return clone(mission);
    mission.status = 'cancelled'; mission.completedAt = this.now(); mission.updatedAt = this.now();
    for (const step of mission.steps) if (!STEP_TERMINAL.has(step.status)) { step.status = 'cancelled'; step.error = reason; step.lease = null; }
    this._record('mission.cancelled', mission, { reason });
    return clone(mission);
  }

  recoverStale() {
    let recovered = 0;
    for (const mission of this.state.missions) recovered += this._recoverMission(mission);
    if (recovered) this._persist();
    return recovered;
  }

  getMission(id) { const mission = this._mission(id, false); return mission ? clone(mission) : null; }
  listResumable() { return clone(this.state.missions.filter(m => !TERMINAL.has(m.status))); }
  snapshot() { return clone(this.state); }

  _load() {
    if (!this.file) return { version: 1, missions: [], events: [] };
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.version === 1 && Array.isArray(value.missions)) return value;
    } catch (_) {}
    return { version: 1, missions: [], events: [] };
  }

  _validatePlan(steps) {
    const ids = new Set();
    for (const step of steps) {
      if (!step.id || ids.has(step.id)) throw new Error(`Takror yoki bo‘sh step id: ${step.id}`);
      ids.add(step.id);
    }
    for (const step of steps) for (const dependency of step.dependsOn) if (!ids.has(dependency)) throw new Error(`Noma’lum dependency: ${dependency}`);
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const step = steps.find(item => item.id === id);
      for (const dependency of step.dependsOn) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const step of steps) visit(step.id);
  }

  _mission(id, required = true) {
    const mission = this.state.missions.find(item => item.id === id);
    if (!mission && required) throw new Error(`Noma’lum mission: ${id}`);
    return mission;
  }

  _step(missionId, stepId) {
    const mission = this._mission(missionId);
    const step = mission.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Noma’lum step: ${stepId}`);
    return { mission, step };
  }

  _recoverMission(mission) {
    const now = this.now(); let count = 0;
    for (const step of mission.steps) {
      if (step.status === 'running' && (!step.lease || step.lease.expiresAt <= now)) {
        step.status = step.attempts < step.maxAttempts ? 'retry_wait' : 'failed';
        step.retryAt = step.status === 'retry_wait' ? now : null; step.lease = null; step.error = 'Worker lease tugadi'; count++;
        this._record('step.lease_expired', mission, { stepId: step.id, attempt: step.attempts }, false);
      }
    }
    if (count) this._refreshMission(mission, false);
    return count;
  }

  _refreshMission(mission, persist = true) {
    const statuses = mission.steps.map(step => step.status);
    if (statuses.every(status => status === 'verified')) { mission.status = 'verified'; mission.completedAt = this.now(); }
    else if (statuses.includes('failed') || (statuses.includes('blocked') && !statuses.some(status => ['pending', 'running', 'retry_wait', 'awaiting_verification'].includes(status)))) { mission.status = 'failed'; mission.completedAt = this.now(); }
    else if (statuses.includes('running')) mission.status = 'running';
    else if (statuses.includes('awaiting_verification')) mission.status = 'verifying';
    else if (statuses.includes('retry_wait')) mission.status = 'waiting_retry';
    else mission.status = 'planned';
    mission.updatedAt = this.now();
    if (persist) this._persist();
  }

  _normalizeEvidence(evidence) {
    const items = Array.isArray(evidence) ? evidence : [evidence];
    return items.filter(Boolean).map(item => typeof item === 'string' ? { type: 'text', value: item, capturedAt: this.now() } : { capturedAt: this.now(), ...item });
  }

  _record(type, mission, payload, persist = true) {
    const event = { id: stableId('event', `${type}:${mission.id}:${this.now()}:${Math.random()}`), type, missionId: mission.id, at: this.now(), ...payload };
    this.state.events.push(event);
    if (this.state.events.length > this.maxEvents) this.state.events.splice(0, this.state.events.length - this.maxEvents);
    if (this.journalFile) {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, `${JSON.stringify(event)}\n`);
    }
    this.emit('event', clone(event));
    if (persist) this._persist();
  }

  _persist() { if (this.file) atomicWriteJson(this.file, this.state); }
}

module.exports = { MissionControl, stableId, TERMINAL };