'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVoiceProviders } = require('../core/voice-provider');

function from(values) { return (key, fallback) => values[key] ?? fallback; }

test('Voice Live is primary and direct realtime is stable fallback', () => {
  const providers = buildVoiceProviders(from({
    AZURE_VOICELIVE_ENDPOINT: 'https://voice.services.ai.azure.com/',
    AZURE_VOICELIVE_KEY: 'voice-key',
    AZURE_REALTIME_ENDPOINT: 'https://stable.openai.azure.com/openai/v1',
    AZURE_REALTIME_KEY: 'realtime-key'
  }));
  assert.deepEqual(providers.map(provider => provider.id), ['voice-live', 'azure-realtime']);
  assert.equal(providers[0].url, 'wss://voice.services.ai.azure.com/voice-live/realtime?api-version=2026-04-10&model=gpt-realtime');
  assert.equal(providers[0].voice.name, 'en-US-OnyxTurboMultilingualNeural');
  assert.equal(providers[1].voice, 'shimmer');
  assert.equal(providers[1].url, 'wss://stable.openai.azure.com/openai/v1/realtime?model=gpt-realtime-1.5');
});

test('incomplete or placeholder provider credentials are ignored', () => {
  assert.deepEqual(buildVoiceProviders(from({ AZURE_VOICELIVE_ENDPOINT: 'https://voice.example.com', AZURE_VOICELIVE_KEY: '...' })), []);
});

test('Foundry full realtime WebSocket endpoint is normalized without duplicating its path', () => {
  const providers = buildVoiceProviders(from({
    AZURE_REALTIME_ENDPOINT: 'wss://stable.openai.azure.com/openai/v1/realtime?model=gpt-realtime-1.5',
    AZURE_REALTIME_KEY: 'realtime-key',
    AZURE_REALTIME_DEPLOYMENT: 'gpt-realtime-1.5'
  }));

  assert.equal(providers[0].url, 'wss://stable.openai.azure.com/openai/v1/realtime?model=gpt-realtime-1.5');
});
test('OpenAI voices are passed to Voice Live natively while Azure neural voices keep the azure-standard shape', () => {
  const base = { AZURE_VOICELIVE_ENDPOINT: 'https://voice.services.ai.azure.com/', AZURE_VOICELIVE_KEY: 'k' };
  assert.equal(buildVoiceProviders(from({ ...base, JARVIS_VOICE: 'alloy' }))[0].voice, 'alloy');
  assert.deepEqual(buildVoiceProviders(from({ ...base, JARVIS_VOICE: 'en-US-AndrewNeural' }))[0].voice, { type: 'azure-standard', name: 'en-US-AndrewNeural' });
});

test('Voice Live neural voice carries the configured pitch and rate, and stays plain when unset', () => {
  const base = { AZURE_VOICELIVE_ENDPOINT: 'https://voice.services.ai.azure.com/', AZURE_VOICELIVE_KEY: 'k', JARVIS_VOICE: 'en-US-OnyxTurboMultilingualNeural' };
  assert.deepEqual(
    buildVoiceProviders(from({ ...base, AZURE_SPEECH_PITCH_PERCENT: '-12', AZURE_SPEECH_RATE_PERCENT: '-12' }))[0].voice,
    { type: 'azure-standard', name: 'en-US-OnyxTurboMultilingualNeural', pitch: '-12%', rate: '-12%' }
  );
  assert.deepEqual(
    buildVoiceProviders(from({ ...base, AZURE_SPEECH_PITCH_PERCENT: '0' }))[0].voice,
    { type: 'azure-standard', name: 'en-US-OnyxTurboMultilingualNeural' }
  );
});
