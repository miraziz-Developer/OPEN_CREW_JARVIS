#!/usr/bin/env node
/**
 * JARVIS Azure STT Skill — Azure Speech REST API bilan
 * Ozbek tilida (uz-UZ) ovozni matnga aylantiradi.
 * Kirish:  { audioFile: "/path/to/file.wav" } yoki { audioBase64: "..." }
 * Chiqish: { status: "ok", text: "...", confidence: 0.95 }
 *
 * Faqat qisqa buyruqlar (single-shot) uchun. Uzun nutq bo'lsa bo'limlarga bo'lib,
 * har birini alohida chaqiring (OpenClaw 15 daqiqa limit).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// konstantalar
const REGION = process.env.AZURE_SPEECH_REGION || 'southeastasia';
const KEY    = process.env.AZURE_SPEECH_KEY;
const LOCALE = process.env.AZURE_SPEECH_LANGUAGE || process.env.AZURE_STT_LOCALE || 'uz-UZ';

function ensureKey() {
  if (!KEY) throw new Error('AZURE_SPEECH_KEY muhit ozgaruvchisi topilmadi.');
}

// audio faylni togri formatda oqish
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

function writeTempWav(buffer) {
  const tmpFile = path.join(require('os').tmpdir(), 'jarvis_stt_' + Date.now() + '.wav');
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
}

// POST orqali Azure Speech to Text REST API
async function sttRest(audioBuffer) {
  ensureKey();
  const endpoint = 'https://' + REGION + '.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1';
  const query = '?language=' + encodeURIComponent(LOCALE) + '&format=detailed';

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
            reject(new Error('STT status: ' + data.RecognitionStatus + ' — ' + (data.Error?.Message || '')));
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
    const audioBuffer = loadAudio(input);

    // Agar base64 kelsa vaqtinchalik fayl yozamiz, lekin RESTga togri buffer yuboriladi
    const result = await sttRest(audioBuffer);

    console.log(JSON.stringify({ status: 'ok', ...result }));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message || 'STT xatolik', status: 'error' }));
    process.exit(1);
  }
})();
