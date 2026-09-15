'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenClawAgentArgs, ENGLISH_ONLY_INSTRUCTION } = require('../core/agent-bridge');

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