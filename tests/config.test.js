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
  assert.equal(result.values.REALTIME_MAX_RESPONSE_TOKENS, 500);
  assert.equal(result.values.REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS, 256);
  assert.equal(result.values.REALTIME_VAD_SILENCE_MS, 180);
  assert.equal(result.values.REALTIME_NORMAL_DUPLEX_HANGOVER_MS, 330);
  assert.equal(result.values.REALTIME_PLAYBACK_PREBUFFER_MS, 40);
  assert.equal(result.values.REALTIME_PLAYBACK_MAX_WAIT_MS, 80);
  assert.equal(result.values.DASHBOARD_PORT, 7890);
  assert.equal(result.values.JARVIS_VOICE_STYLE, 'cinematic-robot');
  assert.equal(result.values.REALTIME_TRANSCRIPTION_LANGUAGE, '');
  assert.equal(result.values.AZURE_SPEECH_VOICE, 'en-US-GuyNeural');
  assert.equal(result.values.AZURE_SPEECH_LANGUAGE, 'en-US');
  assert.equal(result.values.AZURE_SPEECH_RATE_PERCENT, -12);
  assert.equal(result.values.AZURE_SPEECH_PITCH_PERCENT, -12);
  assert.equal(result.values.REALTIME_BARGE_IN_CONFIRM_MS, 420);
  assert.equal(result.values.REALTIME_BARGE_IN_MAX_GAP_MS, 80);
  assert.equal(result.values.DEEP_THINK_FAST_MODEL, 'grok-4-1-fast-reasoning');
  assert.equal(result.values.DEEP_THINK_COMPLEX_MODEL, 'gpt-5.6-sol');
  assert.equal(result.values.OPENCLAW_AGENT_TIMEOUT_MS, 300000);
  assert.equal(result.values.DEEP_THINK_TIMEOUT_MS, 240000);
  assert.equal(result.values.AGENT_LONG_TASK_NOTICE_MS, 270000);
  assert.equal(result.values.SELF_HEAL_ENABLED, true);
  assert.equal(result.values.SELF_HEAL_MAX_ATTEMPTS, 2);
  assert.equal(result.values.SELF_HEAL_TIMEOUT_MS, 180000);
  assert.equal(result.values.AGENT_PERSISTENT_RECOVERY_WINDOW_MS, 2592000000);
  assert.equal(result.values.GMAIL_TASK_NOTIFICATIONS_ENABLED, false);
  assert.equal(result.values.GMAIL_TASK_PROGRESS_MS, 21600000);
  assert.equal(result.values.DEEP_THINK_MAX_TOKENS, 1200);
  assert.equal(result.values.AZURE_TERRA_DEPLOYMENT, 'gpt-5.6-terra');
  assert.equal(result.values.AZURE_VOICELIVE_MODEL, 'gpt-realtime');
  assert.equal(result.values.AZURE_VOICELIVE_VOICE, 'en-US-OnyxTurboMultilingualNeural');
  assert.equal(result.values.AZURE_REALTIME_DEPLOYMENT, 'gpt-realtime-1.5');
  assert.equal(result.values.AZURE_TRANSCRIBE_DEPLOYMENT, 'gpt-live-transcribe');
  assert.equal(result.values.AZURE_EMBEDDING_DEPLOYMENT, 'text-embedding-3-large-2');
  assert.equal(result.values.TURN_STALE_TIMEOUT_MS, 600000);
  assert.equal(result.values.CONVERSATION_FOLLOWUP_MS, 60000);
  assert.equal(result.values.ACTION_CONFIRMATION_TTL_MS, 30000);
  assert.equal(result.values.JARVIS_FULL_AUTONOMY, false);
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
  assert.equal(result.values.REALTIME_INPUT_GAIN, 3);
  assert.equal(result.values.OPENWAKEWORD_RESTART_BASE_MS, 2000);
  assert.equal(result.values.OPENWAKEWORD_RESTART_MAX_MS, 30000);
  assert.equal(result.values.OPENWAKEWORD_MODELS, 'hey_jarvis');
  assert.equal(result.values.WHISPER_WAKE_ENABLED, false);
  assert.equal(result.values.WHISPER_WAKE_WINDOW_MS, 3000);
  assert.equal(result.values.AZURE_SPEECH_KEY, 'speech-secret-value');
});

