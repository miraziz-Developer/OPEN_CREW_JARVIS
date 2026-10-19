#!/usr/bin/env node
/**
 * JARVIS Azure TTS Skill
 * 
 * Azure Cognitive Services Speech **neural** voice fallback (unified with realtime voice via JARVIS_VOICE / AZURE_VOICELIVE_VOICE).
 * Input (stdin JSON): { text: "...", voice?: "en-US-AndrewNeural" or uz-UZ-SardorNeural }
 * Output (stdout JSON): { status: "ok", audioFile: "/tmp/jarvis_tts_*.wav", format: "audio/wav", sampleRate: 24000 }
 * 
 * Uses SSML with prosody for natural rate/pitch. 24kHz PCM WAV for best AEC/echo cancellation compatibility with realtime pipeline.
 * English neural fallback prevents voice inconsistency when realtime uses SardorNeural for Uzbek.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

// konstantalar
const DEFAULT_VOICE = process.env.AZURE_SPEECH_VOICE || process.env.AZURE_VOICELIVE_VOICE || 'en-US-AndrewNeural';
const LANGUAGE      = process.env.AZURE_SPEECH_LANGUAGE || 'en-US';
const RATE_PERCENT  = Number(process.env.AZURE_SPEECH_RATE_PERCENT ?? -12);
const PITCH_PERCENT = Number(process.env.AZURE_SPEECH_PITCH_PERCENT ?? -12);
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
function signedPercent(value, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return (number >= 0 ? '+' : '') + number + '%';
}

function buildSsml(text, voice = DEFAULT_VOICE, options = {}) {
  const language = options.language || LANGUAGE;
  const rate = signedPercent(Number(options.ratePercent ?? RATE_PERCENT), -12);
  const pitch = signedPercent(Number(options.pitchPercent ?? PITCH_PERCENT), -12);
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + language + '">' +
    '<voice name="' + voice + '"><prosody rate="' + rate + '" pitch="' + pitch + '">' + escapeXml(text) + '</prosody></voice>' +
    '</speak>';
}

function macOSLocalTts(text, voice) {
  const { execSync } = require('child_process');
  const outFile = path.join('/tmp', 'jarvis_tts_' + Date.now() + '.wav');
  const aiffFile = path.join('/tmp', 'jarvis_say_' + Date.now() + '.aiff');
  // Britancha klassik viqorli Jarvis ovozi (Daniel)
  const selectedVoice = 'Daniel';
  const cleanText = String(text || '').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  try {
    execSync(`say -v "${selectedVoice}" -o "${aiffFile}" "${cleanText}"`, { timeout: 15000 });
    try {
      execSync(`sox "${aiffFile}" -r 24000 -c 1 -b 16 "${outFile}"`, { timeout: 10000 });
      try { fs.unlinkSync(aiffFile); } catch (_) {}
      return { audioFile: outFile, format: 'audio/wav', sampleRate: 24000, status: 'ok', engine: 'macos-daniel' };
    } catch (_) {
      return { audioFile: aiffFile, format: 'audio/aiff', status: 'ok', engine: 'macos-daniel-aiff' };
    }
  } catch (err) {
    throw new Error(`macOS say xatosi: ${err.message}`);
  }
}

// TTS REST yuborish
async function azureTts(text, voice) {
  if (!KEY || !REGION || REGION === 'placeholder') {
    return macOSLocalTts(text, voice);
  }

  try {
    const resolvedVoice = voice || DEFAULT_VOICE;
    const url = 'https://' + REGION + '.tts.speech.microsoft.com/cognitiveservices/v1';
    const ssml = buildSsml(text, resolvedVoice);

    const response = await axios.post(url, ssml, {
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        // Realtime voice AEC aynan karnayga yuborilgan PCM'ni reference sifatida
        // ishlata olishi uchun siqilgan MP3 emas, 24 kHz PCM WAV so'raymiz.
        'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
        'User-Agent': 'Jarvis-Azure-TTS/1.0'
      },
      responseType: 'arraybuffer',
      timeout: 30000,
      httpsAgent: new https.Agent({ keepAlive: false })
    });

    const outFile = path.join('/tmp', 'jarvis_tts_' + Date.now() + '.wav');
    fs.writeFileSync(outFile, Buffer.from(response.data));
    return { audioFile: outFile, format: 'audio/wav', sampleRate: 24000, status: 'ok' };
  } catch (err) {
    console.error('Azure TTS failed, falling back to macOS local TTS:', err.message);
    return macOSLocalTts(text, voice);
  }
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
async function main() {
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
}

if (require.main === module) main();

module.exports = { azureTts, buildSsml, escapeXml, signedPercent };
