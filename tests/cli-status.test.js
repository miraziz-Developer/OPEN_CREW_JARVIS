'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('CLI status checks the dashboard status API contract', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'jarvis'), 'utf8');
  assert.match(cli, /curl -fsS --max-time 2 http:\/\/127\.0\.0\.1:7890\/api\/status/);
});