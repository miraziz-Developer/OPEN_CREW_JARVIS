'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectMacOSContextAsync } = require('../core/macos-context');

test('async macOS context does not block and parses the JXA result', async () => {
  let callbackRanSync = true;
  const execFile = (cmd, args, opts, cb) => { setImmediate(() => cb(null, '{"app":"Safari","window":{"title":"x"}}', '')); };
  const pending = collectMacOSContextAsync({ execFile });
  callbackRanSync = false;
  const context = await pending;
  assert.equal(callbackRanSync, false);
  assert.equal(context.app, 'Safari');
});

test('async macOS context reports missing permissions clearly', async () => {
  const execFile = (cmd, args, opts, cb) => cb(new Error('exit 1'), '', 'execution error: Not authorized to send Apple events (-1743)');
  await assert.rejects(collectMacOSContextAsync({ execFile }), /Accessibility or Automation permission required/);
});
