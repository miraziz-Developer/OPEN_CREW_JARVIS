'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCalibration, estimateEchoLag, resolveCalibratedNumber,
  resolveBargeInResidual
} = require('../core/audio-calibration');

function constant(seconds, amplitude, sampleRate = 16000) {
  const out = Buffer.alloc(seconds * sampleRate * 2);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(i % 8 < 4 ? amplitude : -amplitude, i);
  return out;
}

function deterministicNoise(seconds, amplitude, sampleRate = 16000) {
  const out = Buffer.alloc(seconds * sampleRate * 2);
  let state = 0x12345678;
  for (let i = 0; i < out.length; i += 2) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.writeInt16LE(Math.round((((state / 0xffffffff) * 2) - 1) * amplitude), i);
  }
  return out;
}

test('calibration separates room noise from speech and recommends bounded values', () => {
  const profile = buildCalibration({ silence: constant(2, 80), speech: constant(2, 1200), now: () => 0 });
  assert.equal(profile.createdAt, '1970-01-01T00:00:00.000Z');
  assert.ok(profile.recommended.DUPLEX_NOISE_FLOOR >= 80);
  assert.equal(profile.recommended.DUPLEX_BARGE_IN_RMS, 840);
  assert.ok(profile.recommended.REALTIME_INPUT_GAIN >= 1);
  assert.equal(profile.privacy.rawAudioStored, false);
});

test('explicit env overrides calibration, then fallback is used', () => {
  const profile = { recommended: { REALTIME_INPUT_GAIN: 2.2 } };
  assert.equal(resolveCalibratedNumber('REALTIME_INPUT_GAIN', {}, profile, 3), 2.2);
  assert.equal(resolveCalibratedNumber('REALTIME_INPUT_GAIN', { REALTIME_INPUT_GAIN: '4' }, profile, 3), 4);
  assert.equal(resolveCalibratedNumber('OTHER', {}, profile, 9), 9);
});

test('barge-in threshold upgrades old low recommendations from speech measurements', () => {
  const oldProfile = {
    measurements: { speechRmsP20: 1376 },
    recommended: { DUPLEX_BARGE_IN_RMS: 578 }
  };
  assert.equal(resolveBargeInResidual({}, oldProfile, 900), 963);
  assert.equal(resolveBargeInResidual({ DUPLEX_BARGE_IN_RMS: '740' }, oldProfile, 900), 740);
  assert.equal(resolveBargeInResidual({}, null, 900), 900);
});

test('echo estimator finds delayed probe', () => {
  const rate = 16000, probe = deterministicNoise(1, 2400), delayMs = 135;
  const expectedMs = 400;
  const recording = Buffer.concat([Buffer.alloc(Math.floor((expectedMs + delayMs) * rate / 1000) * 2), probe, Buffer.alloc(rate)]);
  const result = estimateEchoLag(recording, probe, { sampleRate: rate, expectedStartMs: expectedMs, searchMs: 250 });
  assert.ok(result);
  assert.ok(Math.abs(result.lagMs - delayMs) <= 2);
});

test('calibration rejects speech indistinguishable from noise', () => {
  assert.throws(() => buildCalibration({ silence: constant(2, 100), speech: constant(2, 120) }), /Nutq namunasi|yetarlicha ajralmadi/);
});