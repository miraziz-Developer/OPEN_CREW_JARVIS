'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCommands, planCommand } = require('../core/mission-planner');

test('Uzbek and English multi-command utterances become an ordered dependency DAG', () => {
  assert.deepEqual(splitCommands('Safari-ni och, keyin screenshot ol, undan keyin testlarni ishga tushir'), [
    'Safari-ni och', 'screenshot ol', 'testlarni ishga tushir'
  ]);
  const plan = planCommand('Open Chrome and then open GitHub; then take a screenshot');
  assert.equal(plan.isMultiCommand, true);
  assert.deepEqual(plan.steps.map(step => step.dependsOn), [[], ['step-1'], ['step-2']]);
});

test('explicit parallel plans have no artificial dependencies', () => {
  const plan = planCommand('run tests; inspect logs', { parallel: true });
  assert.deepEqual(plan.steps.map(step => step.dependsOn), [[], []]);
});