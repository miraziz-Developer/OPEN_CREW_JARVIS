'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeProject(whisperScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-pool-'));
  fs.mkdirSync(path.join(dir, 'models', 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'whisper', 'ggml-base.bin'), '');
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(bin, `#!/bin/sh\n${whisperScript}\n`, { mode: 0o755 });
  process.env.WHISPER_WAKE_BINARY = bin;
  return dir;
}

function loadPool(geminiStub) {
  for (const mod of ['../core/stt-pool', '../core/gemini']) delete require.cache[require.resolve(mod)];
  if (geminiStub) require.cache[require.resolve('../core/gemini')] = { exports: geminiStub, loaded: true, id: 'gemini-stub' };
  return require('../core/stt-pool');
}

test.afterEach(() => {
  delete process.env.WHISPER_WAKE_BINARY;
  delete require.cache[require.resolve('../core/gemini')];
});

test('stt-pool: whisper runs without blocking the event loop', async () => {
  const projectDir = fakeProject('sleep 0.4; echo "jarvis open safari"');
  const { STTPool } = loadPool();
  const pool = new STTPool({ size: 0, projectDir, env: () => '' });

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  const result = await pool.recognize(Buffer.from('RIFF'), 'en-US');
  clearInterval(timer);

  assert.equal(result.text, 'jarvis open safari');
  assert.ok(ticks >= 10, `event loop stalled during whisper (only ${ticks} ticks in ~400 ms)`);
});

test('stt-pool: localOnly never sends noise to a paid cloud STT', async () => {
  const projectDir = fakeProject('echo "[BLANK_AUDIO]"');
  let cloudCalls = 0;
  const { STTPool } = loadPool({ hasGemini: () => true, transcribeAudio: async () => { cloudCalls += 1; return 'noise'; } });
  const pool = new STTPool({ size: 0, projectDir, env: () => '' });

  const wake = await pool.recognize(Buffer.from('RIFF'), 'en-US', { localOnly: true });
  assert.deepEqual(wake, { status: 'error', text: '', reason: 'no-speech' });
  assert.equal(cloudCalls, 0);

  const command = await pool.recognize(Buffer.from('RIFF'), 'en-US');
  assert.equal(command.provider, 'gemini-direct');
  assert.equal(cloudCalls, 1);
});
