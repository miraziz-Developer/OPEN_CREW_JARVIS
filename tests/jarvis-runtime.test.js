'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JarvisRuntime, normalizeText, fingerprintText } = require('../core/jarvis-runtime');

test('Uzbek punctuation and apostrophes normalize consistently', () => {
  assert.equal(normalizeText("  SALOM,  JARVIS!  "), 'salom jarvis');
  assert.equal(fingerprintText("To‘xtat"), fingerprintText("to'xtat"));
});

test('duplicate commands are rejected inside the window and accepted later', () => {
  let now = 0;
  const runtime = new JarvisRuntime({ now: () => now, commandWindowMs: 5000 });
  assert.equal(runtime.acceptCommand('YouTube ni och', { source: 'voice' }).accepted, true);
  now = 1200;
  assert.deepEqual(runtime.acceptCommand('youtube-ni och!', { source: 'voice' }).reason, 'duplicate');
  now = 6000;
  assert.equal(runtime.acceptCommand('YouTube ni och', { source: 'voice' }).accepted, true);
});

test('identical assistant response is suppressed during echo window', () => {
  let now = 100;
  const runtime = new JarvisRuntime({ now: () => now, responseWindowMs: 15000 });
  assert.equal(runtime.acceptResponse('Bajarildi, boss.').accepted, true);
  now += 1000;
  assert.equal(runtime.acceptResponse('Bajarildi boss').reason, 'duplicate');
});

test('task ledger enforces transitions and only marks non-error output verified', () => {
  let now = 1000;
  const runtime = new JarvisRuntime({ now: () => now });
  runtime.requestTask('Brauzerni och', { id: 'call-1', source: 'realtime' });
  runtime.transitionTask('call-1', 'running');
  now += 250;
  const task = runtime.completeTask('call-1', 'Safari ochildi');
  assert.equal(task.state, 'verified');
  assert.equal(task.verification.ok, true);
  assert.throws(() => runtime.transitionTask('call-1', 'running'), /Noto'g'ri task transition/);

  runtime.requestTask('Noto\'g\'ri vazifa', { id: 'call-2' });
  runtime.transitionTask('call-2', 'running');
  assert.equal(runtime.completeTask('call-2', 'Xatolik: ilova topilmadi').state, 'failed');
});

test('snapshot contains conversation, health and latency telemetry', () => {
  let now = 5000;
  const runtime = new JarvisRuntime({ now: () => now });
  runtime.beginConversation('push-to-talk', 'voice-1');
  runtime.setConversationMode('listening');
  runtime.heartbeat('microphone', { status: 'streaming' });
  runtime.observeLatency('realtime-connect', 420);
  now = 5500;
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.conversation.id, 'voice-1');
  assert.equal(snapshot.components.microphone.ageMs, 500);
  assert.equal(snapshot.latency['realtime-connect'].p95Ms, 420);
});

test('runtime state is persisted with atomic JSON replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
  const file = path.join(dir, 'state.json');
  const runtime = new JarvisRuntime({ statusFile: file });
  runtime.beginConversation('wake-word', 'voice-persist');
  runtime.flush();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.conversation.id, 'voice-persist');
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0);
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});