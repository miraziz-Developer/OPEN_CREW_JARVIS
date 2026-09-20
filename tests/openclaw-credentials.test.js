'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentBridge } = require('../core/agent-bridge');
const { resolveOpenClawEnvironment } = require('../core/openclaw-credentials');

test('resolver passes OpenClaw credentials from project .env to a child environment', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-openclaw-env-'));
  fs.writeFileSync(path.join(projectDir, '.env'), 'OPENCLAW_GATEWAY_TOKEN=from-dotenv\nAZURE_OPENAI_KEY=azure-from-dotenv\n');

  const resolved = resolveOpenClawEnvironment({ projectDir, env: { PATH: '/usr/bin' } });

  assert.equal(resolved.OPENCLAW_GATEWAY_TOKEN, 'from-dotenv');
  assert.equal(resolved.AZURE_OPENAI_KEY, 'azure-from-dotenv');
  assert.equal(resolved.JARVIS_PROJECT_DIR, projectDir);
  assert.equal(resolved.OPENCLAW_CONFIG_PATH, path.join(projectDir, 'openclaw.json'));
});

test('resolver reports a missing gateway token before OpenClaw is spawned', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-openclaw-env-'));

  assert.throws(
    () => resolveOpenClawEnvironment({ projectDir, env: {} }),
    /OPENCLAW_GATEWAY_TOKEN topilmadi/
  );
});

test('bridge uses the resolver environment when its parent environment lacks the gateway token', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-openclaw-bridge-'));
  fs.writeFileSync(path.join(projectDir, '.env'), 'OPENCLAW_GATEWAY_TOKEN=from-dotenv\n');
  let spawnOptions;
  const spawnProcess = (_command, _args, options) => {
    spawnOptions = options;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => { child.stdout.emit('data', 'resolved response'); child.emit('close', 0); });
    return child;
  };
  const bridge = createAgentBridge({
    projectDir,
    env: () => '',
    openClawBaseEnvironment: { PATH: '/usr/bin' },
    spawnProcess,
    skillPlatform: { invoke: async () => null },
    runtime: {}
  });

  assert.equal(await bridge.askOpenClaw('Hello'), 'resolved response');
  assert.equal(spawnOptions.env.OPENCLAW_GATEWAY_TOKEN, 'from-dotenv');
  assert.equal(spawnOptions.env.JARVIS_PROJECT_DIR, projectDir);
});