'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PcmPlaybackBuffer } = require('../core/pcm-playback-buffer');

function pcmFor(ms, sampleRate = 24000) {
  return Buffer.alloc(Math.round(sampleRate * 2 * ms / 1000), 1);
}

test('playback prebuffer combines initial realtime chunks before writing', () => {
  const writes = [];
  const playback = new PcmPlaybackBuffer({
    sampleRate: 24000,
    prebufferMs: 200,
    maxWaitMs: 1000,
    onData: audio => writes.push(audio)
  });

  playback.push(pcmFor(80));
  playback.push(pcmFor(80));
  assert.equal(writes.length, 0);

  playback.push(pcmFor(50));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, pcmFor(210).length);

  playback.push(pcmFor(40));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].length, pcmFor(40).length);
  playback.reset();
});

test('finish releases a short response without waiting for prebuffer timeout', () => {
  const writes = [];
  const playback = new PcmPlaybackBuffer({
    sampleRate: 24000,
    prebufferMs: 240,
    maxWaitMs: 1000,
    onData: audio => writes.push(audio)
  });

  playback.push(pcmFor(90));
  assert.equal(writes.length, 0);
  playback.finish();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, pcmFor(90).length);
});

test('reset drops buffered audio after barge-in', () => {
  const writes = [];
  const playback = new PcmPlaybackBuffer({
    sampleRate: 24000,
    prebufferMs: 240,
    maxWaitMs: 1000,
    onData: audio => writes.push(audio)
  });

  playback.push(pcmFor(100));
  playback.reset();
  playback.finish();
  assert.deepEqual(writes, []);
});

test('reset starts a fresh prebuffer for the next response', () => {
  const writes = [];
  const playback = new PcmPlaybackBuffer({
    sampleRate: 24000,
    prebufferMs: 200,
    maxWaitMs: 1000,
    onData: audio => writes.push(audio)
  });

  playback.push(pcmFor(220));
  assert.equal(writes.length, 1);
  playback.reset();
  playback.push(pcmFor(80));
  assert.equal(writes.length, 1);
  playback.finish();
  assert.equal(writes.length, 2);
});