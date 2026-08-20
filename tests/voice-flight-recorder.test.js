'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VoiceFlightRecorder, redactText } = require('../core/voice-flight-recorder');

test('redacts transcript text by default and never stores raw audio', () => {
  let now = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-flight-'));
  const file = path.join(dir, 'voice.jsonl');
  const recorder = new VoiceFlightRecorder({ file, now: () => now, secret: 'test' });
  recorder.beginSession({ trigger: 'wake-word' });
  recorder.beginTurn({ source: 'realtime' });
  now += 120;
  recorder.textEvent('stt.final', 'maxfiy buyruq matni');
  recorder.event('audio.sample', { pcm: Buffer.from('secret-audio'), rms: 44 });
  now += 100;
  recorder.textEvent('command.accepted', 'maxfiy buyruq matni');
  now += 300;
  recorder.event('assistant.audio.first');
  now += 200;
  recorder.event('turn.completed');

  const contents = fs.readFileSync(file, 'utf8');
  assert.equal(contents.includes('maxfiy buyruq matni'), false);
  assert.equal(contents.includes('secret-audio'), false);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.recentTurns[0].timeToFirstAudioMs, 520);
  assert.equal(snapshot.recentTurns[0].responseToFirstAudioMs, 300);
  assert.equal(snapshot.privacy.rawAudioStored, false);
});

test('can include bounded text only with explicit opt-in', () => {
  const value = redactText('Salom Jarvis', { includeText: true, maxTextChars: 5, secret: 'x' });
  assert.equal(value.text, 'Salom');
  assert.equal(value.chars, 12);
  assert.equal(value.fingerprint.length, 16);
});

test('summarizes suppressed turns and percentile latency', () => {
  let now = 0;
  const recorder = new VoiceFlightRecorder({ file: path.join(os.tmpdir(), `jarvis-${Date.now()}.jsonl`), now: () => now });
  recorder.beginSession();
  recorder.beginTurn();
  recorder.event('command.accepted');
  now = 100;
  recorder.event('assistant.audio.first');
  recorder.event('turn.completed');
  now = 200;
  recorder.beginTurn();
  now = 500;
  recorder.event('turn.suppressed', { reason: 'echo' });
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.totals.turns, 2);
  assert.equal(snapshot.totals.suppressed, 1);
  assert.equal(snapshot.latency.timeToFirstAudioP50Ms, 100);
});