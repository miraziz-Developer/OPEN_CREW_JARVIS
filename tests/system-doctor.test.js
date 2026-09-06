'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheck, evaluateRuntime, isPrivateFileMode, summarize } = require('../core/system-doctor');

test('private file modes reject group and world access', () => {
  assert.equal(isPrivateFileMode(0o600), true);
  assert.equal(isPrivateFileMode(0o400), true);
  assert.equal(isPrivateFileMode(0o640), false);
  assert.equal(isPrivateFileMode(0o604), false);
});

test('summary distinguishes warnings, errors and strict mode', () => {
  const checks = [createCheck('a', 'ok', 'yes'), createCheck('b', 'warn', 'maybe')];
  assert.deepEqual(summarize(checks), { healthy: true, strict: false, counts: { ok: 1, warn: 1, error: 0 }, total: 2 });
  assert.equal(summarize(checks, { strict: true }).healthy, false);
  assert.equal(summarize([...checks, createCheck('c', 'error', 'no')]).healthy, false);
});

test('runtime evaluation validates PID, command and heartbeat ownership', () => {
  const healthy = evaluateRuntime({ pid: 42, components: { 'voice-daemon': { pid: 42, ageMs: 100 } } }, {
    pidAlive: () => true,
    commandForPid: () => 'node /repo/jarvis_daemon.js'
  });
  assert.equal(healthy.status, 'ok');

  const stale = evaluateRuntime({ pid: 42, components: { 'voice-daemon': { pid: 42, ageMs: 20000 } } }, {
    pidAlive: () => true,
    commandForPid: () => 'node /repo/jarvis_daemon.js'
  });
  assert.equal(stale.status, 'error');
});

test('check constructor rejects unknown statuses', () => {
  assert.throws(() => createCheck('bad', 'unknown', 'x'), /Noma’lum doctor status/);
});