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

test('the worker registry exposes every worker the planner may choose, including BabyAGI and AutoGPT', () => {
  const { createWorkers } = require('../core/workers');
  const { WORKERS } = require('../core/missions/engine');
  const workers = createWorkers({ env: () => '' });
  for (const name of WORKERS) assert.equal(typeof workers[name]?.run, 'function', name);
  assert.ok(WORKERS.includes('babyagi') && WORKERS.includes('autogpt'));
});

test('BabyAGI and AutoGPT workers report a clear error when their environments are missing', async () => {
  const { createWorkers } = require('../core/workers');
  const workers = createWorkers({ env: () => '' });
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  for (const [name, venv] of [['babyagi', '.venv-babyagi'], ['autogpt', '.venv-autogpt']]) {
    if (fs.existsSync(path.join(root, venv, 'bin', 'python'))) continue;
    const result = await workers[name].run({ prompt: 'x', mission: { id: 'm-test' }, task: { id: 't1' }, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /o'rnatilmagan/);
  }
});

test('the browser worker uses the signed-in JARVIS Chrome profile by default and is visible', async () => {
  const { createWorkers } = require('../core/workers');
  const EventEmitter = require('node:events');
  let sentInput = '';
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdin = { write: text => { sentInput += text; }, end() {} };
    proc.pid = 0; proc.kill = () => {};
    process.nextTick(() => { proc.stdout.emit('data', Buffer.from('{"ok": true, "output": "done"}')); proc.emit('close', 0); });
    return proc;
  };
  const fs = require('node:fs');
  const path = require('node:path');
  if (!fs.existsSync(path.join(__dirname, '..', '.venv-workers', 'bin', 'python'))) return;
  const result = await createWorkers({ env: () => '', spawn }).browser.run({ prompt: 'open linkedin', timeoutMs: 5000 });
  assert.equal(result.ok, true);
  const request = JSON.parse(sentInput);
  assert.equal(request.use_profile, true);
  assert.equal(request.headless, false);
});
