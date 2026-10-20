'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { PROJECT_DIR } = require('./paths');

const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const FALLBACK_MODEL = 'gemini-3-flash-preview';
const QUOTA_CACHE_FILE = '/tmp/jarvis_gemini_quota.json';

let cachedEnv = null;
let quotaExceededUntil = 0; // set when the API answers 429 / RESOURCE_EXHAUSTED

function isQuotaExceeded() {
  if (Date.now() < quotaExceededUntil) return true;
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
    if (data.until && Date.now() < data.until) {
      quotaExceededUntil = data.until;
      return true;
    }
  } catch (_) {}
  return false;
}

function setQuotaExceeded(ms) {
  quotaExceededUntil = Date.now() + ms;
  try { fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify({ until: quotaExceededUntil }), 'utf8'); } catch (_) {}
}

function getEnv(key, fallback = '') {
  if (process.env[key] !== undefined) return process.env[key];
  if (cachedEnv === null) {
    try { cachedEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) { cachedEnv = ''; }
  }
  const match = cachedEnv.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

function getApiKey() {
  return getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY');
}

function resolveModel(requestedModel, isHard = false) {
  if (requestedModel) {
    const clean = requestedModel.replace(/^google\//i, '').replace(/^gemini\//i, '');
    if (['2.5-flash', 'gemini-2.5-flash', '3.5-flash', 'gemini-3.5-flash', 'flash'].includes(clean)) return FALLBACK_MODEL;
    return clean;
  }
  if (isHard) return getEnv('HARD_MODEL') || FALLBACK_MODEL;
  return getEnv('DEFAULT_MODEL') || FALLBACK_MODEL;
}

/**
 * Calls the Google Generative Language API directly (no SDK dependency).
 * Retries once on the fallback model when the requested one is missing (404) or rate-limited (429).
 */
function generateContent({ model, systemInstruction, contents, generationConfig = {}, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('GEMINI_API_KEY or GOOGLE_API_KEY is not set in .env'));

    const resolvedModel = resolveModel(model);
    const bodyObj = { contents };
    if (systemInstruction) bodyObj.system_instruction = { parts: [{ text: String(systemInstruction) }] };
    if (generationConfig && Object.keys(generationConfig).length > 0) bodyObj.generationConfig = generationConfig;

    const payload = JSON.stringify(bodyObj);
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${key}`);

    const req = https.request(url, {
      method: 'POST',
      agent: httpsKeepAliveAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {
          return reject(new Error(`Gemini returned invalid JSON: ${data.slice(0, 160)}`));
        }

        if (res.statusCode >= 400 || parsed.error) {
          const msg = parsed.error?.message || `HTTP ${res.statusCode}`;
          if ((res.statusCode === 404 || res.statusCode === 429) && resolvedModel !== FALLBACK_MODEL) {
            return generateContent({ model: FALLBACK_MODEL, systemInstruction, contents, generationConfig, timeoutMs })
              .then(resolve, reject);
          }
          return reject(new Error(`Gemini API error (${res.statusCode}): ${msg}`));
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
 * Text completion. Throws on failure so the caller (core/llm.js) can fall back to another provider.
 */
async function complete({ system, user, prompt, model, maxOutputTokens = 4096, json = false, hard = false, timeoutMs = 120000, thinkingBudget }) {
  if (isQuotaExceeded()) throw new Error('Gemini quota exceeded (cached); skipping until it resets');

  const generationConfig = { maxOutputTokens: maxOutputTokens || 4096 };
  if (thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget };
  } else if (maxOutputTokens <= 250) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }; // short replies: skip thinking for latency
  }
  if (json) generationConfig.responseMimeType = 'application/json';

  try {
    const res = await generateContent({
      model: resolveModel(model, hard),
      systemInstruction: system,
      contents: [{ role: 'user', parts: [{ text: String(user || prompt || '') }] }],
      generationConfig,
      timeoutMs
    });
    return res.text;
  } catch (err) {
    if (/429|quota|RESOURCE_EXHAUSTED/.test(err.message || '')) setQuotaExceeded(60 * 60 * 1000);
    throw err;
  }
}

/**
 * Multimodal vision: describes or answers questions about a single image.
 */
async function completeVision({ imagePath, base64, mimeType = 'image/png', prompt, system, model, maxTokens = 2000, json = false, timeoutMs = 60000 }) {
  let imgData = base64;
  if (!imgData && imagePath) {
    imgData = fs.readFileSync(imagePath).toString('base64');
    if (/\.jpe?g$/i.test(imagePath)) mimeType = 'image/jpeg';
  }
  if (!imgData) throw new Error('No image data provided (imagePath or base64)');
  imgData = imgData.replace(/^data:[^,]+,/, ''); // strip a data-URL prefix if present

  const generationConfig = { maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';

  const res = await generateContent({
    model: model || 'gemini-3.8-flash',
    systemInstruction: system,
    contents: [{
      role: 'user',
      parts: [
        { text: String(prompt || 'Analyze this image in detail and answer concisely.') },
        { inline_data: { mime_type: mimeType, data: imgData } }
      ]
    }],
    generationConfig,
    timeoutMs
  });
  return res.text;
}

/**
 * Analyzes a sequence of video frames (e.g. a Telegram video note).
 */
async function analyzeFrames({ framePaths = [], prompt, system, model = 'gemini-3.8-flash', maxTokens = 2000, timeoutMs = 60000 }) {
  const parts = [{ text: String(prompt || 'Describe the actions and content in these video frames concisely.') }];
  for (const f of framePaths) {
    if (fs.existsSync(f)) parts.push({ inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
  }

  const res = await generateContent({
    model,
    systemInstruction: system,
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: maxTokens },
    timeoutMs
  });
  return res.text;
}

/**
 * Low-latency speech-to-text using Gemini's audio understanding.
 */
async function transcribeAudio({ audioBuffer, mimeType = 'audio/wav', locale = 'en-US', model = 'gemini-flash-lite-latest', timeoutMs = 25000 }) {
  const base64Data = Buffer.isBuffer(audioBuffer) ? audioBuffer.toString('base64') : String(audioBuffer);
  const language = String(locale || '').startsWith('uz') ? 'Uzbek' : (String(locale || '').startsWith('ru') ? 'Russian' : 'English');
  const systemInstruction = `You are a real-time speech recognizer. Output ONLY the raw spoken words in ${language}. ` +
    'No notes, no markdown, no conversational commentary. If silent or unclear, output nothing.';

  const res = await generateContent({
    model,
    systemInstruction,
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe verbatim:' },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }],
    generationConfig: { maxOutputTokens: 80, temperature: 0.0 },
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
  transcribeAudio,
  hasGemini
};
