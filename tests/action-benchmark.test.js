'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_FILE, runActionBenchmark, main } = require('../scripts/action-benchmark');

test('default action benchmark executes deterministic visual executor regressions', async () => {
  const report = await runActionBenchmark();
  assert.equal(report.file, DEFAULT_FILE);
  assert.equal(report.total, 5);
  assert.equal(report.passed, 5);
  assert.equal(report.failed, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.rows.map(row => row.id), [
    'visual-accessibility-verified',
    'visual-fallback-verified',
    'visual-retry-relocalizes',
    'visual-ambiguous-target-blocked',
    'completion-without-evidence-rejected'
  ]);
  assert.deepEqual(report.rows[2].actual.visualCenters, [100, 140]);
});

test('action benchmark rejects an empty corpus instead of reporting a vacuous pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-empty-action-corpus-'));
  const file = path.join(dir, 'empty.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, cases: [] }));
  const previousExitCode = process.exitCode;
  const messages = [];
  try {
    process.exitCode = undefined;
    const report = await main([`--file=${file}`], { log: message => messages.push(message), error: message => messages.push(message) });
    assert.equal(report.total, 0);
    assert.equal(report.ok, false);
    assert.equal(process.exitCode, 1);
    assert.match(messages.join('\n'), /corpus is empty/);
  } finally {
    process.exitCode = previousExitCode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});