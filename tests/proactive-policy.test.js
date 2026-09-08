'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProactivePolicy } = require('../core/proactive-policy');

function policy(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proactive-'));
  return new ProactivePolicy({ file: path.join(dir, 'state.json'), ...options });
}

test('low value is observed, useful event is suggested and duplicate is cooled down', () => {
  let now = 1000;
  const p = policy({ now: () => now });
  assert.equal(p.evaluate({ summary: 'minor', confidence: 0.2, benefit: 0.1 }).mode, 'observe');
  const useful = { summary: 'Build failed', source: 'screen', confidence: 0.95, urgency: 0.8, benefit: 0.9, reversibility: 1, risk: 0.1 };
  assert.equal(p.evaluate(useful).mode, 'suggest');
  now += 100;
  assert.equal(p.evaluate(useful).reason, 'cooldown_duplicate');
});

test('autonomous act requires explicit authorization and safe reversible operation', () => {
  const p = policy();
  const safe = { summary: 'Refresh local cache', confidence: 1, urgency: 1, benefit: 1, reversibility: 1, risk: 0, explicitAuthorization: true };
  assert.equal(p.evaluate(safe).mode, 'act');
  assert.notEqual(p.evaluate({ ...safe, summary: 'Send email', externalSideEffect: true }).mode, 'act');
  assert.notEqual(p.evaluate({ ...safe, summary: 'Delete files', destructive: true }).mode, 'act');
});

test('notification budget prevents nagging but urgent notices pass', () => {
  const p = policy({ dailySuggestionBudget: 1 });
  const base = { confidence: 0.9, benefit: 0.9, reversibility: 1, risk: 0.1 };
  assert.equal(p.evaluate({ ...base, summary: 'one' }).mode, 'suggest');
  assert.equal(p.evaluate({ ...base, summary: 'two' }).reason, 'daily_notification_budget');
  assert.equal(p.evaluate({ ...base, summary: 'urgent', urgency: 0.95 }).mode, 'suggest');
});

test('privacy, meeting and focus context suppress non-urgent proactive speech', () => {
  const p = policy();
  const useful = { confidence: 1, urgency: 0.8, benefit: 1, reversibility: 1, risk: 0 };
  assert.equal(p.evaluate({ ...useful, summary: 'private', context: { privacyMode: true } }).reason, 'privacy-mode');
  assert.equal(p.evaluate({ ...useful, summary: 'meeting', context: { meeting: true } }).reason, 'meeting');
  assert.equal(p.evaluate({ ...useful, summary: 'focus', context: { focusMode: true } }).reason, 'focus-mode');
  assert.equal(p.evaluate({ ...useful, summary: 'urgent', urgency: 0.95, context: { meeting: true } }).mode, 'suggest');
});

test('global privacy mode cannot be bypassed by a candidate context', () => {
  const p = policy({ defaultContext: { privacyMode: true } });
  const decision = p.evaluate({
    summary: 'private default', confidence: 1, urgency: 1, benefit: 1,
    reversibility: 1, risk: 0, context: { privacyMode: false, focusMode: false }
  });
  assert.equal(decision.mode, 'observe');
  assert.equal(decision.reason, 'privacy-mode');
});

test('workflow becomes an automation candidate only after three observations', () => {
  const p = policy();
  const steps = ['open terminal', 'run tests', 'open report'];
  assert.equal(p.observeWorkflow(steps).workflow.status, 'learning');
  p.observeWorkflow(steps);
  const third = p.observeWorkflow(steps, { app: 'VS Code' });
  assert.equal(third.workflow.status, 'candidate');
  assert.equal(third.shouldSuggestAutomation, true);
});