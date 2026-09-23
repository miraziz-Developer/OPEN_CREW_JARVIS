'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildOpenClawAgentArgs, checkpointSessionKey, createAgentBridge,
  ENGLISH_ONLY_INSTRUCTION, OpenClawEmptyResponseError,
  needsCheckpointedExecution, needsPersistentExecution, classifyProviderError
} = require('../core/agent-bridge');
const { createCheckpointStore } = require('../core/agent-task-checkpoints');

test('agent bridge forwards an explicit session key to OpenClaw', () => {
  assert.deepEqual(buildOpenClawAgentArgs('Davom et', 'agent:main:jarvis-project-alpha'), [
    'agent', '--session-key', 'agent:main:jarvis-project-alpha',
    '--message', ENGLISH_ONLY_INSTRUCTION + '\n\nDavom et', '--agent', 'main', '--thinking', 'off'
  ]);
});

test('agent bridge preserves one-shot behavior without a session key', () => {
  assert.deepEqual(buildOpenClawAgentArgs('Salom'), [
    'agent', '--message', ENGLISH_ONLY_INSTRUCTION + '\n\nSalom', '--agent', 'main', '--thinking', 'off'
  ]);
});

test('complex requests select checkpointed execution while simple requests do not', () => {
  assert.equal(needsCheckpointedExecution('Design a secure migration architecture with a staged rollout and rollback plan.'), true);
  assert.equal(needsCheckpointedExecution('What time is it?'), false);
});

test('persistent request terms select durable execution and policy errors do not retry', () => {
  assert.equal(needsPersistentExecution('Please keep working until the complete detailed analysis is ready.'), true);
  assert.equal(needsPersistentExecution('What time is it?'), false);
  assert.equal(classifyProviderError(new Error('FailoverError: request timed out')).retryable, true);
  assert.equal(classifyProviderError(new Error('tool policy removed this content')).retryable, false);
});

test('checkpoint session keys are task scoped and empty OpenClaw responses are transient', () => {
  assert.equal(checkpointSessionKey('4a4d827bb404ac1e'), 'agent:main:checkpoint-4a4d827bb404ac1e');
  const classification = classifyProviderError(new OpenClawEmptyResponseError());
  assert.equal(classification.retryable, true);
  assert.equal(classification.type, 'transient');
});

test('provider errors classify missing dependencies and configuration without treating credentials as installable', () => {
  const dependency = classifyProviderError(new Error("Error: Cannot find module 'fixture-local-package'"));
  assert.deepEqual(dependency.dependency, { name: 'fixture-local-package', ecosystem: 'node' });
  assert.equal(dependency.type, 'missing_dependency');
  assert.equal(dependency.fixableLocally, true);
  const config = classifyProviderError(new Error('Missing environment variable AZURE_OPENAI_KEY'));
  assert.equal(config.type, 'missing_config');
  assert.equal(config.configKey, 'AZURE_OPENAI_KEY');
  assert.equal(config.retryable, false);
  assert.equal(classifyProviderError(new Error('npm install failed because the local package manager is unavailable')).type, 'fixable_locally');
});

test('checkpoint blocks a missing dependency repair until the user confirms it', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-self-heal-'));
  const calls = [];
  const repairs = [];
  const telemetry = { repairs: [], openClawAttempt() {}, selfHealAttempt(entry) { this.repairs.push(entry); }, providerPool() {}, providerResult() {} };
  let stepCalls = 0;
  const bridge = createAgentBridge({
    projectDir, env: () => '', openClawEnvironment: {}, telemetry, skillPlatform: { invoke: async () => null }, runtime: {},
    selfHealRunner: async input => {
      repairs.push(input.prompt);
      return { stdout: input.prompt.includes('Run exactly') ? 'Installed fixture-local-package and verified it.' : 'fixture-local-package is absent.' };
    },
    spawnProcess: (command, args) => {
      calls.push({ command, args });
      const proc = new EventEmitter();
      proc.pid = 7000 + calls.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        const message = args[args.indexOf('--message') + 1];
        if (message.includes('Break this request')) proc.stdout.emit('data', Buffer.from('{"steps":["Run fixture task"]}'));
        else if (message.includes('Synthesize')) proc.stdout.emit('data', Buffer.from('Fixture task complete.'));
        else if (++stepCalls === 1) proc.stderr.emit('data', Buffer.from("Error: Cannot find module 'fixture-local-package'"));
        else proc.stdout.emit('data', Buffer.from('Dependency is now available; step complete.'));
        proc.emit('close', message.includes('Run fixture task') && stepCalls === 1 ? 1 : 0, null);
      });
      return proc;
    }
  });

  assert.equal(
    await bridge.askCheckpointedAgent('Create a detailed fixture implementation plan.'),
    'Repairing this issue requires a confirmation-gated action. Please confirm the specific repair so I can resume the same checkpoint.'
  );
  const task = bridge.checkpoints.list()[0];
  assert.equal(stepCalls, 1);
  assert.equal(task.status, 'paused-awaiting-approval');
  assert.match(task.pauseReason, /confirmation-gated action/i);
  assert.equal(task.steps[0].selfHealAttempts[0].dependency, 'fixture-local-package');
  assert.equal(task.steps[0].selfHealAttempts[0].status, 'blocked');
  assert.equal(telemetry.repairs[0].status, 'blocked');
  assert.equal(repairs.length, 0);
});

