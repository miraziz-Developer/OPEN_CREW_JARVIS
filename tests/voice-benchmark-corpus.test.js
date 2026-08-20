'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { words, editDistance, summarizeCorpus } = require('../core/voice-benchmark-corpus');

test('Uzbek punctuation normalization and word edit distance are deterministic', () => {
  assert.deepEqual(words("O‘sha faylni och!"), ["o'sha", 'faylni', 'och']);
  assert.equal(editDistance('chrome ni och', 'chrome och'), 1);
});

test('private corpus produces quality-gate compatible voice counters', () => {
  const result = summarizeCorpus({ observationHours: 12, samples: [
    { kind: 'wake', expectedWake: true, detected: true },
    { kind: 'wake', expectedWake: true, detected: false },
    { kind: 'wake', expectedWake: false, detected: true },
    { kind: 'stt', expected: 'Chrome ni och', recognized: 'Chrome och' }
  ] });
  assert.deepEqual(result.voice, { truePositives: 1, falseNegatives: 1, falseWakes: 1, hours: 12, referenceWords: 3, correctWords: 2, wordErrors: 1 });
});