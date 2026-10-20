'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedLocalRequest } = require('../core/local-request-guard');

const PORT = 7890;
const req = headers => ({ headers: { host: '127.0.0.1:7890', 'content-type': 'application/json', ...headers } });

test('local-request-guard: the dashboard itself and local tools are trusted', () => {
  assert.equal(isTrustedLocalRequest(req({ origin: 'http://127.0.0.1:7890' }), PORT).ok, true);
  assert.equal(isTrustedLocalRequest(req({ host: 'localhost:7890', origin: 'http://localhost:7890' }), PORT).ok, true);
  assert.equal(isTrustedLocalRequest(req({}), PORT).ok, true); // curl / scripts send no Origin
});

test('local-request-guard: a web page on another origin cannot drive the agent', () => {
  assert.deepEqual(isTrustedLocalRequest(req({ origin: 'https://evil.example' }), PORT), { ok: false, reason: 'origin' });
  assert.deepEqual(isTrustedLocalRequest(req({ origin: 'http://localhost:3000' }), PORT), { ok: false, reason: 'origin' });
  assert.deepEqual(isTrustedLocalRequest(req({ origin: 'null' }), PORT), { ok: false, reason: 'origin' });
});

test('local-request-guard: DNS rebinding and preflight-free content types are rejected', () => {
  assert.deepEqual(isTrustedLocalRequest(req({ host: 'attacker.example:7890' }), PORT), { ok: false, reason: 'host' });
  assert.deepEqual(isTrustedLocalRequest(req({ 'content-type': 'text/plain' }), PORT), { ok: false, reason: 'content-type' });
});
