'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractOutputText, stripMarkdown } = require('../skills/deep-think');

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