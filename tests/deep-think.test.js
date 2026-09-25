'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractOutputText, stripMarkdown, isComplexReasoningRequest, reasoningProviders,
  FAST_MODEL, COMPLEX_MODEL
} = require('../skills/deep-think');

test('deep-think extracts text from Azure Responses API output', () => {
  const result = extractOutputText({
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'Birinchi gap.' },
          { type: 'refusal', refusal: 'ignored' },
          { type: 'output_text', text: 'Ikkinchi gap.' }
        ]
      }
    ]
  });
  assert.equal(result, 'Birinchi gap.\nIkkinchi gap.');
});

test('deep-think safely handles an empty Responses API payload', () => {
  assert.equal(extractOutputText({ output: [] }), '');
  assert.equal(extractOutputText(null), '');
  assert.equal(stripMarkdown('**Aniq** javob'), 'Aniq javob');
});

test('reasoning router selects GPT-6 Astra normally and GPT-6 Sol with ordered fallbacks for difficult planning', () => {
  assert.equal(isComplexReasoningRequest('Why is this cache useful?'), false);
  assert.equal(reasoningProviders('Why is this cache useful?')[0].model, FAST_MODEL);
  assert.equal(isComplexReasoningRequest('Design a secure multi-step migration architecture with tradeoffs.'), true);
  assert.equal(reasoningProviders('Design a secure multi-step migration architecture with tradeoffs.')[0].model, COMPLEX_MODEL);
  assert.deepEqual(
    reasoningProviders('Design a secure multi-step migration architecture with tradeoffs.').map(provider => provider.model),
    ['gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5-mini']
  );
});