'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMissingDependency, buildSafeRepairPlan, formatSelfHealEscalation, runSelfHeal } = require('../core/self-heal');

test('self-heal extracts safe Node and Python dependency names only', () => {
  assert.deepEqual(extractMissingDependency(new Error("Cannot find module '@scope/example-package'")), { name: '@scope/example-package', ecosystem: 'node' });
  assert.deepEqual(extractMissingDependency(new Error("ModuleNotFoundError: No module named 'requests'")), { name: 'requests', ecosystem: 'python' });
  assert.equal(extractMissingDependency(new Error("Cannot find module '../../secret'")), null);
});

test('self-heal uses a constrained project-local Node install plan', () => {
  assert.deepEqual(buildSafeRepairPlan({ name: 'example-package', ecosystem: 'node' }, '/tmp/project'), {
    dependency: { name: 'example-package', ecosystem: 'node' }, manager: 'npm',
    command: 'npm install --no-save --ignore-scripts example-package', projectDir: '/tmp/project'
  });
  assert.equal(buildSafeRepairPlan({ name: 'example-package; rm -rf /', ecosystem: 'node' }, '/tmp/project'), null);
});

test('self-heal escalation asks for a concrete missing credential', () => {
  assert.match(formatSelfHealEscalation({ type: 'missing_config', configKey: 'AZURE_OPENAI_KEY' }), /AZURE_OPENAI_KEY/);
});

test('routine autonomy permits only the validated project-local dependency repair', async () => {
  const prompts = [];
  const result = await runSelfHeal({
    projectDir: '/tmp/project', dependency: { name: 'example-package', ecosystem: 'node' }, routineAutonomy: true,
    interpreterRunner: async input => {
      prompts.push(input.prompt);
      return { stdout: 'verified' };
    }
  });
  assert.equal(result.status, 'repaired');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /npm install --no-save --ignore-scripts example-package/);
});

test('explicit repair approval is scoped to the exact validated command', async () => {
  const input = { projectDir: '/tmp/project', dependency: { name: 'example-package', ecosystem: 'node' }, interpreterRunner: async () => ({ stdout: 'verified' }) };
  assert.equal((await runSelfHeal({ ...input, approvedCommand: 'npm install other-package' })).status, 'blocked');
  assert.equal((await runSelfHeal({ ...input, approvedCommand: 'npm install --no-save --ignore-scripts example-package' })).status, 'repaired');
});