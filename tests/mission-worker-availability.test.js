'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoalEngine, normalizeTasks, buildPlanSystem } = require('../core/missions/engine');

const run = async () => ({ ok: true, output: '' });

test('missions: the planner is only offered workers that are installed', () => {
  const engine = new GoalEngine({
    store: { appendEvent() {} },
    workers: {
      agent: { run },
      think: { run },
      babyagi: { run, available: () => false },
      autogpt: { run, available: () => { throw new Error('probe failed'); } },
      browser: { run, available: () => true }
    }
  });
  assert.deepEqual(engine.availableWorkers(), ['agent', 'browser', 'think']);

  const prompt = buildPlanSystem(engine.availableWorkers());
  assert.match(prompt, /"worker":"agent\|browser\|think"/);
  assert.doesNotMatch(prompt, /babyagi|autogpt/);
});

test('missions: a task planned for an unavailable worker falls back to the agent', () => {
  const tasks = normalizeTasks([{ prompt: 'crunch numbers', worker: 'babyagi' }, { prompt: 'think', worker: 'think' }], 0, 0, ['agent', 'think']);
  assert.deepEqual(tasks.map(t => t.worker), ['agent', 'think']);
});
