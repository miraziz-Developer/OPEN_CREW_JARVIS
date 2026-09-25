'use strict';

const fs = require('fs');
const path = require('path');
const { FAILURE_TEXT, normalizeActionResult, verifyActionResult } = require('./action-result');
const { planCommand } = require('./mission-planner');

class ActionFailureCorpus {
  constructor(options = {}) {
    this.file = options.file || null;
    this.maxCases = options.maxCases || 500;
  }

  load() {
    if (!this.file) return { version: 1, cases: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { version: 1, cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
    } catch (_) { return { version: 1, cases: [] }; }
  }

  record(testCase) {
    if (!this.file) return null;
    const corpus = this.load();
    const entry = { id: testCase.id || `failure-${Date.now()}`, capturedAt: Date.now(), ...testCase };
    corpus.cases.push(entry);
    corpus.cases = corpus.cases.slice(-this.maxCases);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(corpus, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return entry;
  }

  replay() {
    const cases = this.load().cases;
    const rows = cases.map(item => {
      let actual;
      if (item.kind === 'planner') actual = planCommand(item.input).steps.map(step => step.description);
      else actual = verifyActionResult(item.input).verification.passed;
      return { id: item.id, kind: item.kind || 'verifier', expected: item.expected, actual, passed: JSON.stringify(actual) === JSON.stringify(item.expected) };
    });
    return { total: rows.length, passed: rows.filter(row => row.passed).length, failed: rows.filter(row => !row.passed).length, rows };
  }
}

function sanitizeVerifierFailure(value) {
  const result = normalizeActionResult(value);
  return {
    status: result.status,
    actions: result.actions.map(action => ({ id: action.id, status: action.status, description: '[redacted]' })),
    verification: { passed: result.verification.passed, method: result.verification.method },
    evidence: result.evidence.map(item => ({
      type: item.type,
      value: item.type === 'command-exit' ? item.value : '[redacted]',
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {})
    })),
    summary: FAILURE_TEXT.test(`${result.summary} ${result.error || ''}`) ? "I can't complete this action." : '',
    error: result.error ? '[redacted]' : null
  };
}

module.exports = { ActionFailureCorpus, sanitizeVerifierFailure };