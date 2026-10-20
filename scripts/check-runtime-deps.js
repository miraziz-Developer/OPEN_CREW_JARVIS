#!/usr/bin/env node
'use strict';

const REQUIRED = Object.freeze([
  '@picovoice/porcupine-node',
  'axios',
  'microsoft-cognitiveservices-speech-sdk',
  'node-record-lpcm16',
  'node-telegram-bot-api'
]);

function missingDependencies(resolve = require.resolve) {
  return REQUIRED.filter(name => {
    try { resolve(name); return false; }
    catch (_) { return true; }
  });
}

if (require.main === module) {
  const missing = missingDependencies();
  if (missing.length) {
    console.error(`❌ Runtime dependency yetishmaydi: ${missing.join(', ')}`);
    console.error('Run `npm ci` in the project root. The supervisor was not started.');
    process.exitCode = 1;
  } else {
    console.log(`✅ ${REQUIRED.length} runtime dependencies present.`);
  }
}

module.exports = { REQUIRED, missingDependencies };