'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildOpenClawAgentArgs, ENGLISH_ONLY_INSTRUCTION, needsCheckpointedExecution } = require('../core/agent-bridge');
const { createCheckpointStore } = require('../core/agent-task-checkpoints');

test('agent bridge forwards an explicit session key to OpenClaw', () => {
  assert.deepEqual(buildOpenClawAgentArgs('Davom et', 'agent:main:jarvis-project-alpha'), [
    'agent', '--session-key', 'agent:main:jarvis-project-alpha',
    '--message', ENGLISH_ONLY_INSTRUCTION + '\n\nDavom et', '--agent', 'main'
  ]);
});

test('agent bridge preserves one-shot behavior without a session key', () => {
  assert.deepEqual(buildOpenClawAgentArgs('Salom'), [
    'agent', '--message', ENGLISH_ONLY_INSTRUCTION + '\n\nSalom', '--agent', 'main'
  ]);
});

test('complex requests select checkpointed execution while simple requests do not', () => {
  assert.equal(needsCheckpointedExecution('Design a secure migration architecture with a staged rollout and rollback plan.'), true);
  assert.equal(needsCheckpointedExecution('What time is it?'), false);
});

test('checkpoint store persists task state atomically under the runtime directory', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-checkpoint-'));
  const store = createCheckpointStore(projectDir);
  const task = { id: 'task-1', status: 'completed', steps: [{ index: 1, status: 'completed' }] };
  const file = store.save(task);

  assert.equal(file, path.join(projectDir, '.run', 'agent-task-checkpoints', 'task-1.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), task);
  assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.tmp')), false);
});