#!/usr/bin/env node
'use strict';

const path = require('path');
const { PROJECT_DIR } = require('../core/paths');
const { ActionFailureCorpus } = require('../core/action-failure-corpus');

const fileArg = process.argv.find(argument => argument.startsWith('--file='));
const file = fileArg ? path.resolve(fileArg.slice('--file='.length)) : path.join(PROJECT_DIR, '.run', 'action-failures.json');
const report = new ActionFailureCorpus({ file }).replay();

for (const row of report.rows) console.log(`${row.passed ? '✅' : '❌'} ${row.id} (${row.kind})`);
console.log(`Action replay: ${report.passed}/${report.total} passed; ${report.failed} failed.`);
if (report.failed > 0) process.exitCode = 1;

module.exports = { file };