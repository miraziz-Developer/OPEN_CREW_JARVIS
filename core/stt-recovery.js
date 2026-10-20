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

  // On the first turn after the wake word, Realtime's en-US transcript can turn an Uzbek
  // command into long, fluent-looking English. When the uz-UZ result is valid per policy,
  // a length-based score must not let such a wrong native guess win.
  if (options.preferAuthoritative && authoritative.usable) {
    return { source: 'authoritative', text: authoritative.text, authoritative, native };
  }
  if (authoritative.usable && (!native.usable || authoritative.score >= native.score - 8)) {
    return { source: 'authoritative', text: authoritative.text, authoritative, native };
  }
  if (native.usable) return { source: 'native-fallback', text: native.text, authoritative, native };
  if (authoritative.text && authoritative.score >= native.score) {
    return { source: 'authoritative-low-quality', text: authoritative.text, authoritative, native };
  }
  return { source: native.text ? 'native-low-quality' : 'none', text: native.text, authoritative, native };
}

// Used to start replying at once, without waiting for the authoritative Azure STT, when
// the Realtime API's own (native) transcript is accurate ENOUGH. Deliberately stricter
// than chooseTranscript()'s "usable" threshold: one- or two-word commands (e.g.
// "Musiqani to'xtat", 2 tokens) still wait for the authoritative STT; only clear,
// multi-word, low-risk commands pass immediately. Empirical calibration (via the
// core/stt-recovery.js smoke test): "Chrome ni och" (3 tokens) ~64 points, "Xo'p, Chrome
// dasturini och" (4 tokens) ~87, "Musiqani to'xtat" (2 tokens) 60 points but fails the
// token-count gate; confirmations like "ha"/"xo'p" are rejected by the policy itself.
function nativeIsConfident(text, options = {}) {
  const quality = transcriptQuality(text, options);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 60;
  const minTokens = Number.isFinite(options.minTokens) ? options.minTokens : 3;
  return quality.usable && quality.score >= minScore && quality.tokens >= minTokens;
}

function authoritativeTimeoutMs(audioBytes, options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const bytesPerSample = options.bytesPerSample || 2;
  const durationMs = Math.max(0, Number(audioBytes) || 0) / (sampleRate * bytesPerSample) * 1000;
  const floorMs = options.floorMs || 2200;
  const ceilingMs = options.ceilingMs || 5200;
  return Math.round(Math.max(floorMs, Math.min(ceilingMs, 1800 + durationMs * 0.55)));
}

module.exports = { transcriptQuality, chooseTranscript, authoritativeTimeoutMs, nativeIsConfident };