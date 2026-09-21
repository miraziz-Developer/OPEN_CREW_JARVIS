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
  for (const ownerId of ['', undefined, '-123', 'owner', '0', '1.5']) {
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
test('multiple owners are each trusted in their own private chat, everyone else is ignored', () => {
  const { parseOwnerIds } = require('../core/telegram-owner');
  assert.deepEqual(parseOwnerIds('111111111', '111111111, 222222222;abc,0'), ['111111111', '222222222']);
  const dispatched = [];
  const handler = createOwnerUpdateHandler({ ownerId: '111111111', ownerIds: '222222222', dispatch: update => dispatched.push(update.id) });
  const message = (id, chat = id, type = 'private') => ({ id: `${id}/${chat}`, message: { text: 'hi', chat: { id: chat, type }, from: { id, is_bot: false } } });
  assert.equal(handler(message(111111111)), true);
  assert.equal(handler(message(222222222)), true);
  assert.equal(handler(message(111)), false);
  assert.equal(handler(message(222222222, -100, 'group')), false);
  assert.equal(handler(message(222222222, 111111111)), false);
  assert.deepEqual(dispatched, ['111111111/111111111', '222222222/222222222']);
});
