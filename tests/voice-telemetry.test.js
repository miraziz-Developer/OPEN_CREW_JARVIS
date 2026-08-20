'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeVoiceTelemetry } = require('../core/voice-telemetry');

test('summarizes flight recorder turns without requiring transcript text', () => {
  const report = summarizeVoiceTelemetry([
    { type: 'turn.suppressed', data: { reason: 'echo' } },
    { type: 'turn.summary', data: { outcome: 'turn.suppressed', timeToFirstAudioMs: null } },
    { type: 'turn.summary', data: { outcome: 'turn.completed', timeToFirstAudioMs: 410 } },
    { type: 'turn.summary', data: { outcome: 'turn.completed', timeToFirstAudioMs: 790 } }
  ]);
  assert.deepEqual(report.totals, { turns: 3, completed: 2, suppressed: 1, failed: 0 });
  assert.equal(report.latency.firstAudioP95Ms, 790);
  assert.equal(report.suppressionReasons.echo, 1);
});

test('derives response latency from legacy event records without counting user speech', () => {
  const report = summarizeVoiceTelemetry([
    { type: 'turn.started', at: 1000, turnId: 't1' },
    { type: 'command.accepted', at: 4000, turnId: 't1' },
    { type: 'assistant.audio.first', at: 4500, turnId: 't1' },
    { type: 'turn.summary', turnId: 't1', data: { turnId: 't1', outcome: 'turn.completed', timeToFirstAudioMs: 3500 } }
  ]);
  assert.equal(report.latency.firstAudioP50Ms, 500);
  assert.equal(report.latency.firstAudioP95Ms, 500);
  assert.equal(report.latency.basis, 'command-accepted-to-first-audio');
});