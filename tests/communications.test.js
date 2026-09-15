'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const communications = require('../skills/communications');

test('YouTube search uses a canonical HTTPS URL and encodes user text', () => {
  const url = communications.buildYouTubeSearchUrl('  lo-fi & chill  ');
  assert.equal(url, 'https://www.youtube.com/results?search_query=lo-fi+%26+chill');
  assert.throws(() => communications.buildYouTubeSearchUrl('   '), /qidiruv/i);
});

test('phone normalization only accepts valid E.164 numbers', () => {
  assert.equal(communications.normalizePhone('+1 (415) 555-2671'), '+14155552671');
  assert.equal(communications.normalizePhone('0901234567', '60'), '+60901234567');
  assert.equal(communications.normalizePhone('not-a-number'), null);
  assert.equal(communications.buildFaceTimeUrl('+14155552671'), 'facetime://%2B14155552671');
});

test('WhatsApp flow opens a prefilled draft and never sends it', async () => {
  const calls = [];
  const result = await communications.openWhatsAppDraft({ phone: '+14155552671', message: 'Salom & test' }, {
    execFile: (file, args, callback) => { calls.push({ file, args }); callback(null); }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.kind, 'whatsapp-draft');
  assert.match(result.url, /^https:\/\/wa\.me\/14155552671\?text=Salom/);
  assert.deepEqual(calls, [{ file: 'open', args: [result.url] }]);
  assert.match(result.message, /siz bosasiz/i);
});

test('FaceTime cannot start without an explicit scoped confirmation', async () => {
  const blocked = await communications.startFaceTimeCall({ phone: '+14155552671' });
  assert.equal(blocked.status, 'confirmation_required');
  const calls = [];
  const allowed = await communications.startFaceTimeCall({ phone: '+14155552671', confirmed: true }, {
    execFile: (file, args, callback) => { calls.push({ file, args }); callback(null); }
  });
  assert.equal(allowed.status, 'ok');
  assert.deepEqual(calls, [{ file: 'open', args: ['facetime://%2B14155552671'] }]);
});

test('contact lookup is read-only and parses bounded Contacts results', async () => {
  let invocation;
  const contacts = await communications.lookupContact('Ali', {
    execFile: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, '[{"name":"Ali Valiyev","phones":["+14155552671"],"emails":[]}]');
    }
  });
  assert.equal(invocation.file, 'osascript');
  assert.deepEqual(invocation.args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(invocation.options.env.JARVIS_CONTACT_QUERY, 'Ali');
  assert.equal(contacts[0].name, 'Ali Valiyev');
});

test('deterministic YouTube intent parsing does not require deep-think', () => {
  assert.deepEqual(communications.parseCommunicationIntent('YouTube da lofi hip hop qidir'), { kind: 'youtube-search', query: 'lofi hip hop' });
  assert.deepEqual(communications.parseCommunicationIntent('search synthwave on youtube'), { kind: 'youtube-search', query: 'synthwave' });
  assert.equal(communications.parseCommunicationIntent('Murakkab loyiha rejasi tuz'), null);
});