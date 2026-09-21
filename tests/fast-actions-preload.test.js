'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('fast actions are available synchronously even on the very first require (no empty tool enum)', () => {
  const script = "const fa=require('./skills/fast-actions');process.stdout.write(String(fa.loadActions().length))";
  const count = Number(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
  assert.ok(count > 50, `expected the base action list, got ${count}`);
});
