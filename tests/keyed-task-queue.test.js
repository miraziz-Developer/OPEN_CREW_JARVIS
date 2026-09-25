'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyedTaskQueue } = require('../core/keyed-task-queue');

test('keyed task queue serializes one chat while allowing another chat to run', async () => {
  const queue = createKeyedTaskQueue();
  const events = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = queue.enqueue('chat-a', async () => { events.push('a1-start'); await blocked; events.push('a1-end'); });
  const second = queue.enqueue('chat-a', async () => { events.push('a2'); });
  await queue.enqueue('chat-b', async () => { events.push('b1'); });
  assert.deepEqual(events, ['a1-start', 'b1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
  assert.equal(queue.size(), 0);
});

test('keyed task queue continues after a failed task', async () => {
  const queue = createKeyedTaskQueue();
  const failed = queue.enqueue('chat', async () => { throw new Error('broken'); });
  const next = queue.enqueue('chat', async () => 'continued');
  await assert.rejects(failed, /broken/);
  assert.equal(await next, 'continued');
});