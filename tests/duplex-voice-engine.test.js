'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuplexVoiceEngine } = require('../core/duplex-voice-engine');

function tone(samples, amplitude, phase = 0) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 7 + phase) * amplitude), i * 2);
  return buffer;
}

test('pure playback echo is suppressed while assistant speaks', () => {
  const engine = new DuplexVoiceEngine({ bargeInResidual: 500 });
  const playback = tone(480, 4000);
  engine.queuePlayback(playback);
  const result = engine.process(Buffer.from(playback), { assistantSpeaking: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'echo');
});

test('near-end speech over playback is preserved as barge-in', () => {
  const engine = new DuplexVoiceEngine({ bargeInResidual: 300 });
  const playback = tone(480, 3500);
  const user = tone(480, 1800, 1.7);
  const mixed = Buffer.alloc(playback.length);
  for (let i = 0; i < mixed.length; i += 2) mixed.writeInt16LE(Math.max(-32768, Math.min(32767, playback.readInt16LE(i) + user.readInt16LE(i))), i);
  engine.queuePlayback(playback);
  const result = engine.process(mixed, { assistantSpeaking: true });
  assert.equal(result.send, true);
  assert.equal(result.reason, 'barge-in');
});

test('low residual playback noise is not forwarded as barge-in', () => {
  const engine = new DuplexVoiceEngine({
    noiseFloor: 80,
    noiseMultiplier: 2,
    bargeInResidual: 650
  });
  const result = engine.process(tone(480, 400), { assistantSpeaking: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'playback-noise');
});

test('quiet idle noise is gated', () => {
  const engine = new DuplexVoiceEngine({ noiseFloor: 100 });
  assert.equal(engine.process(tone(480, 20), { assistantSpeaking: false }).reason, 'noise');
});

test('adaptive noise floor learns stable room noise without swallowing speech', () => {
  const engine = new DuplexVoiceEngine({ noiseFloor: 40, noiseMultiplier: 2, noiseAlpha: 0.2 });
  for (let i = 0; i < 20; i++) engine.process(tone(480, 120, i), { assistantSpeaking: false });
  const profile = engine.snapshot();
  assert.ok(profile.estimatedNoiseRms > 40);
  assert.equal(engine.process(tone(480, 130), { assistantSpeaking: false }).send, false);
  assert.equal(engine.process(tone(480, 900), { assistantSpeaking: false }).reason, 'speech');
});

test('speech hangover forwards trailing silence so remote VAD can close the turn', () => {
  const engine = new DuplexVoiceEngine({ noiseFloor: 100, hangoverMs: 100 });
  assert.equal(engine.process(tone(480, 1000), { assistantSpeaking: false }).reason, 'speech');
  assert.equal(engine.process(tone(480, 10), { assistantSpeaking: false }).reason, 'hangover');
});

test('delayed inverted playback echo is aligned and suppressed', () => {
  const engine = new DuplexVoiceEngine({ bargeInResidual: 300, maxEchoLagMs: 100 });
  const delay = Buffer.alloc(240 * 2);
  const playback = tone(480, 3500);
  engine.queuePlayback(Buffer.concat([delay, playback]));
  const inverted = Buffer.alloc(playback.length);
  for (let i = 0; i < playback.length; i += 2) inverted.writeInt16LE(-playback.readInt16LE(i), i);
  const result = engine.process(inverted, { assistantSpeaking: true });
  assert.equal(result.reason, 'echo');
});