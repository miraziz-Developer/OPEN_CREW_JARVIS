#!/usr/bin/env node
/**
 * JARVIS Azure STT skill v2: Azure Speech REST API
 * Multi-request server mode (used by the STT pool)
 * Input: one JSON object per line → { audioBase64: "...", locale: "en-US" }
 * Output: one JSON object per line →  { status: "ok", text: "...", confidence: 0.95 }
 */

const fs = require('fs');
const https = require('https');
const readline = require('readline');
let gemini = null;
try { gemini = require('../../core/gemini'); } catch (_) {}

let cachedEnv = null;
function env(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (cachedEnv === null) {
    try { cachedEnv = fs.readFileSync(require('path').join(__dirname, '../../.env'), 'utf8'); } catch (_) { cachedEnv = ''; }
  }
  const match = cachedEnv.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

const REGION = env('AZURE_SPEECH_REGION', 'uaenorth');
const KEY    = env('AZURE_SPEECH_KEY');
const LOCALE = env('AZURE_SPEECH_LANGUAGE', env('AZURE_STT_LOCALE', 'en-US'));
const TRANSCRIBE_ENDPOINT = env('AZURE_TRANSCRIBE_ENDPOINT');
const TRANSCRIBE_KEY = env('AZURE_TRANSCRIBE_KEY');
const TRANSCRIBE_MODEL = env('AZURE_TRANSCRIBE_DEPLOYMENT', 'gpt-live-transcribe');

function ensureKey() {
  if (!KEY && (!gemini || !gemini.hasGemini())) {
    throw new Error('Neither AZURE_SPEECH_KEY nor GEMINI_API_KEY is set.');
  }
}

function loadAudio(input) {
  if (input.audioFile) {
    if (!fs.existsSync(input.audioFile)) {
      throw new Error('File not found: ' + input.audioFile);
    }
    return fs.readFileSync(input.audioFile);
  }
  if (input.audioBase64) {
    return Buffer.from(input.audioBase64, 'base64');
  }
  throw new Error('An audioFile or audioBase64 field is required.');
}

async function sttRest(audioBuffer, locale) {
  const useLocale = (!locale || locale === 'auto') ? (process.env.AZURE_SPEECH_LANGUAGE || LOCALE || 'en-US') : locale;
  const query = '?language=' + encodeURIComponent(useLocale) + '&format=detailed';

  return new Promise((resolve, reject) => {
    const options = {
      hostname: REGION + '.stt.speech.microsoft.com',
      path: '/speech/recognition/conversation/cognitiveservices/v1' + query,
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.RecognitionStatus === 'Success') {
            const text = data.DisplayText || data.NBest?.[0]?.Display || '';
            const conf = data.NBest?.[0]?.Confidence || 1;
            resolve({ text: text.trim(), confidence: conf });
          } else if (data.RecognitionStatus === 'NoMatch') {
            resolve({ text: '', confidence: 0 });
          } else {
            resolve({ text: '', confidence: 0 }); // silent fail
          }
        } catch (e) {
          reject(new Error('JSON parse error: ' + body.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(audioBuffer);
    req.end();
  });
}

async function liveTranscribe(audioBuffer, locale) {
  if (!TRANSCRIBE_ENDPOINT || !TRANSCRIBE_KEY) throw new Error('gpt-live-transcribe is not configured');
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', TRANSCRIBE_MODEL);
  const language = String(locale || LOCALE).split('-')[0];
  if (language) form.append('language', language);
  form.append('response_format', 'verbose_json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST', headers: { 'api-key': TRANSCRIBE_KEY }, body: form, signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) {}
    if (!response.ok) throw new Error(data.error?.message || `transcribe HTTP ${response.status}`);
    return { text: String(data.text || '').trim(), confidence: Number(data.confidence) || 1, provider: 'gpt-live-transcribe' };
  } finally { clearTimeout(timer); }
}

function hasValidAzureKey() {
  return KEY && KEY !== 'gemini_mode_active' && KEY !== 'placeholder' && KEY.length > 20;
}

async function recognize(audioBuffer, locale) {
  if (gemini && gemini.hasGemini()) {
    try {
      const text = await gemini.transcribeAudio({ audioBuffer, locale });
      if (text) return { text, confidence: 0.98, provider: 'gemini' };
    } catch (_) {}
  }
  if (TRANSCRIBE_ENDPOINT && TRANSCRIBE_KEY && TRANSCRIBE_KEY !== 'placeholder' && TRANSCRIBE_KEY.length > 20) {
    try { return await liveTranscribe(audioBuffer, locale); } catch (_) {}
  }
  if (hasValidAzureKey()) {
    try { return { ...(await sttRest(audioBuffer, locale)), provider: 'azure-speech' }; } catch (_) {}
  }
  return { text: '', confidence: 0, provider: 'none' };
}

// Multi-request server: reads one JSON object per line
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
  crlfDelay: Infinity
});

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const input = JSON.parse(line);
    const audioBuffer = loadAudio(input);
    const result = await recognize(audioBuffer, input.locale);
    console.log(JSON.stringify({ status: 'ok', ...result }));
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: err.message || 'STT error' }));
  }
});

module.exports = { sttRest, liveTranscribe, recognize, loadAudio };