test('approval resumes only an explicitly approved paused checkpoint', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approval-resume-'));
  const bridge = createAgentBridge({
    projectDir, env: () => '', openClawEnvironment: {}, skillPlatform: { invoke: async () => null }, runtime: {},
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.pid = 12345; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      process.nextTick(() => { proc.stdout.emit('data', Buffer.from('Resumed task final response.')); proc.emit('close', 0, null); });
      return proc;
    }
  });
  const task = {
    id: 'aabbccddeeff0099', request: 'Resume fixture', sessionKey: 'agent:main:checkpoint-aabbccddeeff0099', persistent: true,
    status: 'paused-awaiting-approval', createdAt: new Date().toISOString(),
    steps: [{ index: 1, text: 'Already complete', status: 'completed', result: 'Done' }], pauseReason: 'approval needed'
  };
  bridge.checkpoints.save(task);
  await assert.rejects(() => bridge.approvePersistentTask(task.id), /Explicit approval/);
  assert.equal(await bridge.approvePersistentTask(task.id, { approved: true, source: 'telegram' }), 'Resumed task final response.');
  const resumed = bridge.checkpoints.load(task.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.approvalSource, 'telegram');
});

test('checkpoint attempts use a task-scoped key and persist child diagnostics', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-bridge-'));
  const calls = [];
  const telemetry = { attempts: [], openClawAttempt(attempt) { this.attempts.push(attempt); }, providerPool() {}, providerResult() {} };
  const replies = ['{"steps":["Inspect the current state"]}', 'Step complete.', 'Final synthesis.'];
  const bridge = createAgentBridge({
    projectDir, env: () => '', openClawEnvironment: {}, telemetry,
    skillPlatform: { invoke: async () => null }, runtime: {},
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const proc = new EventEmitter();
      proc.pid = 4242 + calls.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from(replies.shift()));
        proc.emit('close', 0, null);
      });
      return proc;
    }
  });

  assert.equal(await bridge.askCheckpointedAgent('Create a detailed implementation plan.', 'agent:main:dashboard', { persistent: true }), 'Final synthesis.');
  const task = bridge.checkpoints.list()[0];
  assert.equal(task.sessionKey, checkpointSessionKey(task.id));
  assert.ok(calls.every(call => call.args.includes(task.sessionKey)));
  assert.equal(task.attempts[0].phase, 'planning');
  assert.equal(task.steps[0].attempts[0].childPid, 4244);
  assert.equal(task.steps[0].attempts[0].exitCode, 0);
  assert.equal(task.steps[0].attempts[0].signal, null);
  assert.equal(task.steps[0].attempts[0].stdoutBytes, Buffer.byteLength('Step complete.'));
  assert.equal(telemetry.attempts.length, 3);
});

test('all unusable OpenClaw outputs produce the typed retryable empty-response error', async () => {
  for (const output of ['', 'Waiting...\nWaiting...', '[]', '{}', 'null', 'undefined']) {
    const bridge = createAgentBridge({
      projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-empty-')),
      env: () => '', openClawEnvironment: {}, skillPlatform: { invoke: async () => null }, runtime: {},
      spawnProcess: () => {
        const proc = new EventEmitter();
        proc.pid = 9001;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        process.nextTick(() => { proc.stdout.emit('data', Buffer.from(output)); proc.emit('close', 0, null); });
        return proc;
      }
    });
    await assert.rejects(bridge.askOpenClaw('test', 'agent:main:test'), error => {
      assert.equal(error.name, 'OpenClawEmptyResponseError');
      assert.equal(classifyProviderError(error).retryable, true);
      return true;
    });
  }
});

test('a useful report mentioning a policy failure is not itself treated as a policy failure', async () => {
  const bridge = createAgentBridge({
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-policy-')),
    env: () => '', openClawEnvironment: {}, skillPlatform: { invoke: async () => null }, runtime: {},
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.pid = 9002;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('The retry policy recognizes the tool policy removed failure.'));
        proc.emit('close', 0, null);
      });
      return proc;
    }
  });
  assert.equal(await bridge.askOpenClaw('test', 'agent:main:test'), 'The retry policy recognizes the tool policy removed failure.');
});

