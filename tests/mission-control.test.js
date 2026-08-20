'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionControl, stableId } = require('../core/mission-control');

test('mission executes dependency DAG and requires evidence before success', () => {
  let now = 1000;
  const mc = new MissionControl({ now: () => now });
  const mission = mc.createMission('deploy', { id: 'm1', steps: [{ id: 'build', description: 'build' }, { id: 'ship', description: 'ship', dependsOn: ['build'] }] });
  assert.equal(mc.claimNext(mission.id).id, 'build');
  mc.submitResult('m1', 'build', 'ok');
  assert.equal(mc.verifyStep('m1', 'build', { ok: true }).status, 'retry_wait');
  now += 5000;
  assert.equal(mc.claimNext('m1').id, 'build');
  mc.submitResult('m1', 'build', 'ok', { type: 'command-exit', value: 0 });
  assert.equal(mc.verifyStep('m1', 'build', { ok: true, method: 'exit-code' }).status, 'verified');
  assert.equal(mc.claimNext('m1').id, 'ship');
});

test('idempotency returns existing mission and bounded retry eventually fails', () => {
  let now = 0;
  const mc = new MissionControl({ now: () => now, retryBaseMs: 10, defaultMaxAttempts: 2 });
  const first = mc.createMission('send', { idempotencyKey: 'send:42' });
  const duplicate = mc.createMission('send again', { idempotencyKey: 'send:42' });
  assert.equal(first.id, duplicate.id);
  let step = mc.claimNext(first.id);
  mc.failStep(first.id, step.id, 'network');
  now = 10; step = mc.claimNext(first.id);
  mc.failStep(first.id, step.id, 'network');
  assert.equal(mc.getMission(first.id).status, 'failed');
  assert.equal(mc.claimNext(first.id), null);
});

test('persistent state resumes and expired worker lease is recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mission-'));
  const file = path.join(dir, 'state.json');
  let now = 100;
  const first = new MissionControl({ file, now: () => now, leaseMs: 50, retryBaseMs: 1 });
  const mission = first.createMission('work', { id: 'resume-me' });
  first.claimNext(mission.id, 'dead-worker');
  now = 200;
  const resumed = new MissionControl({ file, now: () => now, leaseMs: 50, retryBaseMs: 1 });
  assert.equal(resumed.recoverStale(), 1);
  assert.equal(resumed.claimNext(mission.id, 'new-worker').attempts, 2);
  assert.equal(fs.existsSync(file.replace(/\.json$/, '.jsonl')), true);
});

test('stable ids are deterministic and do not expose input', () => {
  assert.equal(stableId('x', 'same'), stableId('x', 'same'));
  assert.equal(stableId('x', 'secret').includes('secret'), false);
});

test('dependency cycles are rejected before execution', () => {
  const mc = new MissionControl();
  assert.throws(() => mc.createMission('cycle', { steps: [
    { id: 'a', description: 'a', dependsOn: ['b'] },
    { id: 'b', description: 'b', dependsOn: ['a'] }
  ] }), /Dependency cycle/);
});