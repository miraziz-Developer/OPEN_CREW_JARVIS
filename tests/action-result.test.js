'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeActionResult, verifyActionResult } = require('../core/action-result');
const { normalizeSnapshot } = require('../core/world-model');

function completed(overrides = {}) {
  return {
    status: 'completed',
    actions: [{ description: 'Safari opened', status: 'completed' }],
    verification: { passed: true, method: 'accessibility' },
    evidence: [{ type: 'accessibility', value: { app: 'Safari' } }],
    summary: 'Safari opened and was observed.',
    ...overrides
  };
}

test('structured action result requires executor pass and trusted concrete evidence', () => {
  assert.equal(verifyActionResult(completed()).verification.passed, true);
  assert.equal(verifyActionResult(completed({ evidence: ['I opened it'] })).verification.passed, false);
  assert.equal(verifyActionResult(completed({ verification: { passed: false } })).verification.passed, false);
});

test('refusal and manual handoff can never become verified completion', () => {
  const result = verifyActionResult(completed({ summary: "I can't directly close it; you'll need to do it manually." }));
  assert.equal(result.status, 'unverified');
  assert.equal(result.verification.passed, false);
});

test('JSON text normalizes into the versioned contract', () => {
  const result = normalizeActionResult(JSON.stringify(completed()));
  assert.equal(result.version, 1);
  assert.equal(result.actions[0].status, 'completed');
  assert.equal(result.evidence[0].type, 'accessibility');
});

test('optional world-model expectation must independently match observed state', () => {
  const before = normalizeSnapshot({ app: 'Terminal' });
  const after = normalizeSnapshot({ app: 'Safari', window: { title: 'Example' } });
  const worldModel = { current: () => after, verify: (left, right, expected) => require('../core/world-model').verifyExpectation(left, right, expected) };
  assert.equal(verifyActionResult(completed(), { worldModel, before, after, expected: { app: 'Safari' } }).verification.passed, true);
  assert.equal(verifyActionResult(completed(), { worldModel, before, after, expected: { app: 'Chrome' } }).verification.passed, false);
});