'use strict';
// No live OAuth or email delivery is used in these regression tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGmailTaskNotifier } = require('../core/gmail-task-notifier');

test('Gmail task notifier sends automatic reports only to the configured owner', async () => {
  const sent = [];
  const notifier = createGmailTaskNotifier({ enabled: true, ownerRecipient: 'Owner@Example.com', gmail: {
    sendMessage: async (to, subject, body) => { sent.push({ to, subject, body }); return { status: 'ok', id: 'mail-1' }; },
    listMessages: async () => ({ status: 'ok', messages: [] })
  } });
  const result = await notifier.notify('completed', { id: 'task-1', status: 'completed', request: 'Finish report' }, 'Done');
  assert.equal(result.sent, true);
  assert.deepEqual(sent.map(entry => entry.to), ['owner@example.com']);
  assert.equal(notifier.ownerRecipient, 'owner@example.com');
});

test('Gmail task progress notifications are rate-limited and inbox summaries remain read-only', async () => {
  const sent = [];
  let listed = 0;
  const notifier = createGmailTaskNotifier({ enabled: true, ownerRecipient: 'owner@example.com', cadenceMs: 60000, gmail: {
    sendMessage: async (...args) => { sent.push(args); return { status: 'ok', id: 'mail-2' }; },
    listMessages: async () => { listed++; return { status: 'ok', messages: [{ from: 'a@example.com', subject: 'Hello', date: 'today', snippet: ' Important update ', unread: true }] }; }
  } });
  const task = { id: 'task-2', status: 'running', request: 'Long task' };
  assert.equal((await notifier.notifyProgress(task, 'one', 100000)).sent, true);
  assert.equal((await notifier.notifyProgress(task, 'two', 110000)).reason, 'cadence');
  const summary = await notifier.summarizeInbox();
  assert.equal(sent.length, 1);
  assert.equal(listed, 1);
  assert.deepEqual(summary.messages[0], { from: 'a@example.com', subject: 'Hello', date: 'today', summary: 'Important update', unread: true });
});

test('disabled and invalid owner configuration never access Gmail', async () => {
  const gmail = { sendMessage: () => assert.fail('must not send'), listMessages: () => assert.fail('must not list') };
  for (const options of [{ enabled: false, ownerRecipient: 'owner@example.com' }, ...['', 'invalid', 'a@example.com,b@example.com', 'a@example.com\r\nBcc:b@example.com'].map(ownerRecipient => ({ enabled: true, ownerRecipient }))]) {
    const notifier = createGmailTaskNotifier({ ...options, gmail });
    assert.equal((await notifier.notify('completed', {})).sent, false);
    assert.equal((await notifier.summarizeInbox()).status, 'disabled');
  }
});

test('Gmail errors and timeouts never advance successful progress cadence', async () => {
  for (const sendMessage of [async () => ({ status: 'error', message: 'OAuth missing' }), async () => { throw new Error('network offline'); }, () => new Promise(() => {})]) {
    const notifier = createGmailTaskNotifier({ enabled: true, ownerRecipient: 'owner@example.com', timeoutMs: 10, gmail: { sendMessage } });
    const task = { id: 'fixture' };
    await assert.rejects(notifier.notifyProgress(task, 'progress'), /OAuth missing|network offline|timed out/);
    assert.equal(task.lastEmailProgressAt, undefined);
  }
});

test('inbox errors propagate and bounded read-only summaries cannot override the recipient', async () => {
  let args; let recipient;
  const notifier = createGmailTaskNotifier({ enabled: true, ownerRecipient: 'owner@example.com', gmail: {
    listMessages: async (...input) => { args = input; return { status: 'error', message: 'OAuth required' }; },
    sendMessage: async to => { recipient = to; return { status: 'ok' }; }
  } });
  assert.equal((await notifier.summarizeInbox({ maxResults: 9999 })).status, 'error');
  assert.equal(args[1], 20);
  assert.match(args[0], /in:inbox/);
  await notifier.notify('completed', { to: 'stranger@example.com', ownerRecipient: 'stranger@example.com' });
  assert.equal(recipient, 'owner@example.com');
});