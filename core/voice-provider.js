'use strict';

function trimEndpoint(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function websocketEndpoint(value) {
  return trimEndpoint(value).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

function configured(value) {
  const text = String(value || '').trim();
  return Boolean(text && !/^(?:\.{3}|changeme|replace[-_ ]?me|your[-_ ])/i.test(text));
}

function buildVoiceProviders(env) {
  const providers = [];
  const voiceLiveEndpoint = env('AZURE_VOICELIVE_ENDPOINT');
  const voiceLiveKey = env('AZURE_VOICELIVE_KEY');
  if (configured(voiceLiveEndpoint) && configured(voiceLiveKey)) {
    const base = websocketEndpoint(voiceLiveEndpoint)
      .replace(/\/voice-live\/realtime(?:\?.*)?$/, '')
      .replace(/\/api\/projects\/[^/?]+(?:\?.*)?$/, '');
    const model = env('AZURE_VOICELIVE_MODEL', 'gpt-realtime');
    const apiVersion = env('AZURE_VOICELIVE_API_VERSION', '2026-04-10');
    providers.push({
      id: 'voice-live',
      url: `${base}/voice-live/realtime?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`,
      headers: { 'api-key': voiceLiveKey },
      voice: { type: 'azure-standard', name: env('AZURE_VOICELIVE_VOICE', 'en-US-OnyxTurboMultilingualNeural') }
    });
  }

  const realtimeEndpoint = env('AZURE_REALTIME_ENDPOINT');
  const realtimeKey = env('AZURE_REALTIME_KEY');
  if (configured(realtimeEndpoint) && configured(realtimeKey)) {
    const base = websocketEndpoint(realtimeEndpoint)
      .replace(/\/openai\/v1\/realtime(?:\?.*)?$/, '')
      .replace(/\/openai\/v1(?:\?.*)?$/, '');
    const deployment = env('AZURE_REALTIME_DEPLOYMENT', 'gpt-realtime-1.5');
    providers.push({
      id: 'azure-realtime',
      url: `${base}/openai/v1/realtime?model=${encodeURIComponent(deployment)}`,
      headers: { 'api-key': realtimeKey },
      voice: env('AZURE_REALTIME_VOICE', 'cedar')
    });
  }

  return providers;
}

module.exports = { buildVoiceProviders, configured, trimEndpoint, websocketEndpoint };