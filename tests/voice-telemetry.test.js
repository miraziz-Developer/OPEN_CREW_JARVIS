'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRecords, summarizeVoiceTelemetry } = require('../core/voice-telemetry');

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
    { type: 'router.decision', at: 4010, turnId: 't1', data: { route: 'realtime-conversation' } },
    { type: 'assistant.audio.first', at: 4500, turnId: 't1' },
    { type: 'turn.summary', turnId: 't1', data: { turnId: 't1', outcome: 'turn.completed', timeToFirstAudioMs: 3500 } }
  ]);
  assert.equal(report.latency.firstAudioP50Ms, 500);
  assert.equal(report.latency.firstAudioP95Ms, 500);
  assert.equal(report.latency.basis, 'command-accepted-to-first-audio');
  assert.deepEqual(report.latency.byRoute['realtime-conversation'], {
    measuredTurns: 1, firstAudioP50Ms: 500, firstAudioP95Ms: 500
  });
});

test('summarizes stage-level latency overall and by route without inventing missing samples', () => {
  const report = summarizeVoiceTelemetry([
    { type: 'command.accepted', at: 1000, turnId: 't1' },
    { type: 'router.decision', at: 1010, turnId: 't1', data: { route: 'realtime-conversation' } },
    { type: 'provider.request.sent', at: 1020, turnId: 't1' },
    { type: 'provider.response.created', at: 1100, turnId: 't1' },
    { type: 'assistant.text.first', at: 1200, turnId: 't1' },
    { type: 'assistant.audio.first', at: 1300, turnId: 't1' },
    { type: 'playback.started', at: 1540, turnId: 't1' },
    { type: 'turn.summary', at: 1600, turnId: 't1', data: { turnId: 't1', outcome: 'turn.completed' } },
    { type: 'command.accepted', at: 2000, turnId: 't2' },
    { type: 'router.decision', at: 2030, turnId: 't2', data: { route: 'expert-answer' } },
    { type: 'turn.summary', at: 2300, turnId: 't2', data: { turnId: 't2', outcome: 'turn.failed' } }
  ]);

  assert.deepEqual(report.latency.stages.requestToFirstAudio, {
    measuredTurns: 1, p50Ms: 280, p95Ms: 280
  });
  assert.deepEqual(report.latency.stages.firstAudioToPlayback, {
    measuredTurns: 1, p50Ms: 240, p95Ms: 240
  });
  assert.deepEqual(report.latency.stagesByRoute['realtime-conversation'].commandToPlayback, {
    measuredTurns: 1, p50Ms: 540, p95Ms: 540
  });
  assert.deepEqual(report.latency.stagesByRoute['expert-answer'].requestToFirstAudio, {
    measuredTurns: 0, p50Ms: null, p95Ms: null
  });
});

test('fresh telemetry window excludes turns started before the current daemon', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telemetry-')), 'voice.jsonl');
  const records = [
    { type: 'command.accepted', at: 1000, turnId: 'old' },
    { type: 'turn.summary', at: 2100, turnId: 'old', data: { startedAt: 900, outcome: 'turn.completed', responseToFirstAudioMs: 4000 } },
    { type: 'command.accepted', at: 2200, turnId: 'new' },
    { type: 'turn.summary', at: 2500, turnId: 'new', data: { startedAt: 2100, outcome: 'turn.completed', responseToFirstAudioMs: 500 } }
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');

  const fresh = readRecords(file, { since: 2000 });
  assert.deepEqual(fresh.map(record => record.turnId), ['new', 'new']);
  assert.equal(summarizeVoiceTelemetry(fresh).latency.firstAudioP95Ms, 500);
});