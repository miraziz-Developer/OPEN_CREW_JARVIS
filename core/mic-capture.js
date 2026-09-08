'use strict';

/**
 * SoX mikrofon oqimi uchun argumentlar. Nutq diapazonidan tashqaridagi past
 * g'uvillash va yuqori shovqinni STT/wake-word'ga yetib bormasidan kesadi.
 * Filtrlar causal bo'lgani uchun realtime oqimga sezilarli buffering qo'shmaydi.
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
    throw new RangeError(`MIC_HIGHPASS_HZ 0 dan katta va ${nyquist} dan kichik bo'lishi kerak`);
  }
  if (lowpassHz <= highpassHz || lowpassHz >= nyquist) {
    throw new RangeError(`MIC_LOWPASS_HZ ${highpassHz} dan katta va ${nyquist} dan kichik bo'lishi kerak`);
  }

  return ['highpass', '-2', String(highpassHz), 'lowpass', '-2', String(lowpassHz)];
}

module.exports = { buildSoxCaptureArgs, buildSpeechFilterArgs };