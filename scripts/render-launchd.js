#!/usr/bin/env node
'use strict';

const fs = require('fs');

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function render(template, values) {
  let output = String(template);
  for (const [key, value] of Object.entries(values)) output = output.replaceAll(`__${key}__`, xmlEscape(value));
  const unresolved = output.match(/__[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`Plist placeholder yechilmadi: ${[...new Set(unresolved)].join(', ')}`);
  return output;
}

if (require.main === module) {
  const [source, destination, projectDir, nodeBin] = process.argv.slice(2);
  if (!source || !destination || !projectDir || !nodeBin) {
    console.error('Usage: render-launchd.js SOURCE DEST PROJECT_DIR NODE_BIN');
    process.exit(2);
  }
  fs.writeFileSync(destination, render(fs.readFileSync(source, 'utf8'), { PROJECT_DIR: projectDir, NODE_BIN: nodeBin }), { mode: 0o644 });
}

module.exports = { render, xmlEscape };