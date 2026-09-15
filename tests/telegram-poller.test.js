'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramPoller } = require('../core/telegram-poller');

test('native Telegram poller forwards updates and advances the offset', async () => {
  const calls = [];
  const received = [];
  let resolveSecondCall;
  const secondCall = new Promise(resolve => { resolveSecondCall = resolve; });
  const poller = createTelegramPoller({
    token: 'test-token',
    log: { log() {}, error() {} },
    telegramRequest: async (_token, method, params) => {
      calls.push({ method, params });
      if (calls.length === 1) return [{ update_id: 41, message: { text: 'hello' } }];
      resolveSecondCall();
      return new Promise(() => {});
    },
    onUpdate: update => received.push(update)
  });

  poller.start();
  await secondCall;
  poller.stop();

  assert.deepEqual(received.map(update => update.update_id), [41]);
  assert.equal(calls[0].method, 'getUpdates');
  assert.equal(calls[0].params.offset, 0);
  assert.equal(calls[1].params.offset, 42);
});

test('native Telegram poller isolates update processing failures', async () => {
  const errors = [];
  let resolveSecondCall;
  const secondCall = new Promise(resolve => { resolveSecondCall = resolve; });
  let callCount = 0;
  const poller = createTelegramPoller({
    token: 'test-token',
    log: { log() {}, error(...args) { errors.push(args.join(' ')); } },
    telegramRequest: async () => {
      callCount++;
      if (callCount === 1) return [{ update_id: 7, message: { text: 'hello' } }];
      resolveSecondCall();
      return new Promise(() => {});
    },
    onUpdate: () => { throw new Error('handler broke'); }
  });

  poller.start();
  await secondCall;
  poller.stop();

  assert.equal(errors.some(line => line.includes('handler broke')), true);
});

test('native Telegram poller aborts an active long poll when stopped', async () => {
  let signal;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const poller = createTelegramPoller({
    token: 'test-token',
    log: { log() {}, error() {} },
    telegramRequest: async (_token, _method, _params, options) => {
      signal = options.signal;
      requestStarted();
      return new Promise(() => {});
    },
    onUpdate() {}
  });

  poller.start();
  await started;
  poller.stop();

  assert.equal(signal.aborted, true);
});