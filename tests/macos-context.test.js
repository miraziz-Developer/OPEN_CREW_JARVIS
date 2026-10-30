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

test('background (light) context never reads the focused element or enumerates windows', async () => {
  const { LIGHT_CONTEXT_SCRIPT, CONTEXT_SCRIPT } = require('../core/macos-context');
  assert.doesNotMatch(LIGHT_CONTEXT_SCRIPT, /AXFocusedUIElement|proc\.windows\(\)/);
  assert.match(LIGHT_CONTEXT_SCRIPT, /AXFocusedWindow/);
  assert.match(CONTEXT_SCRIPT, /AXFocusedUIElement/, 'action verification keeps the full script');
  let script = '';
  const execFile = (cmd, args, opts, cb) => { script = args[3]; cb(null, '{"app":"Google Chrome"}', ''); };
  await collectMacOSContextAsync({ execFile, light: true });
  assert.equal(script, LIGHT_CONTEXT_SCRIPT);
});
