'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPairing } = require('../core/telegram-pairing');

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pair-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN=abc\nOTHER=1\n');
  let now = 1000000;
  const pairing = createPairing({ file: path.join(dir, 'pair.json'), envFile, now: () => now, ...options });
  return { dir, envFile, pairing, tick: ms => { now += ms; }, file: path.join(dir, 'pair.json') };
}
const msg = (text, extra = {}) => ({ text, chat: { type: 'private', id: 42 }, from: { id: 42, is_bot: false }, ...extra });

test('a correct /pair code in a private chat stores the owner in .env and consumes the code', () => {
  const { pairing, envFile, file } = setup();
  const { code } = pairing.ensureCode();
  assert.match(code, /^\d{6}$/);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const result = pairing.attempt(msg(`/pair ${code}`));
  assert.deepEqual(result, { ok: true, ownerId: '42' });
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^TELEGRAM_CHAT_ID=42$/m);
  assert.match(env, /^OTHER=1$/m);
  assert.equal(fs.existsSync(file), false);
});

test('existing TELEGRAM_CHAT_ID lines are replaced, not duplicated', () => {
  const { pairing, envFile } = setup();
  fs.writeFileSync(envFile, 'A=1\nTELEGRAM_CHAT_ID=\nB=2\n');
  pairing.attempt(msg(`/pair ${pairing.ensureCode().code}`));
  assert.equal(fs.readFileSync(envFile, 'utf8').match(/TELEGRAM_CHAT_ID=/g).length, 1);
  assert.match(fs.readFileSync(envFile, 'utf8'), /^TELEGRAM_CHAT_ID=42$/m);
});

test('group chats, bots, other commands and forwarded/foreign chat ids never pair', () => {
  const { pairing, envFile } = setup();
  const { code } = pairing.ensureCode();
  assert.equal(pairing.attempt(msg(`/pair ${code}`, { chat: { type: 'group', id: -5 } })).reason, 'ignored');
  assert.equal(pairing.attempt(msg(`/pair ${code}`, { from: { id: 42, is_bot: true } })).reason, 'ignored');
  assert.equal(pairing.attempt(msg('hello there')).reason, 'ignored');
  assert.equal(pairing.attempt(msg(`/pair ${code}`, { chat: { type: 'private', id: 99 } })).ok, false);
  assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /TELEGRAM_CHAT_ID/);
});

test('wrong codes lock pairing after the attempt limit and rotate the code', () => {
  const { pairing, tick } = setup({ maxAttempts: 3 });
  const { code } = pairing.ensureCode();
  for (let i = 0; i < 3; i++) assert.equal(pairing.attempt(msg('/pair 000000')).reason, 'bad-code');
  assert.equal(pairing.attempt(msg(`/pair ${code}`)).reason, 'locked');
  tick(11 * 60 * 1000);
  assert.notEqual(pairing.ensureCode().code, code);
});

test('an expired code is replaced and the old one no longer works', () => {
  const { pairing, tick } = setup();
  const { code } = pairing.ensureCode();
  tick(16 * 60 * 1000);
  const fresh = pairing.ensureCode();
  assert.notEqual(fresh.code, code);
  assert.equal(pairing.attempt(msg(`/pair ${code}`)).ok, false);
});
