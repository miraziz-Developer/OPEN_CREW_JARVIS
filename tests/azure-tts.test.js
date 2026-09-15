'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSsml, signedPercent } = require('../skills/azure-tts');

test('Azure fallback TTS uses a slower lower cinematic profile', () => {
  const ssml = buildSsml('Ready & waiting.', 'en-US-GuyNeural', {
    language: 'en-US', ratePercent: -12, pitchPercent: -12
  });

  assert.match(ssml, /xml:lang="en-US"/);
  assert.match(ssml, /voice name="en-US-GuyNeural"/);
  assert.match(ssml, /prosody rate="-12%" pitch="-12%"/);
  assert.match(ssml, /Ready &amp; waiting\./);
});

test('Azure fallback TTS formats signed percentages for SSML', () => {
  assert.equal(signedPercent(5, -12), '+5%');
  assert.equal(signedPercent(-8, -12), '-8%');
  assert.equal(signedPercent(Number.NaN, -12), '-12%');
});