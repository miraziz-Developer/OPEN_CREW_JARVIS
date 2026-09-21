'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runProcess, cleanOutput } = require('../core/workers');

test('runProcess kills a silent (stalled) process quickly instead of waiting for the full timeout', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 20000, stallMs: 400 });
  assert.equal(result.stalled, true);
  assert.ok(Date.now() - started < 5000);
});

test('runProcess feeds stdin, captures output and reports the exit code', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdin.on('data', d => process.stdout.write('echo:' + d))"], { input: 'hello', timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /echo:hello/);
});

test('runProcess enforces the hard timeout even when the process keeps printing', async () => {
  const result = await runProcess(process.execPath, ['-e', "setInterval(() => console.log('tick'), 50)"], { timeoutMs: 600, stallMs: 5000 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.stalled, true);
});

test('cleanOutput strips ANSI colors and Python warnings', () => {
  assert.equal(cleanOutput('\x1b[31mred\x1b[0m\nUserWarning: pkg_resources is deprecated\n\nvalue'), 'red\nvalue');
});
