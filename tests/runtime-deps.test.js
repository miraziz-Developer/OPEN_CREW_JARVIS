'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED, missingDependencies } = require('../scripts/check-runtime-deps');

test('runtime dependency preflight reports only unresolved modules', () => {
  const missing = missingDependencies(name => {
    if (name === 'axios') throw new Error('missing');
    return `/node_modules/${name}`;
  });
  assert.deepEqual(missing, ['axios']);
  assert.ok(REQUIRED.includes('node-telegram-bot-api'));
});