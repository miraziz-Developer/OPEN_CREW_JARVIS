'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SkillPlatform, ProviderPool } = require('../core/skill-platform');

test('skill platform validates contracts, permissions and lazy loads once', async () => {
  let loads = 0;
  const platform = new SkillPlatform();
  platform.register({ id: 'mail', version: '1', actions: {
    send: { permissions: ['mail.write'], input: { required: ['to'], properties: { to: 'string' } } }
  } }, async () => { loads++; return { send: async input => ({ status: 'ok', to: input.to }) }; });
  await assert.rejects(platform.invoke('mail', 'send', { to: 'a@b.c' }), /Missing permissions/);
  await assert.rejects(platform.invoke('mail', 'send', {}, { permissions: ['mail.write'] }), /required/);
  assert.equal((await platform.invoke('mail', 'send', { to: 'a@b.c' }, { permissions: ['mail.write'] })).status, 'ok');
  await platform.invoke('mail', 'send', { to: 'c@d.e' }, { permissions: ['mail.write'] });
  assert.equal(loads, 1);
});

test('skill circuit opens after bounded failures', async () => {
  let now = 0;
  const platform = new SkillPlatform({ now: () => now, failureThreshold: 2, cooldownMs: 100 });
  platform.register({ id: 'bad', version: '1', actions: { run: {} } }, async () => ({ run: async () => { throw new Error('boom'); } }));
  await assert.rejects(platform.invoke('bad', 'run'), /boom/);
  await assert.rejects(platform.invoke('bad', 'run'), /boom/);
  await assert.rejects(platform.invoke('bad', 'run'), /circuit open/);
  now = 101;
  await assert.rejects(platform.invoke('bad', 'run'), /boom/);
});

test('provider pool falls back and recovers after cooldown', async () => {
  let now = 0, primaryWorks = false;
  const pool = new ProviderPool([
    { id: 'primary', invoke: async () => { if (!primaryWorks) throw new Error('down'); return 'primary-ok'; } },
    { id: 'fallback', invoke: async () => 'fallback-ok' }
  ], { now: () => now, failureThreshold: 1, cooldownMs: 100 });
  assert.deepEqual(await pool.invoke('hello'), { provider: 'fallback', value: 'fallback-ok' });
  primaryWorks = true;
  assert.equal((await pool.invoke('hello')).provider, 'fallback');
  now = 101;
  assert.deepEqual(await pool.invoke('hello'), { provider: 'primary', value: 'primary-ok' });
});

test('all provider errors are summarized without losing fallback evidence', async () => {
  const pool = new ProviderPool([
    { id: 'one', invoke: async () => { throw new Error('network'); } },
    { id: 'two', invoke: async () => null }
  ]);
  await assert.rejects(pool.invoke('x'), /one: network.*two: empty response/);
});