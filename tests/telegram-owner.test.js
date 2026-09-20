'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwnerUpdateHandler, createOwnerTaskCommands } = require('../core/telegram-owner');

const message = (extra = {}) => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/tasks', ...extra });

test('owner gate blocks every unauthorized command and media update before dispatch', () => {
  const dispatched = [];
  const handler = createOwnerUpdateHandler({ ownerId: '123', dispatch: update => dispatched.push(update) });
  for (const content of [{ text: '/start' }, { text: '/approve aabbccddeeff0011' }, { text: 'send a screenshot' }, { voice: {} }, { video_note: {} }, { document: {} }, { photo: [] }]) {
    for (const identity of [{ from: { id: 456 } }, { chat: { id: -123, type: 'group' } }, { chat: { id: 123, type: 'supergroup' } }, { from: { id: 123, is_bot: true } }, { from: null }, { chat: { id: 456, type: 'private' } }]) {
      assert.equal(handler({ message: message({ ...content, ...identity }) }), false);
    }
    assert.equal(handler({ message: message(content) }), true);
  }
  const count = dispatched.length;
  for (const update of [{ edited_message: message() }, { channel_post: message() }, { callback_query: { message: message() } }, {}, null]) assert.equal(handler(update), false);
  assert.equal(dispatched.length, count);
});

test('owner gate fails closed without a positive private owner ID', () => {
  for (const ownerId of ['', undefined, '-123', '123,456', 'owner', '0']) {
    const handler = createOwnerUpdateHandler({ ownerId, dispatch: () => assert.fail('must not dispatch') });
    assert.equal(handler({ message: message() }), false);
  }
});

test('owner commands validate task IDs, route explicit approval/rejection, and summarize inbox read-only', async () => {
  const approvals = []; const replies = [];
  const command = createOwnerTaskCommands({
    bridge: { checkpoints: { list: () => [{ id: 'aabbccddeeff0011', status: 'paused-awaiting-approval' }] }, approvePersistentTask: async (...args) => { approvals.push(args); return 'updated'; } },
    notifier: { summarizeInbox: async () => ({ status: 'ok', messages: [{ from: 'owner', subject: 'Test', summary: 'Summary' }] }) },
    send: async (id, text) => replies.push({ id, text })
  });
  for (const text of ['/tasks', '/inbox', '/approve invalid', '/approve aabbccddeeff0011', '/reject aabbccddeeff0011']) assert.equal(await command(message({ text })), true);
  assert.equal(await command(message({ text: 'ordinary request' })), false);
  assert.equal(approvals.length, 2);
  assert.deepEqual(approvals.map(call => call[1]), [{ approved: true, source: 'telegram-owner' }, { approved: false, source: 'telegram-owner' }]);
  assert.match(replies[1].text, /Summary/);
  assert.match(replies[2].text, /Usage/);
});