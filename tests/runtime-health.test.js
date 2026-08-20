'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectRuntimeOwner, inspectVoiceOwnership } = require('../core/runtime-health');

test('runtime owner requires fresh heartbeat, live PID and matching command', () => {
  const owner = inspectRuntimeOwner({
    pid: 42,
    components: { 'voice-daemon': { ageMs: 1200, pid: 42 } }
  }, {
    pidAlive: pid => pid === 42,
    commandForPid: () => '/opt/homebrew/bin/node /repo/jarvis_daemon.js'
  });
  assert.equal(owner.healthy, true);
});

test('stale or foreign runtime snapshot is not healthy', () => {
  const stale = inspectRuntimeOwner({
    pid: 42,
    components: { 'voice-daemon': { ageMs: 20000, pid: 99 } }
  }, { pidAlive: () => true, commandForPid: () => 'node /repo/jarvis_daemon.js' });
  assert.equal(stale.healthy, false);
  assert.equal(stale.heartbeatOwnsSnapshot, false);
});

test('runtime PID fills pgrep blind spot and validates worker parent', () => {
  const ownership = inspectVoiceOwnership({
    daemonPids: [],
    wakePids: [77],
    parentPid: () => 42,
    runtimeOwner: { healthy: true, pid: 42 }
  });
  assert.deepEqual(ownership.daemonPids, [42]);
  assert.equal(ownership.healthy, true);
});

test('orphan wake worker makes ownership unhealthy', () => {
  const ownership = inspectVoiceOwnership({ daemonPids: [42], wakePids: [77], parentPid: () => 1 });
  assert.deepEqual(ownership.orphanWakePids, [77]);
  assert.equal(ownership.healthy, false);
});