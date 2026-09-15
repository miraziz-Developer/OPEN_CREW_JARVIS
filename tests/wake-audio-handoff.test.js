'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWakeAudioHandoff } = require('../core/wake-audio-handoff');

test('wake audio handoff suppresses chime audio and buffers post-chime speech', () => {
  let now = 1000;
  const handoff = createWakeAudioHandoff({ now: () => now, muteUntil: 1180, maxBytes: 8 });

  assert.equal(handoff.queue(Buffer.from('chime')), true);
  assert.equal(handoff.byteLength, 0);

  now = 1180;
  assert.equal(handoff.queue(Buffer.from('speech')), true);
  assert.equal(handoff.byteLength, 6);
  assert.deepEqual(Buffer.concat(handoff.drain()), Buffer.from('speech'));
});

test('wake audio handoff retains only bounded newest audio until ready', () => {
  const handoff = createWakeAudioHandoff({ muteUntil: 0, maxBytes: 5 });
  handoff.queue(Buffer.from('abc'));
  handoff.queue(Buffer.from('defg'));
  assert.equal(handoff.byteLength, 5);
  assert.deepEqual(Buffer.concat(handoff.drain()), Buffer.from('cdefg'));

  handoff.markReady();
  assert.equal(handoff.queue(Buffer.from('live')), false);
  assert.equal(handoff.byteLength, 0);
});

test('daemon wake handoff uses the bounded helper without stale legacy state', () => {
  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'jarvis_daemon.js'), 'utf8');
  assert.match(daemonSource, /createWakeAudioHandoff/);
  for (const staleName of ['wakeAudioPending', 'wakePreroll', 'wakePrerollBytes']) {
    assert.doesNotMatch(daemonSource, new RegExp(`\\b${staleName}\\b`), staleName);
  }
});