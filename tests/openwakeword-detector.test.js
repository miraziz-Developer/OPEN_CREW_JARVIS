'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWakeWorkerLine } = require('../core/openwakeword-detector');

test('wake worker protocol identifies the model that triggered', () => {
  assert.deepEqual(parseWakeWorkerLine('DETECT hey_jarvis 0.6214'), {
    model: 'hey_jarvis', score: 0.6214
  });
  assert.deepEqual(parseWakeWorkerLine('DETECT jarvis 0.4321'), {
    model: 'jarvis', score: 0.4321
  });
});

test('wake worker protocol remains compatible with legacy score-only events', () => {
  assert.deepEqual(parseWakeWorkerLine('DETECT 0.5000'), {
    model: 'hey_jarvis', score: 0.5
  });
  assert.equal(parseWakeWorkerLine('SCORE hey_jarvis 0.1'), null);
});