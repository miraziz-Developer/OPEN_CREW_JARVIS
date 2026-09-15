'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhisperWakeDetector, normalizeTranscript, isJarvisWakeTranscript } = require('../core/whisper-wake-detector');

async function waitForIdle(detector) {
  while (detector.inFlight) await new Promise(resolve => setImmediate(resolve));
}

test('whisper wake matching accepts Jarvis as a standalone normalized word only', () => {
  assert.equal(normalizeTranscript('  JÀRVIS, hello! '), 'jarvis hello');
  assert.equal(isJarvisWakeTranscript('Hey, Jarvis!'), true);
  assert.equal(isJarvisWakeTranscript('jarvisning'), false);
  assert.equal(isJarvisWakeTranscript('jarvis2'), false);
});

test('whisper wake detector transcribes bounded windows and debounces repeated wake transcripts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-whisper-test-'));
  const binary = path.join(root, 'whisper-cli');
  const model = path.join(root, 'tiny.bin');
  fs.writeFileSync(binary, 'fake');
  fs.writeFileSync(model, 'fake');
  let now = 10_000;
  const wakes = [];
  const fakeSpawn = (_command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      fs.writeFileSync(args[args.indexOf('-of') + 1] + '.txt', 'Hey Jarvis');
      child.emit('close', 0);
    });
    return child;
  };
  const detector = new WhisperWakeDetector({
    binaryPath: binary, modelPath: model, sampleRate: 1000, windowMs: 1000,
    intervalMs: 1, cooldownMs: 5000, now: () => now, spawn: fakeSpawn,
    onWake: wake => wakes.push(wake)
  });
  try {
    assert.equal(detector.start(), true);
    detector.feedChunk(Buffer.alloc(2000));
    await waitForIdle(detector);
    assert.equal(wakes.length, 1);
    now += 100;
    detector.feedChunk(Buffer.alloc(2000));
    await waitForIdle(detector);
    assert.equal(wakes.length, 1);
    now += 5000;
    detector.feedChunk(Buffer.alloc(2000));
    await waitForIdle(detector);
    assert.equal(wakes.length, 2);
  } finally {
    detector.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});