'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, validateConfig, redactConfig } = require('../core/config');

const valid = {
  AZURE_SPEECH_KEY: 'speech-secret-value',
  AZURE_SPEECH_REGION: 'southeastasia',
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_KEY: 'openai-secret-value',
  AZURE_OPENAI_DEPLOYMENT: 'model'
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
  assert.equal(result.values.JARVIS_VOICE_STYLE, 'cinematic-uzbek');
  assert.equal(result.values.UZBEK_SPEECH_NORMALIZATION, true);
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
  assert.equal(safe.AZURE_SPEECH_REGION, 'southeastasia');
});