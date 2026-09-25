'use strict';

const { normalizeSnapshot, verifyExpectation } = require('./world-model');
const { assessAction } = require('./action-safety-policy');

const ACTIONS = new Set(['press', 'focus', 'set_value']);
const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const targetName = (target = {}) => clean(target.name || target.title || target.description || target.identifier, 200);

function chooseSemantic(matches = [], options = {}) {
  if (!Array.isArray(matches) || !matches.length) return { ok: false, reason: 'not-found' };
  const minimum = Number(options.minimumScore ?? 20), margin = Number(options.ambiguityMargin ?? 8);
  const first = matches[0], second = matches[1];
  if (Number(first.score) < minimum) return { ok: false, reason: 'low-confidence' };
  if (second && Number(first.score) - Number(second.score) < margin) return { ok: false, reason: 'ambiguous' };
  return { ok: true, target: first };
}

function chooseVisual(elements = [], options = {}) {
  if (!Array.isArray(elements) || !elements.length) return { ok: false, reason: 'not-found' };
  const minimum = Number(options.minimumConfidence ?? 0.78), margin = Number(options.ambiguityMargin ?? 0.12);
  const [first, second] = [...elements].sort((a, b) => Number(b.confidence) - Number(a.confidence));
  if (Number(first.confidence) < minimum) return { ok: false, reason: 'low-confidence' };
  if (second && Number(first.confidence) - Number(second.confidence) < margin) return { ok: false, reason: 'ambiguous' };
  if (![first.center?.x, first.center?.y].every(Number.isFinite)) return { ok: false, reason: 'invalid-geometry' };
  return { ok: true, target: first };
}

function blocked(summary, attempts, checks = []) {
  return {
    version: 1, status: 'blocked', actions: attempts,
    verification: { passed: false, method: 'independent-world-model', checks }, evidence: [],
    summary: clean(summary, 1000), error: clean(summary, 1000)
  };
}

class VisualActionLoop {
  constructor(options = {}) {
    for (const dependency of ['observe', 'inspect', 'actSemantic', 'locateVisual', 'actVisual']) {
      if (typeof options[dependency] !== 'function') throw new Error(`VisualActionLoop requires ${dependency}`);
    }
    Object.assign(this, options);
    this.verify = options.verify || verifyExpectation;
    this.authorize = options.authorize || (action => {
      const assessment = assessAction(action);
      return { allowed: !assessment.requiresConfirmation, assessment };
    });
    this.maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 3)));
  }

  async run(request = {}) {
    const query = request.target && typeof request.target === 'object' ? request.target : {};
    const name = targetName(query), action = clean(request.action || 'press', 40);
    if (!name) throw new Error('Visual action target name/title/description/identifier required');
    if (!ACTIONS.has(action)) throw new Error(`Unsupported visual action: ${action}`);
    if (!request.expect || typeof request.expect !== 'object' || !Object.keys(request.expect).length) throw new Error('Explicit observable expectation required');

    const authorization = this.authorize({ kind: 'task', id: `visual:${action}:${name}`, description: `${action} ${name}` }, request);
    if (!authorization.allowed) {
      return blocked('Explicit confirmation is required before this visual action.', [], [
        { name: 'safety-authorization', passed: false, risk: authorization.assessment?.risk || 'unknown', fingerprint: authorization.assessment?.fingerprint }
      ]);
    }

    const attempts = [];
    let lastReason = 'Target not found';
    for (let number = 1; number <= this.maxAttempts; number++) {
      const before = normalizeSnapshot(await this.observe());
      let mode = 'accessibility', selected;
      try {
        const semantic = chooseSemantic(await this.inspect(query), request.semantic);
        if (semantic.ok) selected = semantic.target;
        else if (semantic.reason === 'ambiguous') return blocked('Accessibility target is ambiguous; no action was performed.', attempts);
      } catch (error) { lastReason = clean(error.message); }

      if (!selected) {
        if (action === 'set_value') return blocked('Text entry requires a uniquely identified Accessibility element; visual coordinate typing was not performed.', attempts);
        mode = 'vision';
        let visual;
        try { visual = chooseVisual(await this.locateVisual(name, before), request.visual); }
        catch (error) { lastReason = clean(error.message); continue; }
        if (!visual.ok) {
          lastReason = `Visual target ${visual.reason}`;
          if (visual.reason === 'ambiguous') return blocked('Visual target is ambiguous; no action was performed.', attempts);
          continue;
        }
        selected = visual.target;
      }

      let acted;
      try {
        acted = mode === 'accessibility'
          ? await this.actSemantic({ target: selected, action, value: request.value })
          : await this.actVisual({ target: selected, action, value: request.value });
      } catch (error) {
        lastReason = clean(error.message);
        attempts.push({ id: `attempt-${number}`, description: `${mode} ${action} ${name}`, status: 'failed' });
        continue;
      }
      if (acted?.status && acted.status !== 'ok') {
        lastReason = clean(acted.message || `${mode} action failed`);
        attempts.push({ id: `attempt-${number}`, description: `${mode} ${action} ${name}`, status: 'failed' });
        continue;
      }

      const after = normalizeSnapshot(await this.observe());
      const verification = this.verify(before, after, request.expect);
      attempts.push({ id: `attempt-${number}`, description: `${mode} ${action} ${name}`, status: verification.ok ? 'completed' : 'failed' });
      if (verification.ok) {
        const evidence = [{ type: mode === 'accessibility' ? 'accessibility' : 'screenshot', value: { app: after.app, target: name, action } }, { type: 'world-state', value: verification }];
        return {
          version: 1, status: 'completed', actions: attempts,
          verification: { passed: true, method: 'independent-world-model', checks: verification.checks },
          evidence, summary: `${name} ${action} completed and independently verified.`, error: null
        };
      }
      lastReason = 'Expected state was not observed after the action';
    }
    return blocked(`${lastReason}; stopped after ${this.maxAttempts} safe attempts.`, attempts);
  }
}

module.exports = { VisualActionLoop, chooseSemantic, chooseVisual };