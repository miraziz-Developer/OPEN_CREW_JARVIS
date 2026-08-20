'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { correctTranscript } = require('../core/transcript-corrector');

test('confirmed pronunciation mistakes are corrected case-insensitively', () => {
  const entries = [{ misheard: 'Jervis', actual: 'Jarvis' }];
  assert.equal(correctTranscript('Jervis chrome ni och', entries), 'Jarvis chrome ni och');
  assert.equal(correctTranscript('jervis, eshityapsanmi?', entries), 'Jarvis, eshityapsanmi?');
});

test('longest phrase wins and unrelated token fragments stay intact', () => {
  const entries = [
    { misheard: 'ochiq lau', actual: 'OpenClaw' },
    { misheard: 'lau', actual: 'Claw' }
  ];
  assert.equal(correctTranscript('ochiq lau ni ishga tushir', entries), 'OpenClaw ni ishga tushir');
  assert.equal(correctTranscript('palau taomi', entries), 'palau taomi');
});

test('invalid and identity entries are ignored', () => {
  assert.equal(correctTranscript('Jarvis', [{ misheard: '', actual: 'x' }, { misheard: 'Jarvis', actual: 'jarvis' }]), 'Jarvis');
});

test('common fast Uzbek speech forms are canonicalized conservatively', () => {
  assert.equal(correctTranscript('Chrome ni ochvor, ishlamayabdi'), 'Chrome ni ochib yubor, ishlamayapti');
  assert.equal(correctTranscript('togri qiber'), "to'g'ri qilib ber");
  assert.equal(correctTranscript('palov va telefon'), 'palov va telefon');
});