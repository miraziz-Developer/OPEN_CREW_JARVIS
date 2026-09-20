'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner, retryDelay } = require('../core/persistent-agent-runner');

test('persistent runner pauses tasks after the configured recovery window', async () => {
  let saved;
  const task = { id: 'aabbccddeeff0011', persistent: true, status: 'retrying', createdAt: new Date(0).toISOString(), steps: [] };
  const runner = createRunner({
    now: () => 10000, retryWindowMs: 1000,
    bridge: { checkpoints: { save: value => { saved = value; }, list: () => [task] } }
  });
  assert.equal(await runner.recoverTask(task), false);
  assert.equal(saved.status, 'paused');
});

test('persistent runner does not resume a fresh running step', async () => {
  let resumed = false;
  const now = 10000;
  const task = {
    id: 'aabbccddeeff0013',
    persistent: true,
    status: 'running',
    createdAt: new Date(0).toISOString(),
    steps: [{ status: 'running', startedAt: new Date(now - 500).toISOString() }]
  };
  const bridge = {
    checkpoints: { save() {}, list: () => [task] },
    resumePersistentTask: async () => { resumed = true; },
    sendTelegram: async () => true
  };
  const runner = createRunner({ now: () => now, staleRunningMs: 1000, bridge });
  assert.equal(await runner.recoverTask(task), false);
  assert.equal(resumed, false);
  assert.equal(task.retryCount, undefined);
});

test('persistent runner resumes stale steps and retains recovery-safe task state', async () => {
  let resumed;
  const task = { id: 'aabbccddeeff0012', persistent: true, status: 'running', createdAt: new Date(0).toISOString(), steps: [{ status: 'running', startedAt: new Date(0).toISOString() }] };
  const bridge = {
    checkpoints: { save() {}, list: () => [task] },
    resumePersistentTask: async value => { resumed = value; value.status = 'completed'; }, sendTelegram: async () => true
  };
  const runner = createRunner({ now: () => 10000, staleRunningMs: 1000, bridge });
  assert.equal(await runner.recoverTask(task), true);
  assert.equal(resumed, task);
  assert.equal(task.retryCount, 1);
});

test('persistent retry backoff follows the documented schedule', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(retryDelay), [5000, 15000, 45000, 135000, 135000]);
});

test('persistent runner supports a multi-day recovery window', async () => {
  let resumed = false;
  const now = 20 * 24 * 60 * 60 * 1000;
  const task = { id: 'aabbccddeeff0014', persistent: true, status: 'retrying', createdAt: new Date(0).toISOString(), nextRetryAt: new Date(0).toISOString(), steps: [] };
  const bridge = { checkpoints: { save() {}, list: () => [task] }, resumePersistentTask: async () => { resumed = true; }, sendTelegram: async () => true };
  const runner = createRunner({ now: () => now, retryWindowMs: 30 * 24 * 60 * 60 * 1000, bridge });
  assert.equal(await runner.recoverTask(task), true);
  assert.equal(resumed, true);
});

test('persistent runner never automatically resumes a task awaiting approval', async () => {
  let resumed = false;
  const task = { id: 'aabbccddeeff0015', persistent: true, status: 'paused-awaiting-approval', createdAt: new Date(0).toISOString(), steps: [] };
  const bridge = { checkpoints: { save() {}, list: () => [task] }, resumePersistentTask: async () => { resumed = true; } };
  const runner = createRunner({ now: () => 10000, bridge });
  assert.equal(await runner.recoverTask(task), false);
  assert.equal(resumed, false);
});

test('successful progress email timestamp survives checkpoint persistence', async () => {
  const task = { id: 'aabbccddeeff0031', persistent: true, status: 'retrying', createdAt: new Date(0).toISOString(), steps: [] };
  let saved;
  const runner = createRunner({ now: () => 10000, openClawEnvironment: {},
    bridge: { checkpoints: { save: value => { saved = structuredClone(value); } }, resumePersistentTask: async (value, options) => { await options.onProgress('working'); } },
    notifier: { notifyProgress: async snapshot => { snapshot.lastEmailProgressAt = new Date(10000).toISOString(); return { sent: true }; } }
  });
  await runner.recoverTask(task);
  assert.equal(saved.lastEmailProgressAt, new Date(10000).toISOString());
});

test('Telegram failure or timeout cannot suppress terminal Gmail reports', async () => {
  for (const sendTelegram of [async () => { throw new Error('offline'); }, () => new Promise(() => {})]) {
    const task = { id: 'aabbccddeeff0032', persistent: true, status: 'retrying', createdAt: new Date(0).toISOString(), steps: [] };
    const reports = [];
    const runner = createRunner({ now: () => 10000, openClawEnvironment: {}, notificationTimeoutMs: 10,
      bridge: { checkpoints: { save() {} }, resumePersistentTask: async value => { value.status = 'completed'; }, sendTelegram },
      notifier: { notify: async kind => { reports.push(kind); return { sent: true }; } }
    });
    await runner.recoverTask(task);
    await runner.recoverTask(task);
    assert.deepEqual(reports, ['completed']);
    assert.equal(task.lastEmailReportedStatus, 'completed');
    assert.equal(runner.active.size, 0);
  }
});

test('blocked and approval states report without execution and failed delivery remains retryable', async () => {
  for (const status of ['blocked', 'failed', 'paused-awaiting-approval', 'cancelled']) {
    const task = { id: 'aabbccddeeff0033', persistent: true, status, steps: [] };
    let calls = 0;
    const runner = createRunner({ openClawEnvironment: {},
      bridge: { checkpoints: { save() {} }, resumePersistentTask: () => assert.fail('must not resume') },
      notifier: { notify: async () => { if (++calls === 1) throw new Error('offline'); return { sent: true }; } }
    });
    await runner.recoverTask(task);
    assert.equal(task.lastEmailReportedStatus, undefined);
    await runner.recoverTask(task);
    assert.equal(task.lastEmailReportedStatus, status);
    assert.equal(calls, 2);
  }
});

test('unexpected recovery errors persist failure and do not prevent other tasks from recovering', async () => {
  const tasks = ['aabbccddeeff0034', 'aabbccddeeff0035'].map(id => ({ id, persistent: true, status: 'retrying', createdAt: new Date(0).toISOString(), steps: [] }));
  const reports = [];
  const runner = createRunner({ now: () => 10000, openClawEnvironment: {},
    bridge: { checkpoints: { list: () => tasks, save() {} }, resumePersistentTask: async task => { if (task === tasks[0]) throw new Error('permission denied'); task.status = 'completed'; } },
    notifier: { notify: async kind => { reports.push(kind); return { sent: true }; } }
  });
  await runner.scan();
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[1].status, 'completed');
  assert.deepEqual(reports.sort(), ['completed', 'failed']);
});