'use strict';

/**
 * SoX arguments for the microphone stream. Cuts low hum and high noise outside the speech
 * range before they reach STT/wake word. The filters are causal, so they add no noticeable
 * buffering to the realtime stream.
 */
function buildSoxCaptureArgs(options = {}) {
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 16000;
  const args = [
    '-q',
    '-d',
    '-t', 'raw',
    '-r', String(sampleRate),
    '-c', '1',
    '-b', '16',
    '-e', 'signed-integer',
    '-'
  ];

  return [...args, ...buildSpeechFilterArgs({ ...options, sampleRate })];
}

function buildSpeechFilterArgs(options = {}) {
  if (options.filterEnabled === false) return [];

  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 16000;
  const nyquist = sampleRate / 2;
  const highpassHz = Number.isFinite(options.highpassHz) ? options.highpassHz : 80;
  const lowpassHz = Number.isFinite(options.lowpassHz) ? options.lowpassHz : 7600;
  if (highpassHz <= 0 || highpassHz >= nyquist) {
    throw new RangeError(`MIC_HIGHPASS_HZ must be above 0 and below ${nyquist}`);
  }
  if (lowpassHz <= highpassHz || lowpassHz >= nyquist) {
    throw new RangeError(`MIC_LOWPASS_HZ must be above ${highpassHz} and below ${nyquist}`);
  }

  return ['highpass', '-2', String(highpassHz), 'lowpass', '-2', String(lowpassHz)];
}

module.exports = { buildSoxCaptureArgs, buildSpeechFilterArgs };