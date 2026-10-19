'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { PROJECT_DIR } = require('./paths');

let cachedEnv = null;
let quotaExceededUntil = 0; // Dinamik ravishda 429 bo'lganda yangilanadi
function getEnv(key, fallback = '') {
  if (process.env[key] !== undefined) return process.env[key];
  if (cachedEnv === null) {
    try { cachedEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) { cachedEnv = ''; }
  }
  const match = cachedEnv.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

function getApiKey() {
  return getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function resolveModel(requestedModel, isHard = false) {
  if (requestedModel) {
    let clean = requestedModel.replace(/^google\//i, '').replace(/^gemini\//i, '');
    if (clean.startsWith('gemini-flash-lite')) return clean;
  }
  return 'gemini-flash-lite-latest';
}

/**
 * Google Generative Language API ga to'g'ridan-to'g'ri so'rov yuborish.
 * Hech qanday tashqi kutubxona talab qilmaydi (0 dependency), eng tez va ishonchli.
 */
function generateContent({ model, systemInstruction, contents, generationConfig = {}, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('GEMINI_API_KEY yoki GOOGLE_API_KEY .env da topilmadi'));

    const resolvedModel = resolveModel(model);
    const bodyObj = { contents };
    if (systemInstruction) {
      bodyObj.system_instruction = { parts: [{ text: String(systemInstruction) }] };
    }
    if (generationConfig && Object.keys(generationConfig).length > 0) {
      bodyObj.generationConfig = generationConfig;
    }

    const payload = JSON.stringify(bodyObj);
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${key}`);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (err) {
          return reject(new Error(`Gemini JSON parse xatosi: ${data.slice(0, 160)}`));
        }

        if (res.statusCode >= 400 || parsed.error) {
          const msg = parsed.error?.message || `HTTP ${res.statusCode}`;
          // Agar 2.5-flash eskirganligi aytilsa, avtomatik 3.8-flash ga o'tish
          if (res.statusCode === 404 && resolvedModel.includes('2.5-flash')) {
            return generateContent({ model: 'gemini-3.8-flash', systemInstruction, contents, generationConfig, timeoutMs })
              .then(resolve)
              .catch(reject);
          }
          return reject(new Error(`Gemini API xatosi (${res.statusCode}): ${msg}`));
        }

        const candidate = parsed.candidates?.[0];
        const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
        const usage = {
          promptTokens: parsed.usageMetadata?.promptTokenCount || 0,
          completionTokens: parsed.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: parsed.usageMetadata?.totalTokenCount || 0
        };

        resolve({ text: text.trim(), usage, raw: parsed });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Gemini request timeout (${timeoutMs}ms)`));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Matnli suhbat / completion interfeysi
 */
async function complete({ system, user, prompt, model, maxOutputTokens = 4096, json = false, hard = false, timeoutMs = 120000 }) {
  const resolved = resolveModel(model, hard);
  const userPrompt = String(user || prompt || '');
  const contents = [
    {
      role: 'user',
      parts: [{ text: userPrompt }]
    }
  ];

  const generationConfig = {
    maxOutputTokens: maxOutputTokens || 4096
  };

  if (json) {
    generationConfig.responseMimeType = 'application/json';
  }

  if (Date.now() < quotaExceededUntil || !getApiKey()) {
    try {
      const agySkill = require('../skills/antigravity');
      const agyRes = await agySkill.executePrompt((system ? system + '\n\n' : '') + userPrompt, { effort: 'low', timeoutMs });
      if (agyRes && agyRes.output) return agyRes.output;
    } catch (_) {}
  }

  try {
    const res = await generateContent({
      model: resolved,
      systemInstruction: system,
      contents,
      generationConfig,
      timeoutMs
    });
    return res.text;
  } catch (err) {
    quotaExceededUntil = Date.now() + 3600 * 1000;
    try {
      const agySkill = require('../skills/antigravity');
      const agyRes = await agySkill.executePrompt((system ? system + '\n\n' : '') + userPrompt, { effort: 'low', timeoutMs });
      if (agyRes && agyRes.output) {
        return agyRes.output;
      }
    } catch (e) {
      console.error('Agy fallback error:', e);
    }
    throw err;
  }
}

/**
 * Skrinshot yoki rasmlarni ko'rish va tahlil qilish (Multimodal Vision)
 */
async function completeVision({ imagePath, base64, mimeType = 'image/png', prompt, system, model, maxTokens = 2000, json = false, timeoutMs = 60000 }) {
  let imgData = base64;
  if (!imgData && imagePath) {
    imgData = fs.readFileSync(imagePath).toString('base64');
    if (imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg')) mimeType = 'image/jpeg';
  }
  if (!imgData) throw new Error('Rasm ma\'lumoti (imagePath yoki base64) berilmadi');

  // Prefix "data:image/...;base64," bo'lsa tozalash
  imgData = imgData.replace(/^data:[^,]+,/, '');

  const parts = [
    { text: String(prompt || 'Analyze this image in detail and answer concisely.') },
    {
      inline_data: {
        mime_type: mimeType,
        data: imgData
      }
    }
  ];

  const contents = [{ role: 'user', parts }];
  const generationConfig = { maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';

  const res = await generateContent({
    model: model || 'gemini-3.8-flash',
    systemInstruction: system,
    contents,
    generationConfig,
    timeoutMs
  });

  return res.text;
}

/**
 * Bir nechta kadrlar (video note) tahlili
 */
async function analyzeFrames({ framePaths = [], prompt, system, model = 'gemini-3.8-flash', maxTokens = 2000, timeoutMs = 60000 }) {
  const parts = [{ text: String(prompt || 'Describe the actions and content in these video frames concisely.') }];

  for (const f of framePaths) {
    if (fs.existsSync(f)) {
      const data = fs.readFileSync(f).toString('base64');
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data
        }
      });
    }
  }

  const contents = [{ role: 'user', parts }];
  const res = await generateContent({
    model,
    systemInstruction: system,
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
    timeoutMs
  });

  return res.text;
}

/**
 * Gemini Embeddings (xotira semantik qidiruvi uchun bepul)
 */
function embedContent({ text, model = 'text-embedding-004', timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('GEMINI_API_KEY .env da topilmadi'));

    const payload = JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: String(text).slice(0, 8000) }] }
    });

    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.embedding?.values) {
            resolve(parsed.embedding.values);
          } else {
            reject(new Error(parsed.error?.message || 'Embedding olinmadi'));
          }
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Embedding timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Gemini Multimodal Audio Transcription (bepul va o'ta tez STT)
 */
async function transcribeAudio({ audioBuffer, mimeType = 'audio/wav', locale = 'en-US', model = 'gemini-flash-lite-latest', timeoutMs = 25000 }) {
  const base64Data = Buffer.isBuffer(audioBuffer) ? audioBuffer.toString('base64') : String(audioBuffer);
  const langPrompt = locale.startsWith('uz') ? ' Uzbek' : (locale.startsWith('ru') ? ' Russian' : ' English');
  const systemInstruction = `You are an expert speech recognition system. Transcribe the spoken audio precisely in${langPrompt}. Output ONLY the transcribed words. Do not add any punctuation unless clearly spoken. Do not add explanations, conversational comments, or notes. If the audio is silent or unintelligible, output nothing.`;

  const contents = [{
    role: 'user',
    parts: [
      { text: 'Transcribe this audio verbatim:' },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ]
  }];

  const res = await generateContent({
    model,
    systemInstruction,
    contents,
    generationConfig: { maxOutputTokens: 500, temperature: 0.1 },
    timeoutMs
  });

  return (res.text || '').trim();
}

function hasGemini() {
  return Boolean(getApiKey());
}

module.exports = {
  getApiKey,
  resolveModel,
  generateContent,
  complete,
  completeVision,
  analyzeFrames,
  embedContent,
  transcribeAudio,
  hasGemini
};

