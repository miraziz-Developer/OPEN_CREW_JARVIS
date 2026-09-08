'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, validateConfig, redactConfig } = require('../core/config');

const valid = {
  AZURE_SPEECH_KEY: 'speech-secret-value',
  AZURE_SPEECH_REGION: 'southeastasia',
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_KEY: 'openai-secret-value',
  AZURE_OPENAI_DEPLOYMENT: 'model',
  OPENCLAW_GATEWAY_TOKEN: 'gateway-secret-value'
};

test('env parser handles comments, export and quoted values', () => {
  assert.deepEqual(parseEnv('# comment\nexport A=true\nB="hello world"\nINVALID\n'), { A: 'true', B: 'hello world' });
});

test('config schema converts typed values and applies defaults', () => {
  const result = validateConfig({ ...valid, REALTIME_IDLE_MS: '25000', REALTIME_ENABLED: 'false' });
  assert.equal(result.ok, true);
  assert.equal(result.values.REALTIME_IDLE_MS, 25000);
  assert.equal(result.values.REALTIME_ENABLED, false);
  assert.equal(result.values.REALTIME_MAX_RESPONSE_TOKENS, 512);
  assert.equal(result.values.REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS, 256);
  assert.equal(result.values.DASHBOARD_PORT, 7890);
  assert.equal(result.values.JARVIS_VOICE_STYLE, 'cinematic-robot');
  assert.equal(result.values.REALTIME_TRANSCRIPTION_LANGUAGE, 'en');
  assert.equal(result.values.AZURE_SPEECH_VOICE, 'en-US-GuyNeural');
  assert.equal(result.values.AZURE_SPEECH_LANGUAGE, 'en-US');
  assert.equal(result.values.DEEP_THINK_MODEL, 'gpt-6-astra');
  assert.equal(result.values.DEEP_THINK_TIMEOUT_MS, 90000);
  assert.equal(result.values.DEEP_THINK_MAX_TOKENS, 1200);
  assert.equal(result.values.TURN_STALE_TIMEOUT_MS, 600000);
  assert.equal(result.values.CONVERSATION_FOLLOWUP_MS, 20000);
  assert.equal(result.values.ACTION_CONFIRMATION_TTL_MS, 30000);
  assert.equal(result.values.TURN_JOURNAL_MAX_BYTES, 8388608);
  assert.equal(result.values.TURN_JOURNAL_RETENTION_FILES, 5);
  assert.equal(result.values.JARVIS_PRIVACY_MODE, false);
  assert.equal(result.values.JARVIS_FOCUS_MODE, false);
  assert.equal(result.values.JARVIS_MEETING_MODE, false);
  assert.equal(result.values.MIC_FILTER_ENABLED, true);
  assert.equal(result.values.MIC_HIGHPASS_HZ, 80);
  assert.equal(result.values.MIC_LOWPASS_HZ, 7600);
  assert.equal(result.values.OPENWAKEWORD_CONFIRM_THRESHOLD, 0.06);
  assert.equal(result.values.OPENWAKEWORD_CONFIRM_WINDOW_FRAMES, 4);
  assert.equal(result.values.OPENWAKEWORD_INPUT_GAIN, 3);
  assert.equal(result.values.AZURE_SPEECH_KEY, 'speech-secret-value');
});

test('config rejects placeholders and out of range values', () => {
  const result = validateConfig({ ...valid, AZURE_SPEECH_KEY: '...', DAILY_REPORT_HOUR: '42' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => error.key).sort(), ['AZURE_SPEECH_KEY', 'DAILY_REPORT_HOUR']);
});

test('config redaction never exposes secret values', () => {
  const result = validateConfig(valid);
  const safe = redactConfig(result.values);
  assert.equal(safe.AZURE_SPEECH_KEY, '<redacted>');
  assert.equal(safe.AZURE_OPENAI_KEY, '<redacted>');
  assert.equal(safe.OPENCLAW_GATEWAY_TOKEN, '<redacted>');
  assert.equal(safe.AZURE_SPEECH_REGION, 'southeastasia');
});