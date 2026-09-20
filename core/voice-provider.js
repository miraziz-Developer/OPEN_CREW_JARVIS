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

const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

// Realtime WS faqat oddiy OpenAI ovozlarini qabul qiladi; Azure Neural nomlari
// (en-US-Adam:DragonHDLatestNeural va h.k.) faqat Voice Live / TTS uchun.
function getRealtimeVoice(...candidates) {
  for (const candidate of candidates) {
    const v = String(candidate || '').trim().toLowerCase();
    if (REALTIME_VOICES.includes(v)) return v;
  }
  return 'shimmer';
}

// Azure neural ovoz: pitch/rate .env dagi AZURE_SPEECH_PITCH_PERCENT / AZURE_SPEECH_RATE_PERCENT dan
// (Fn+Shift xabarlarini aytadigan azure-tts skill bilan bir xil "viqorli" ohang). 0/bo'sh — o'zgarishsiz.
function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0 ? `${number > 0 ? '+' : ''}${number}%` : undefined;
}

function azureVoice(name, env) {
  const voice = { type: 'azure-standard', name };
  const pitch = percent(env('AZURE_SPEECH_PITCH_PERCENT'));
  const rate = percent(env('AZURE_SPEECH_RATE_PERCENT'));
  if (pitch) voice.pitch = pitch;
  if (rate) voice.rate = rate;
  return voice;
}

function buildVoiceProviders(env) {
  const providers = [];
  const voiceLiveEndpoint = env('AZURE_VOICELIVE_ENDPOINT');
  const voiceLiveKey = env('AZURE_VOICELIVE_KEY');
  // Bitta ovoz hamma joyda (Voice Live + TTS) — "ikki xil ovoz" xatosini oldini oladi.
  const unifiedVoice = env('JARVIS_VOICE') || env('AZURE_VOICELIVE_VOICE') || env('AZURE_SPEECH_VOICE') || 'en-US-OnyxTurboMultilingualNeural';

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
      // OpenAI ovozlari (alloy, ...) Voice Live ichida native ~0.3 s; Azure neural ovozlar alohida TTS bosqichi bilan ~0.9 s.
      voice: REALTIME_VOICES.includes(String(unifiedVoice).trim().toLowerCase())
        ? String(unifiedVoice).trim().toLowerCase()
        : azureVoice(unifiedVoice, env)
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
      voice: getRealtimeVoice(env('AZURE_REALTIME_VOICE'), unifiedVoice)
    });
  }

  return providers;
}

module.exports = { buildVoiceProviders, configured, trimEndpoint, websocketEndpoint };