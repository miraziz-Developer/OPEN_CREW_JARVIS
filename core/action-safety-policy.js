'use strict';

const crypto = require('crypto');

const CONFIRM = /^(?:yes|confirm|confirmed|proceed|do it|go ahead|ha|tasdiqlayman|davom et|bajar)$/i;
const REJECT = /^(?:no|cancel|stop|don't|do not|yo['‘’]?q|bekor|to['‘’]?xta|qilma)$/i;
const HIGH_RISK = /\b(?:delete|remove|erase|trash|format|reset|shutdown|restart|purchase|buy|pay|transfer|send|publish|post|email|message|upload|share|password|credential|permission|sudo|rm\s+-rf|o['‘’]?chir|yubor|sotib ol|to['‘’]?la|parol)\b/i;
const SENSITIVE = /\b(?:password|passcode|secret|token|credential|bank|card|medical|private|parol|maxfiy|karta)\b/i;

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function assessAction(action = {}) {
  const kind = String(action.kind || 'task');
  const id = String(action.id || '');
  const description = String(action.description || id);
  const text = `${id} ${description}`;
  const destructive = /(?:empty_trash|delete|remove|erase|format|reset|rm\s+-rf|o['‘’]?chir)/i.test(text);
  const externalSideEffect = /\b(?:send|publish|post|email|message|upload|share|purchase|buy|pay|transfer|yubor|sotib ol|to['‘’]?la)\b/i.test(text);
  const sensitive = SENSITIVE.test(text);
  const highImpact = kind === 'task' && HIGH_RISK.test(text);
  const requiresConfirmation = destructive || externalSideEffect || sensitive || highImpact;
  return {
    fingerprint: fingerprint(`${kind}|${id}|${description}`), kind, id,
    requiresConfirmation, destructive, externalSideEffect, sensitive, highImpact,
    risk: requiresConfirmation ? (destructive || sensitive ? 'high' : 'medium') : 'low'
  };
}

class ActionSafetyPolicy {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.confirmationTtlMs = options.confirmationTtlMs || 30000;
    this.pending = null;
    this.grant = null;
  }

  authorize(action) {
    const assessment = assessAction(action);
    if (!assessment.requiresConfirmation) return { allowed: true, assessment, reason: 'low-risk' };
    const now = this.now();
    if (this.grant && this.grant.fingerprint === assessment.fingerprint && this.grant.expiresAt >= now) {
      this.grant = null;
      this.pending = null;
      return { allowed: true, assessment, reason: 'explicit-confirmation' };
    }
    this.pending = { fingerprint: assessment.fingerprint, expiresAt: now + this.confirmationTtlMs };
    return { allowed: false, assessment, reason: 'confirmation-required' };
  }

  handleUtterance(text) {
    const value = String(text || '').trim();
    if (!this.pending || this.pending.expiresAt < this.now()) {
      this.pending = null;
      return { matched: false };
    }
    if (REJECT.test(value)) {
      this.pending = null;
      this.grant = null;
      return { matched: true, confirmed: false, reason: 'rejected' };
    }
    if (!CONFIRM.test(value)) return { matched: false };
    this.grant = { ...this.pending };
    this.pending = null;
    return { matched: true, confirmed: true, reason: 'explicit-confirmation' };
  }
}

module.exports = { ActionSafetyPolicy, assessAction };