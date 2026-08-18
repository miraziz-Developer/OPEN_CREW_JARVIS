'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMetric, evaluateQuality } = require('../core/quality-gates');

test('quality gate supports minimum, maximum and exclusive maximum', () => {
  assert.equal(evaluateMetric(97, { target: 97, direction: 'min' }).pass, true);
  assert.equal(evaluateMetric(800, { target: 800, direction: 'max' }).pass, true);
  assert.equal(evaluateMetric(1, { target: 1, direction: 'max-exclusive' }).pass, false);
});

test('unmeasured quality cannot produce a false green release', () => {
  const result = evaluateQuality({ duplicateActions: 0, falseCompletionClaims: 0 });
  assert.equal(result.pass, false);
  assert.equal(result.measured, 2);
  assert.equal(result.total, 7);
});