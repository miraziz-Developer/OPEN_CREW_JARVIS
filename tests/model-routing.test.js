'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isComplexTask, needsStrongAgentModel, modelConfig, selectAgentModel } = require('../core/model-routing');

const values = {
  AZURE_OPENAI_DEPLOYMENT: 'mini',
  AGENT_FAST_MODEL: 'fast',
  AGENT_STRONG_MODEL: 'strong',
  AGENT_STRONG_FALLBACK_MODELS: 'backup-a, backup-b,fast'
};
const env = (name, fallback) => values[name] || fallback;

test('model routing keeps chat cheap and sends tool, coding and complex work to the strong model', () => {
  assert.equal(selectAgentModel('What time is it?', env), 'fast');
  assert.equal(selectAgentModel('Open the browser and research this issue.', env), 'strong');
  assert.equal(selectAgentModel('Refactor this code and run the tests.', env), 'strong');
  assert.equal(isComplexTask('Design a secure migration architecture with tradeoffs.'), true);
  assert.equal(needsStrongAgentModel('Send an email to the project team.'), true);
});

test('strong fallback chain is ordered and deduplicated with fast last', () => {
  assert.deepEqual(modelConfig(env), {
    fast: 'fast', strong: 'strong', strongChain: ['strong', 'backup-a', 'backup-b', 'fast']
  });
  assert.deepEqual(modelConfig(() => ''), {
    fast: 'gpt-6-astra', strong: 'gpt-6-sol', strongChain: ['gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5-mini']
  });
});