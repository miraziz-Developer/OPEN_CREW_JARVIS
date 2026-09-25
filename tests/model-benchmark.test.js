'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CASES, routeCases, runLive } = require('../scripts/model-benchmark');

test('model benchmark corpus covers fast, tool and architecture routing', () => {
  const rows = routeCases(CASES, (name, fallback) => ({
    AGENT_FAST_MODEL: 'fast', AGENT_STRONG_MODEL: 'strong', AGENT_STRONG_FALLBACK_MODELS: 'backup'
  })[name] || fallback);
  assert.ok(rows.every(row => row.routeOk));
  assert.deepEqual(rows.map(row => row.selectedModel), ['fast', 'strong', 'strong']);
});

test('live model benchmark records latency and minimal quality without exposing response text', async () => {
  const rows = await runLive([{ id: 'fixture', prompt: 'hello', selectedModel: 'fast', expectedModel: 'fast', routeOk: true, minChars: 2 }], async () => 'OK');
  assert.equal(rows[0].qualityOk, true);
  assert.equal(rows[0].outputChars, 2);
  assert.equal(typeof rows[0].latencyMs, 'number');
  assert.equal(rows[0].output, undefined);
});