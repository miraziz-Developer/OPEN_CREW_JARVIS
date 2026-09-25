#!/usr/bin/env node
'use strict';

const path = require('path');
const { PROJECT_DIR } = require('../core/paths');
const { ActionFailureCorpus } = require('../core/action-failure-corpus');
const { verifyActionResult } = require('../core/action-result');
const { planCommand } = require('../core/mission-planner');
const { VisualActionLoop } = require('../core/visual-action-loop');

const DEFAULT_FILE = path.join(PROJECT_DIR, 'benchmarks', 'action-corpus.json');

async function replayVisualCase(item) {
  const fixture = item.fixture || {};
  const observations = [...(fixture.observations || [])];
  const semanticMatches = [...(fixture.semanticMatches || [])];
  const visualMatches = [...(fixture.visualMatches || [])];
  const counters = { semanticActs: 0, visualActs: 0, visualCenters: [] };
  const snapshot = title => ({ app: 'Benchmark Fixture', window: { title: title || 'Before' }, focus: null });
  const loop = new VisualActionLoop({
    observe: async () => snapshot(observations.shift()),
    inspect: async () => semanticMatches.shift() || [],
    locateVisual: async () => visualMatches.shift() || [],
    actSemantic: async () => { counters.semanticActs++; return { status: 'ok' }; },
    actVisual: async ({ target }) => {
      counters.visualActs++;
      counters.visualCenters.push(target.center.x);
      return { status: 'ok' };
    },
    authorize: () => ({ allowed: true, assessment: { risk: 'low' } })
  });
  const result = await loop.run(item.request);
  return {
    status: result.status,
    verified: verifyActionResult(result).verification.passed,
    evidenceType: result.evidence[0]?.type || null,
    attempts: result.actions.length,
    ...counters
  };
}

async function replayCase(item) {
  if (item.kind === 'visual') return replayVisualCase(item);
  if (item.kind === 'planner') return planCommand(item.input).steps.map(step => step.description);
  return verifyActionResult(item.input).verification.passed;
}

async function runActionBenchmark(options = {}) {
  const file = options.file || DEFAULT_FILE;
  const cases = new ActionFailureCorpus({ file }).load().cases;
  const rows = [];
  for (const item of cases) {
    const actual = await replayCase(item);
    rows.push({ id: item.id, kind: item.kind || 'verifier', expected: item.expected, actual, passed: JSON.stringify(actual) === JSON.stringify(item.expected) });
  }
  const passed = rows.filter(row => row.passed).length;
  const report = { total: rows.length, passed, failed: rows.length - passed, rows };
  return { ...report, file, ok: report.total > 0 && report.failed === 0 };
}

async function main(args = process.argv.slice(2), logger = console) {
  const fileArg = args.find(argument => argument.startsWith('--file='));
  const file = fileArg ? path.resolve(fileArg.slice('--file='.length)) : DEFAULT_FILE;
  const report = await runActionBenchmark({ file });
  for (const row of report.rows) logger.log(`${row.passed ? '✅' : '❌'} ${row.id} (${row.kind})`);
  logger.log(`Action replay: ${report.passed}/${report.total} passed; ${report.failed} failed.`);
  if (report.total === 0) logger.error(`Action replay corpus is empty: ${file}`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) main().catch(error => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { DEFAULT_FILE, replayVisualCase, runActionBenchmark, main };