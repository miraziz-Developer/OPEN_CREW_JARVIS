'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptQuality, chooseTranscript, authoritativeTimeoutMs, nativeIsConfident } = require('../core/stt-recovery');

test('prefers a usable authoritative Uzbek transcript', () => {
  const result = chooseTranscript({ text: 'Chrome ni ochib ber', confidence: 0.91 }, 'chrome open');
  assert.equal(result.source, 'authoritative');
  assert.equal(result.text, 'Chrome ni ochib ber');
});

test('falls back to native when authoritative STT is empty or noise', () => {
  assert.equal(chooseTranscript({ text: '' }, 'Chrome och').source, 'native-fallback');
  assert.equal(chooseTranscript({ text: 'um', confidence: 0.2 }, 'Bugun ob havo qanday').source, 'native-fallback');
});

test('quality rejects low-information hallucinations', () => {
  assert.equal(transcriptQuality('um').usable, false);
  assert.equal(transcriptQuality('Safari och').usable, true);
});

test('authoritative timeout is bounded and adapts to utterance duration', () => {
  assert.equal(authoritativeTimeoutMs(0), 2200);
  assert.ok(authoritativeTimeoutMs(16000 * 2 * 2) > 2200);
  assert.equal(authoritativeTimeoutMs(16000 * 2 * 30), 5200);
});

test('nativeIsConfident allows clear multi-word commands to skip the authoritative wait', () => {
  assert.equal(nativeIsConfident("Xo'p, Chrome dasturini och"), true);
  assert.equal(nativeIsConfident('Salom Jarvis, bugun ob-havo qanday'), true);
  assert.equal(nativeIsConfident('Telegramda Aziz akaga salom degan xabar yubor'), true);
});

test('nativeIsConfident stays conservative for short/ambiguous/acknowledgement turns', () => {
  assert.equal(nativeIsConfident('Musiqani to\'xtat'), false); // faqat 2 token
  assert.equal(nativeIsConfident('bilmadim'), false); // 1 token, past ball
  assert.equal(nativeIsConfident('ha'), false); // tasdiq, policy rad etadi
  assert.equal(nativeIsConfident(''), false);
});

test('nativeIsConfident respects custom thresholds', () => {
  assert.equal(nativeIsConfident('Chrome ni och', { minScore: 50 }), true);
  assert.equal(nativeIsConfident('Chrome ni och', { minScore: 90 }), false);
  assert.equal(nativeIsConfident('Chrome ni och', { minTokens: 5 }), false);
});