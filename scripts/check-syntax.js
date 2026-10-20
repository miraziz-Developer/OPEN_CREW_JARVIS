#!/usr/bin/env node
'use strict';

/**
 * Syntax-checks every tracked JavaScript file (node --check), so new files are
 * covered automatically instead of being listed by hand in package.json.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '*.js'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(file => file && !file.startsWith('node_modules/'));

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${file}\n${result.stderr.trim()}`);
}

if (failures.length) {
  console.error(`Syntax errors in ${failures.length} file(s):\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} files`);
