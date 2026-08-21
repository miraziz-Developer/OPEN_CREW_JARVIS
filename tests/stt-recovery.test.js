'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptQuality, chooseTranscript, authoritativeTimeoutMs } = require('../core/stt-recovery');

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