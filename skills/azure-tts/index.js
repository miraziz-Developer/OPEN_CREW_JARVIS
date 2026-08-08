#!/usr/bin/env node
/**
 * JARVIS Azure TTS Skill
 * Azure Cognitive Services Speech bilan ozbek tilida (uz-UZ) ovoz chiqaradi.
 * Kirish:  { text: "...", voice?: "uz-UZ-SardorNeural" | "uz-UZ-MadinaNeural" }
 * Chiqish: { status: "ok", audioFile: "/tmp/jarvis_tts_*.mp3", format: "audio/mp3" }
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

// konstantalar
const DEFAULT_VOICE = process.env.AZURE_TTS_VOICE_MALE || 'uz-UZ-SardorNeural';
const ALT_VOICE     = process.env.AZURE_TTS_VOICE_FEMALE || 'uz-UZ-MadinaNeural';
const REGION        = process.env.AZURE_SPEECH_REGION || 'southeastasia';
const KEY           = process.env.AZURE_SPEECH_KEY;

// XML escape: SSML ichida xavfsiz matn uchun (formatter-dan qochish uchun split/join)
function escapeXml(text) {
  const amp  = ['&','a','m','p',';'].join('');
  const lt   = ['&','l','t',';'].join('');
  const gt   = ['&','g','t',';'].join('');
  const quot = ['&','q','u','o','t',';'].join('');
  return text.split('&').join(amp).split('<').join(lt).split('>').join(gt).split('"').join(quot);
}

// SSML yaratish
function buildSsml(text, voice) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="uz-UZ">' +
    '<voice name="' + voice + '">' + escapeXml(text) + '</voice>' +
    '</speak>';
}

// TTS REST yuborish
async function azureTts(text, voice) {
  if (!KEY) {
    throw new Error('AZURE_SPEECH_KEY muhit ozgaruvchisi topilmadi. Ilk bolib .envni tekshiring.');
  }

  const resolvedVoice = voice || DEFAULT_VOICE;
  const url = 'https://' + REGION + '.tts.speech.microsoft.com/cognitiveservices/v1';
  const ssml = buildSsml(text, resolvedVoice);

  const response = await axios.post(url, ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'Jarvis-Azure-TTS/1.0'
    },
    responseType: 'arraybuffer',
    timeout: 30000,
    httpsAgent: new https.Agent({ keepAlive: false })
  });

  const outFile = path.join('/tmp', 'jarvis_tts_' + Date.now() + '.mp3');
  fs.writeFileSync(outFile, Buffer.from(response.data));
  return { audioFile: outFile, format: 'audio/mp3', status: 'ok' };
}

// stdin oqish
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// asosiy entry point
(async function main() {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};

    if (!input.text || typeof input.text !== 'string') {
      console.log(JSON.stringify({ error: 'text maydoni talab qilinadi.' }));
      process.exit(1);
    }

    const result = await azureTts(input.text, input.voice);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message || 'TTS xatolik' }));
    process.exit(1);
  }
})();
