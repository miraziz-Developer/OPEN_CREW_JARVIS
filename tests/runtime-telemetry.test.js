'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeTelemetry } = require('../core/runtime-telemetry');

test('VAD telemetry persists matched turns, unmatched stops, watchdogs and speaking age', () => {
  let now = 1000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telemetry-')), 'telemetry.json');
  const telemetry = new RuntimeTelemetry({ file, now: () => now });
  telemetry.speechStarted();
  now += 240;
  telemetry.speechStopped();
  telemetry.speechStopped();
  telemetry.speechStarted();
  now += 100;
  telemetry.vadWatchdogTimeout();
  const state = telemetry.snapshot();
  assert.equal(state.vad.speechStarted, 2);
  assert.equal(state.vad.speechStopped, 2);
  assert.equal(state.vad.unmatchedSpeechStops, 1);
  assert.equal(state.vad.watchdogTimeouts, 1);
  assert.equal(state.vad.lastTurnDurationMs, 240);
  assert.equal(state.vad.speakingAgeMs, null);
  assert.equal(fs.existsSync(file), true);
});

test('provider counters remain cumulative while circuit state follows provider pool', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telemetry-')), 'telemetry.json');
  const telemetry = new RuntimeTelemetry({ file, now: () => 1000 });
  telemetry.providerResult('openclaw', new Error('network unavailable'));
  telemetry.providerResult('openclaw');
  telemetry.providerPool([{ id: 'openclaw', health: { calls: 2, successes: 1, failures: 0, lastError: null, circuitOpenUntil: 2000 } }]);
  const provider = telemetry.snapshot().providers.openclaw;
  assert.equal(provider.successCount, 1);
  assert.equal(provider.failureCount, 1);
  assert.equal(provider.circuit, 'open');
  assert.match(provider.lastError, /network unavailable/);
});

test('latency summary averages measured stages and identifies the slowest stage', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telemetry-')), 'telemetry.json');
  const telemetry = new RuntimeTelemetry({ file });
  telemetry.latency({ stt_ms: 100, agent_ms: 300, total_ms: 500 });
  telemetry.latency({ stt_ms: 200, agent_ms: 500, tts_ms: 150, total_ms: 800 });
  const summary = telemetry.snapshot().latency.summary;
  assert.equal(summary.averages.stt_ms.averageMs, 150);
  assert.equal(summary.averages.agent_ms.averageMs, 400);
  assert.equal(summary.averages.total_ms.averageMs, 650);
  assert.deepEqual(summary.slowestStage, { stage: 'total_ms', averageMs: 650 });
});