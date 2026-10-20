'use strict';

const fs = require('fs');
const path = require('path');
const { rms } = require('./duplex-voice-engine');

const PROFILE_VERSION = 1;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const index = clamp(Math.ceil(sorted.length * ratio) - 1, 0, sorted.length - 1);
  return sorted[index];
}

function chunkRms(buffer, sampleRate = 16000, chunkMs = 40) {
  const bytes = Math.max(2, Math.floor(sampleRate * chunkMs / 1000) * 2);
  const values = [];
  for (let offset = 0; offset + bytes <= buffer.length; offset += bytes) values.push(rms(buffer.subarray(offset, offset + bytes)));
  return values;
}

function pcmFromWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') return Buffer.from(buffer || []);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error('No PCM data chunk found in the WAV');
}

function estimateEchoLag(recording, probe, { sampleRate = 16000, expectedStartMs = 400, searchMs = 450 } = {}) {
  const recorded = pcmFromWav(recording);
  const reference = pcmFromWav(probe);
  const expected = Math.floor(expectedStartMs * sampleRate / 1000);
  const radius = Math.floor(searchMs * sampleRate / 1000);
  const refSamples = Math.min(reference.length / 2, Math.floor(sampleRate * 0.45));
  if (refSamples < 400 || recorded.length / 2 < expected + refSamples) return null;
  let best = { score: -Infinity, offset: expected };
  const stride = 8;
  for (let offset = Math.max(0, expected - radius); offset <= Math.min(recorded.length / 2 - refSamples, expected + radius); offset += stride) {
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < refSamples; i += 4) {
      const a = reference.readInt16LE(i * 2);
      const b = recorded.readInt16LE((offset + i) * 2);
      dot += a * b; aa += a * a; bb += b * b;
    }
    const score = Math.abs(dot) / Math.sqrt(Math.max(1, aa * bb));
    if (score > best.score) best = { score, offset };
  }
  if (best.score < 0.12) return null;
  return { lagMs: Math.max(0, Math.round((best.offset - expected) * 1000 / sampleRate)), correlation: Math.round(best.score * 1000) / 1000 };
}

function buildCalibration({ silence, speech, echo = null, sampleRate = 16000, now = () => Date.now() }) {
  const quiet = chunkRms(pcmFromWav(silence), sampleRate).filter(value => value > 0);
  const spoken = chunkRms(pcmFromWav(speech), sampleRate).filter(value => value > 0);
  if (quiet.length < 20) throw new Error('At least 0.8 seconds of room silence is needed');
  if (spoken.length < 20) throw new Error('At least 0.8 seconds of speech sample is needed');

  const noiseP50 = percentile(quiet, 0.5);
  const noiseP95 = percentile(quiet, 0.95);
  // Only chunks well above the room P95 count as speech, to drop the pauses inside the
  // speech sample.
  const activeSpeech = spoken.filter(value => value >= Math.max(noiseP95 * 1.8, 60));
  if (activeSpeech.length < 8) throw new Error('The speech sample is too quiet or missing');
  const speechP20 = percentile(activeSpeech, 0.2);
  const speechP50 = percentile(activeSpeech, 0.5);
  const separation = speechP20 / Math.max(noiseP95, 1);
  if (separation < 1.6) throw new Error('Speech and room noise are not separated enough; move the microphone closer');

  // P95 also includes short click/echo bursts. P50 is the base floor; P95 should remain
  // only a limited margin.
  const noiseFloor = Math.round(clamp(Math.max(
    noiseP50 * 1.15,
    Math.min(noiseP95 * 1.15, noiseP50 * 1.8)
  ), 20, 1200));
  const desiredThreshold = Math.sqrt(Math.max(noiseFloor, 1) * speechP20);
  // The engine threshold is noiseFloor × multiplier; dividing by P50 would add the
  // P50/P95 gap a second time.
  const noiseMultiplier = Math.round(clamp(desiredThreshold / Math.max(noiseFloor, 1), 1.35, 4.5) * 100) / 100;
  // During playback, speaker reverberation left over after AEC can be much louder than
  // ordinary room noise. At 42% of speech P20, a real device took echo as near-end speech
  // for 360 ms and cut a finished reply with client_cancelled. Barge-in threshold is 70% of
  // P20, keeping quiet speech while leaving enough margin for echo.
  const bargeInResidual = Math.round(clamp(speechP20 * 0.70, 300, 3200));
  const inputGain = Math.round(clamp(1800 / Math.max(speechP50, 1), 1, 6) * 100) / 100;
  const echoLagMs = Number.isFinite(echo?.lagMs) ? Math.round(clamp(echo.lagMs, 20, 500)) : null;

  return {
    version: PROFILE_VERSION,
    createdAt: new Date(now()).toISOString(),
    sampleRate,
    measurements: {
      noiseRmsP50: Math.round(noiseP50), noiseRmsP95: Math.round(noiseP95),
      speechRmsP20: Math.round(speechP20), speechRmsP50: Math.round(speechP50),
      speechNoiseSeparation: Math.round(separation * 100) / 100,
      echoLagMs
    },
    recommended: {
      DUPLEX_NOISE_FLOOR: noiseFloor,
      DUPLEX_NOISE_MULTIPLIER: noiseMultiplier,
      DUPLEX_BARGE_IN_RMS: bargeInResidual,
      REALTIME_INPUT_GAIN: inputGain,
      ...(echoLagMs ? { DUPLEX_MAX_ECHO_LAG_MS: Math.round(clamp(echoLagMs + 40, 80, 500)) } : {})
    },
    privacy: { rawAudioStored: false, containsVoiceText: false }
  };
}

function saveCalibration(file, profile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return profile;
}

function loadCalibration(file) {
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    return profile?.version === PROFILE_VERSION && profile?.recommended ? profile : null;
  } catch (_) { return null; }
}

function resolveCalibratedNumber(name, rawEnv, profile, fallback) {
  const explicit = rawEnv?.[name];
  if (explicit !== undefined && String(explicit).trim() !== '') {
    const value = Number(explicit);
    if (Number.isFinite(value)) return value;
  }
  const calibrated = Number(profile?.recommended?.[name]);
  return Number.isFinite(calibrated) ? calibrated : fallback;
}

function resolveBargeInResidual(rawEnv, profile, fallback = 900) {
  const explicit = rawEnv?.DUPLEX_BARGE_IN_RMS;
  if (explicit !== undefined && String(explicit).trim() !== '') {
    const value = Number(explicit);
    if (Number.isFinite(value)) return value;
  }
  const recommended = Number(profile?.recommended?.DUPLEX_BARGE_IN_RMS);
  const speechP20 = Number(profile?.measurements?.speechRmsP20);
  // Old version-1 profiles may still contain the former 42% recommendation.
  // Recompute a safe floor from their retained numeric measurement so users do
  // not need to speak through calibration again merely to receive this fix.
  const measuredFloor = Number.isFinite(speechP20)
    ? Math.round(clamp(speechP20 * 0.70, 300, 3200))
    : NaN;
  return Math.max(
    Number.isFinite(recommended) ? recommended : fallback,
    Number.isFinite(measuredFloor) ? measuredFloor : fallback
  );
}

module.exports = {
  PROFILE_VERSION, percentile, chunkRms, pcmFromWav, estimateEchoLag,
  buildCalibration, saveCalibration, loadCalibration, resolveCalibratedNumber,
  resolveBargeInResidual
};