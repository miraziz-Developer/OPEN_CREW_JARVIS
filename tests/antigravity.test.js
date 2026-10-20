'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeAgy(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
  const file = path.join(dir, 'agy');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

function freshSkill(agyPath) {
  process.env.AGY_PATH = agyPath;
  delete require.cache[require.resolve('../skills/antigravity')];
  return require('../skills/antigravity');
}

test.afterEach(() => { delete process.env.AGY_PATH; });

test('antigravity: a signed-out CLI raises instead of returning the banner as an answer', async () => {
  const skill = freshSkill(fakeAgy(`echo "Error: authentication required. Run 'agy' to log in, then retry." >&2; exit 1`));
  await assert.rejects(skill.executePrompt('hello', { timeoutMs: 5000 }), { name: 'AntigravityUnavailableError' });
  assert.equal(skill.status().available, false);
});

test('antigravity: after a sign-in failure, later calls fail fast without spawning agy', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-marker-')), 'spawned');
  const skill = freshSkill(fakeAgy(`touch "${marker}"; echo "authentication required" >&2; exit 1`));
  await assert.rejects(skill.executePrompt('first', { timeoutMs: 5000 }));
  fs.unlinkSync(marker);
  await assert.rejects(skill.executePrompt('second', { timeoutMs: 5000 }), { name: 'AntigravityUnavailableError' });
  assert.equal(fs.existsSync(marker), false);
});

test('antigravity: a non-zero exit is an error, a clean exit returns stdout', async () => {
  const failing = freshSkill(fakeAgy('echo "boom" >&2; exit 3'));
  await assert.rejects(failing.executePrompt('x', { timeoutMs: 5000 }), /exited with code 3/);

  const ok = freshSkill(fakeAgy('echo "all good"'));
  assert.deepEqual(await ok.executePrompt('x', { timeoutMs: 5000 }), { status: 'ok', output: 'all good', exitCode: 0 });
});

test('antigravity: createProject rejects path-traversal names', async () => {
  const skill = freshSkill(fakeAgy('echo ok'));
  await assert.rejects(skill.createProject('../../etc', 'x'), /Project name/);
});
