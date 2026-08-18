#!/usr/bin/env node
'use strict';

const path = require('path');
const { readEnvFile, validateConfig, redactConfig } = require('../core/config');

const fileArg = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const file = path.resolve(fileArg || path.join(__dirname, '..', '.env'));
try {
  const result = validateConfig({ ...readEnvFile(file), ...process.env });
  for (const warning of result.warnings) console.warn(`⚠️  ${warning.message}`);
  for (const error of result.errors) console.error(`❌ ${error.message}`);
  if (!result.ok) {
    console.error(`\nConfig yaroqsiz: ${result.errors.length} xato.`);
    process.exitCode = 1;
  } else {
    console.log(`✅ Config yaroqli (${Object.keys(result.values).length} typed parametr).`);
    if (process.argv.includes('--print')) console.log(JSON.stringify(redactConfig(result.values), null, 2));
  }
} catch (error) {
  console.error(`❌ Config o‘qilmadi: ${error.message}`);
  process.exitCode = 1;
}