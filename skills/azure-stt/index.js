#!/usr/bin/env node
/**
 * JARVIS Azure STT Skill v2 — Azure Speech REST API bilan
 * Multi-request server mode (pool bilan ishlash uchun)
 * Input: one JSON object per line → { audioBase64: "...", locale: "en-US" }
 * Chiqish: har qatorda JSON →  { status: "ok", text: "...", confidence: 0.95 }
 */

const fs = require('fs');
const https = require('https');
const readline = require('readline');

const REGION = process.env.AZURE_SPEECH_REGION || 'southeastasia';
const KEY    = process.env.AZURE_SPEECH_KEY;
const LOCALE = process.env.AZURE_SPEECH_LANGUAGE || process.env.AZURE_STT_LOCALE || 'en-US';
const TRANSCRIBE_ENDPOINT = process.env.AZURE_TRANSCRIBE_ENDPOINT;
const TRANSCRIBE_KEY = process.env.AZURE_TRANSCRIBE_KEY;
const TRANSCRIBE_MODEL = process.env.AZURE_TRANSCRIBE_DEPLOYMENT || 'gpt-live-transcribe';

function ensureKey() {
  if (!KEY) throw new Error('AZURE_SPEECH_KEY muhit ozgaruvchisi topilmadi.');
}

function loadAudio(input) {
  if (input.audioFile) {
    if (!fs.existsSync(input.audioFile)) {
      throw new Error('Fayl topilmadi: ' + input.audioFile);
    }
    return fs.readFileSync(input.audioFile);
  }
  if (input.audioBase64) {
    return Buffer.from(input.audioBase64, 'base64');
  }
  throw new Error('audioFile yoki audioBase64 maydoni kerak.');
}

async function sttRest(audioBuffer, locale) {
  ensureKey();
  const useLocale = locale || LOCALE;
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
          reject(new Error('JSON parse xatolik: ' + body.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(audioBuffer);
    req.end();
  });
}

async function liveTranscribe(audioBuffer, locale) {
  if (!TRANSCRIBE_ENDPOINT || !TRANSCRIBE_KEY) throw new Error('gpt-live-transcribe sozlanmagan');
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

async function recognize(audioBuffer, locale) {
  if (TRANSCRIBE_ENDPOINT && TRANSCRIBE_KEY) {
    try { return await liveTranscribe(audioBuffer, locale); } catch (_) {}
  }
  return { ...(await sttRest(audioBuffer, locale)), provider: 'azure-speech' };
}

// Multi-request server: har qatorda JSON o'qiydi
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
    console.log(JSON.stringify({ status: 'error', error: err.message || 'STT xatolik' }));
  }
});

module.exports = { sttRest, liveTranscribe, recognize, loadAudio };
