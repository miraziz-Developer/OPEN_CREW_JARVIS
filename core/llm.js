'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { PROJECT_DIR } = require('./paths');

let cachedEnv = null;
function env(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (cachedEnv === null) { try { cachedEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) { cachedEnv = ''; } }
  const match = cachedEnv.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

function extractOutputText(response) {
  if (!response || !Array.isArray(response.output)) return '';
  return response.output
    .filter(item => item && item.type === 'message' && Array.isArray(item.content))
    .flatMap(item => item.content)
    .filter(item => item && item.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text).join('\n').trim();
}

// Birinchi to'liq JSON obyektini (qavslarni sanab) ajratib oladi — model ba'zan atrofiga matn qo'shadi.
function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) throw new Error('JSON topilmadi');
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('JSON tugallanmagan');
}

function request({ model, system, user, maxOutputTokens, timeoutMs, effort }) {
  return new Promise((resolve, reject) => {
    const key = env('AZURE_OPENAI_KEY');
    const base = String(env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '').replace(/\/api\/projects\/[^/]+$/, '').replace(/\/openai\/v1$/, '');
    if (!key || !base) return reject(new Error('Azure OpenAI endpoint/key sozlanmagan'));
    const body = { model, instructions: system, input: String(user).slice(0, 60000), max_output_tokens: maxOutputTokens };
    if (effort) body.reasoning = { effort };
    const payload = JSON.stringify(body);
    const req = https.request(new URL(base + '/openai/v1/responses'), {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'LLM xatosi'));
          const text = extractOutputText(parsed);
          if (!text) return reject(new Error('bo\'sh LLM javobi'));
          resolve(text);
        } catch (error) { reject(new Error('LLM javobi o\'qilmadi: ' + String(data).slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(payload); req.end();
  });
}

async function complete(options = {}) {
  const model = options.model || env('MISSION_MODEL', env('AZURE_OPENAI_DEPLOYMENT', 'gpt-5-mini'));
  const attempts = options.retries ?? 2;
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await request({
        model, system: options.system || '', user: options.user || '',
        maxOutputTokens: options.maxOutputTokens || 6000, timeoutMs: options.timeoutMs || 180000, effort: options.effort
      });
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function completeJson(options = {}) {
  let text = await complete(options);
  try { return extractJson(text); } catch (firstError) {
    text = await complete({
      ...options,
      user: String(options.user || '') + '\n\nYour previous reply was not valid JSON. Reply with ONE valid JSON object only, no prose.'
    });
    return extractJson(text);
  }
}

module.exports = { complete, completeJson, extractJson, env };
