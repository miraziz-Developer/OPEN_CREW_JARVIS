'use strict';

const { classifyUserTurn, normalize } = require('./voice-turn-policy');

function transcriptQuality(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return { usable: false, score: 0, reason: 'empty', text: '' };
  const normalized = normalize(value);
  const tokens = normalized.split(' ').filter(Boolean);
  const policy = classifyUserTurn(value, options.context || {});
  const confidence = Number.isFinite(options.confidence) ? options.confidence : null;
  let score = Math.min(55, normalized.length * 1.4) + Math.min(30, tokens.length * 7);
  if (policy.accept) score += 25;
  else score -= policy.reason === 'acknowledgement' ? 5 : 35;
  if (confidence !== null) score += Math.max(-20, Math.min(20, (confidence - 0.5) * 40));
  return {
    text: value,
    normalized,
    tokens: tokens.length,
    confidence,
    usable: policy.accept,
    reason: policy.reason,
    score: Math.round(score * 100) / 100
  };
}

function chooseTranscript(authoritativeResult, nativeText, options = {}) {
  const authoritative = transcriptQuality(authoritativeResult?.text, {
    confidence: authoritativeResult?.confidence,
    context: options.context
  });
  const native = transcriptQuality(nativeText, { context: options.context });

  if (authoritative.usable && (!native.usable || authoritative.score >= native.score - 8)) {
    return { source: 'authoritative', text: authoritative.text, authoritative, native };
  }
  if (native.usable) return { source: 'native-fallback', text: native.text, authoritative, native };
  if (authoritative.text && authoritative.score >= native.score) {
    return { source: 'authoritative-low-quality', text: authoritative.text, authoritative, native };
  }
  return { source: native.text ? 'native-low-quality' : 'none', text: native.text, authoritative, native };
}

function authoritativeTimeoutMs(audioBytes, options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const bytesPerSample = options.bytesPerSample || 2;
  const durationMs = Math.max(0, Number(audioBytes) || 0) / (sampleRate * bytesPerSample) * 1000;
  const floorMs = options.floorMs || 2200;
  const ceilingMs = options.ceilingMs || 5200;
  return Math.round(Math.max(floorMs, Math.min(ceilingMs, 1800 + durationMs * 0.55)));
}

module.exports = { transcriptQuality, chooseTranscript, authoritativeTimeoutMs };