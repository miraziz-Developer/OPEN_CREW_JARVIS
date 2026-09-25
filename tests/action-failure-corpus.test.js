'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActionFailureCorpus, sanitizeVerifierFailure } = require('../core/action-failure-corpus');

test('recorded production failures replay as deterministic verifier and planner regressions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-action-corpus-'));
  const corpus = new ActionFailureCorpus({ file: path.join(dir, 'failures.json') });
  corpus.record({ id: 'refusal', kind: 'verifier', input: "I can't do that directly.", expected: false });
  corpus.record({ id: 'sequence', kind: 'planner', input: 'open Safari, keyin screenshot ol', expected: ['open Safari', 'screenshot ol'] });
  assert.deepEqual(corpus.replay(), {
    total: 2, passed: 2, failed: 0,
    rows: [
      { id: 'refusal', kind: 'verifier', expected: false, actual: false, passed: true },
      { id: 'sequence', kind: 'planner', expected: ['open Safari', 'screenshot ol'], actual: ['open Safari', 'screenshot ol'], passed: true }
    ]
  });
});

test('production failure sanitizer preserves the regression class without retaining user data', () => {
  const sanitized = sanitizeVerifierFailure({
    status: 'completed', verification: { passed: true, method: 'agent' },
    actions: [{ description: 'Open private customer record', status: 'completed' }],
    evidence: [{ type: 'accessibility', value: 'Secret Account Name' }],
    summary: "I can't open Secret Account Name; you'll need to do it manually."
  });
  assert.equal(sanitized.actions[0].description, '[redacted]');
  assert.equal(sanitized.evidence[0].value, '[redacted]');
  assert.doesNotMatch(JSON.stringify(sanitized), /Secret Account Name/);
  assert.equal(require('../core/action-result').verifyActionResult(sanitized).verification.passed, false);
});