test('checkpoint store persists task state atomically under the runtime directory', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-checkpoint-'));
  const store = createCheckpointStore(projectDir);
  const task = { id: 'aabbccddeeff0011', status: 'completed', steps: [{ index: 1, status: 'completed' }] };
  const file = store.save(task);

  assert.equal(file, path.join(projectDir, '.run', 'agent-task-checkpoints', 'aabbccddeeff0011.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), task);
  assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.tmp')), false);
  assert.equal(store.load(task.id).id, task.id);
  assert.equal(store.list().length, 1);
  assert.throws(() => store.save({ id: '../../escape' }), /Invalid checkpoint/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('public resume and checkpoint entry points cannot bypass persisted approval or cancellation', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approval-guard-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const bridge = createAgentBridge({ projectDir, env: () => '', openClawEnvironment: {}, skillPlatform: { invoke() {} }, runtime: {}, spawnProcess: () => assert.fail('must not execute') });
  const task = { id: 'aabbccddeeff0022', status: 'paused-awaiting-approval', steps: [{ index: 1, status: 'paused-awaiting-approval' }] };
  bridge.checkpoints.save(task);
  await assert.rejects(bridge.resumePersistentTask(task, { approved: true }), /Explicit approval/);
  await assert.rejects(bridge.askCheckpointedAgent('test', '', { task, approved: true }), /Explicit approval/);
  await assert.rejects(bridge.resumePersistentTask({ ...task, status: 'retrying', steps: [] }), /Explicit approval/);
  assert.equal(bridge.checkpoints.load(task.id).status, 'paused-awaiting-approval');
  await bridge.approvePersistentTask(task.id, { approved: false });
  assert.equal(bridge.checkpoints.load(task.id).status, 'cancelled');
  await assert.rejects(bridge.resumePersistentTask(task), /Terminal task/);
});

test('persisted approval permits only the gated repair then resumes the unfinished step', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approved-repair-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  let installed = false; let repairs = 0;
  const bridge = createAgentBridge({
    projectDir, env: () => '', openClawEnvironment: {}, skillPlatform: { invoke() {} }, runtime: {},
    selfHealRunner: async ({ prompt }) => { repairs++; if (prompt.includes('Run exactly')) installed = true; return { stdout: 'verified' }; },
    spawnProcess: (command, args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      process.nextTick(() => {
        const prompt = args[args.indexOf('--message') + 1];
        if (!installed && !prompt.includes('Synthesize')) {
          child.stderr.emit('data', "Cannot find module 'fixture-local-package'"); child.emit('close', 1);
        } else { child.stdout.emit('data', 'Completed'); child.emit('close', 0); }
      });
      return child;
    }
  });
  const task = { id: 'aabbccddeeff0023', request: 'Run fixture', persistent: true, status: 'retrying', steps: [{ index: 1, text: 'Run fixture', status: 'pending' }] };
  bridge.checkpoints.save(task);
  await bridge.resumePersistentTask(task);
  assert.equal(task.status, 'paused-awaiting-approval');
  assert.equal(repairs, 0);
  assert.equal(bridge.checkpoints.load(task.id).pendingApproval.command, 'npm install --no-save --ignore-scripts fixture-local-package');
  assert.equal(await bridge.approvePersistentTask(task.id, { approved: true, source: 'telegram-owner', onProgress: () => { throw new Error('notification offline'); } }), 'Completed');
  assert.equal(repairs, 2);
  assert.equal(bridge.checkpoints.load(task.id).status, 'completed');
  assert.equal(bridge.checkpoints.load(task.id).pendingApproval, undefined);
  await assert.rejects(bridge.approvePersistentTask(task.id, { approved: true }), /not awaiting approval/);
});
test('visual/phone-precision tasks keep full reasoning (thinking not forced off), unlike plain simple tasks', () => {
  const { buildOpenClawAgentArgs, needsCarefulReasoning } = require('../core/agent-bridge');
  for (const text of ['check WhatsApp for unread messages', 'tap the icon on my phone home screen', 'see who messaged me on Instagram', 'open the app on my iPhone and check it']) {
    assert.equal(needsCarefulReasoning(text), true, text);
    assert.ok(!buildOpenClawAgentArgs(text, 'k').includes('off'), text);
  }
  assert.equal(needsCarefulReasoning('open my downloads folder'), false);
  assert.ok(buildOpenClawAgentArgs('open my downloads folder', 'k').includes('off'));
});
