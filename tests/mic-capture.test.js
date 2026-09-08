'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSoxCaptureArgs, buildSpeechFilterArgs } = require('../core/mic-capture');

test('SoX capture applies a low-latency speech-band filter by default', () => {
  assert.deepEqual(buildSoxCaptureArgs(), [
    '-q', '-d', '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16',
    '-e', 'signed-integer', '-',
    'highpass', '-2', '80', 'lowpass', '-2', '7600'
  ]);
});

test('SoX capture filter can be disabled without changing PCM format', () => {
  const args = buildSoxCaptureArgs({ filterEnabled: false });
  assert.deepEqual(args, [
    '-q', '-d', '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16',
    '-e', 'signed-integer', '-'
  ]);
});

test('speech filter arguments can be reused by calibration and diagnostics', () => {
  assert.deepEqual(buildSpeechFilterArgs({ sampleRate: 16000, highpassHz: 100, lowpassHz: 7000 }), [
    'highpass', '-2', '100', 'lowpass', '-2', '7000'
  ]);
  assert.deepEqual(buildSpeechFilterArgs({ filterEnabled: false }), []);
});

test('SoX capture validates filter frequencies against Nyquist', () => {
  assert.throws(() => buildSoxCaptureArgs({ highpassHz: 8000 }), /MIC_HIGHPASS_HZ/);
  assert.throws(() => buildSoxCaptureArgs({ highpassHz: 100, lowpassHz: 100 }), /MIC_LOWPASS_HZ/);
  assert.throws(() => buildSoxCaptureArgs({ lowpassHz: 8000 }), /MIC_LOWPASS_HZ/);
});