test('config parses the full autonomy flag', () => {
  const result = validateConfig({ ...valid, JARVIS_FULL_AUTONOMY: 'true' });
  assert.equal(result.ok, true);
  assert.equal(result.values.JARVIS_FULL_AUTONOMY, true);
});

test('config rejects placeholders and out of range values', () => {
  const result = validateConfig({ ...valid, AZURE_SPEECH_KEY: '...', DAILY_REPORT_HOUR: '42' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => error.key).sort(), ['AZURE_SPEECH_KEY', 'DAILY_REPORT_HOUR']);
});

test('config permits disabling the wake single-frame bypass above one', () => {
  const result = validateConfig({ ...valid, OPENWAKEWORD_STRONG_THRESHOLD: '1.01' });
  assert.equal(result.ok, true);
  assert.equal(result.values.OPENWAKEWORD_STRONG_THRESHOLD, 1.01);
});

test('config redaction never exposes secret values', () => {
  const result = validateConfig(valid);
  const safe = redactConfig(result.values);
  assert.equal(safe.AZURE_SPEECH_KEY, '<redacted>');
  assert.equal(safe.AZURE_OPENAI_KEY, '<redacted>');
  assert.equal(safe.OPENCLAW_GATEWAY_TOKEN, '<redacted>');
  assert.equal(safe.AZURE_SPEECH_REGION, 'southeastasia');
});

test('enabled Gmail task notifications require a valid owner recipient', () => {
  const missingOwner = validateConfig({ ...valid, GMAIL_TASK_NOTIFICATIONS_ENABLED: 'true' });
  assert.equal(missingOwner.ok, false);
  assert.equal(missingOwner.errors.at(-1).key, 'GMAIL_OWNER_RECIPIENT');
  const configured = validateConfig({ ...valid, GMAIL_TASK_NOTIFICATIONS_ENABLED: 'true', GMAIL_OWNER_RECIPIENT: 'owner@example.com' });
  assert.equal(configured.ok, true);
});

test('new provider secrets are redacted and partial credential pairs fail', () => {
  const complete = validateConfig({ ...valid, AZURE_VOICELIVE_ENDPOINT: 'https://voice.example.com', AZURE_VOICELIVE_KEY: 'voice-secret' });
  assert.equal(complete.ok, true);
  assert.equal(redactConfig(complete.values).AZURE_VOICELIVE_KEY, '<redacted>');
  const partial = validateConfig({ ...valid, AZURE_REALTIME_ENDPOINT: 'https://realtime.example.com' });
  assert.equal(partial.ok, false);
  assert.equal(partial.errors.at(-1).code, 'conditional');
});

test('Foundry realtime WebSocket endpoints are valid configuration', () => {
  const result = validateConfig({
    ...valid,
    AZURE_REALTIME_ENDPOINT: 'wss://realtime.openai.azure.com/openai/v1/realtime?model=gpt-realtime-1.5',
    AZURE_REALTIME_KEY: 'realtime-secret'
  });

  assert.equal(result.ok, true);
  assert.equal(result.values.AZURE_REALTIME_ENDPOINT, 'wss://realtime.openai.azure.com/openai/v1/realtime?model=gpt-realtime-1.5');
});

test('opt-in whisper wake requires both deployed binary and model paths', () => {
  const incomplete = validateConfig({ ...valid, WHISPER_WAKE_ENABLED: 'true', WHISPER_WAKE_BINARY: '/opt/whisper-cli' });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.errors.at(-1).key, 'WHISPER_WAKE_BINARY');
  const complete = validateConfig({
    ...valid, WHISPER_WAKE_ENABLED: 'true',
    WHISPER_WAKE_BINARY: '/opt/whisper-cli', WHISPER_WAKE_MODEL: '/opt/ggml-tiny.en.bin'
  });
  assert.equal(complete.ok, true);
});