'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function fingerprint(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20); }
function dayKey(now) { return new Date(now).toLocaleDateString('en-CA'); }

class ProactivePolicy {
  constructor(options = {}) {
    this.file = options.file || null;
    this.now = options.now || Date.now;
    this.cooldownMs = options.cooldownMs || 30 * 60e3;
    this.dailySuggestionBudget = options.dailySuggestionBudget || 8;
    this.state = { version: 1, decisions: [], workflows: {}, budget: {} };
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {}
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  evaluate(candidate = {}) {
    this._load();
    const now = this.now();
    const id = candidate.id || fingerprint(`${candidate.source}|${candidate.summary}`);
    const risk = clamp(candidate.risk);
    const confidence = clamp(candidate.confidence);
    const urgency = clamp(candidate.urgency);
    const benefit = clamp(candidate.benefit);
    const reversibility = clamp(candidate.reversibility);
    const disruption = clamp(candidate.disruption);
    const explicit = candidate.explicitAuthorization === true;
    const score = clamp(confidence * 0.3 + urgency * 0.25 + benefit * 0.25 + reversibility * 0.15 - risk * 0.35 - disruption * 0.1);
    let mode = score >= 0.45 ? 'suggest' : 'observe';
    let reason = mode === 'observe' ? 'score_below_suggestion_threshold' : 'useful_safe_suggestion';

    const hardBlocked = candidate.destructive || candidate.sensitive || candidate.externalSideEffect || risk >= 0.7;
    if (explicit && score >= 0.72 && reversibility >= 0.8 && !hardBlocked) { mode = 'act'; reason = 'explicit_safe_reversible_action'; }
    if (hardBlocked && mode === 'act') { mode = 'suggest'; reason = 'risk_requires_confirmation'; }
    if (!explicit && mode === 'act') { mode = 'suggest'; reason = 'missing_explicit_authorization'; }

    const previous = [...this.state.decisions].reverse().find(item => item.id === id && item.mode !== 'observe');
    if (previous && now - previous.at < this.cooldownMs) { mode = 'observe'; reason = 'cooldown_duplicate'; }
    const day = dayKey(now);
    const used = Number(this.state.budget[day] || 0);
    if (mode === 'suggest' && urgency < 0.85 && used >= this.dailySuggestionBudget) { mode = 'observe'; reason = 'daily_notification_budget'; }
    if (mode === 'suggest') this.state.budget[day] = used + 1;

    const decision = { id, at: now, mode, reason, score, source: candidate.source || 'unknown', summary: String(candidate.summary || '').slice(0, 300) };
    this.state.decisions.push(decision);
    this.state.decisions = this.state.decisions.slice(-500);
    for (const key of Object.keys(this.state.budget)) if (key !== day) delete this.state.budget[key];
    this._save();
    return decision;
  }

  observeWorkflow(steps, context = {}) {
    this._load();
    const normalized = (steps || []).map(step => String(step).trim().toLocaleLowerCase()).filter(Boolean).slice(0, 12);
    if (normalized.length < 2) return { status: 'ignored', reason: 'sequence_too_short' };
    const signature = fingerprint(normalized.join(' -> '));
    const item = this.state.workflows[signature] || { signature, steps: normalized, occurrences: 0, contexts: [], status: 'learning' };
    item.occurrences++;
    item.lastSeenAt = this.now();
    const contextLabel = String(context.app || context.label || '').slice(0, 100);
    if (contextLabel && !item.contexts.includes(contextLabel)) item.contexts.push(contextLabel);
    if (item.occurrences >= 3) item.status = 'candidate';
    this.state.workflows[signature] = item;
    this._save();
    return { status: 'ok', workflow: item, shouldSuggestAutomation: item.status === 'candidate' && item.occurrences === 3 };
  }

  snapshot() { this._load(); return JSON.parse(JSON.stringify(this.state)); }
}

module.exports = { ProactivePolicy, fingerprint };