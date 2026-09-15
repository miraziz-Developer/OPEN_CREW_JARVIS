'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSuggestion } = require('../core/background-jobs/proactive-check');

test('proactive check suppresses no-action explanations and tool-status messages', () => {
  assert.equal(extractSuggestion('NO_ACTION'), null);
  assert.equal(extractSuggestion('HECH_NARSA'), null);
  assert.equal(extractSuggestion('Memory search is unavailable, so I assessed only the supplied observations.'), null);
  assert.equal(extractSuggestion('No clear missed routine or confirmed issue is worth interrupting you for.'), null);
});

test('proactive check accepts only explicitly formatted actionable suggestions', () => {
  assert.equal(
    extractSuggestion('SUGGESTION: Your usual deployment review is still open; the build panel shows a failed check.'),
    'Your usual deployment review is still open; the build panel shows a failed check.'
  );
  assert.equal(extractSuggestion('SUGGESTION: short'), null);
  assert.equal(extractSuggestion('Suggestion: Check the build.'), null);
});