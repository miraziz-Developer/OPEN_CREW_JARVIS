#!/usr/bin/env node
/**
 * DEEP THINK — reasoning so'rovlarini latency/complexity tieriga yo'naltiradi.
 *
 * Nega kerak: jonli suhbatda barcha savol-javobga realtime voice modeli
 * javob berardi. U ovoz uchun optimallashtirilgan — fikrlash uchun emas.
 * Grok fast oddiy expert javoblarini past latency bilan beradi; GPT-5.6 Sol
 * architecture, strategiya va ko'p bosqichli rejalashni bajaradi. Oddiy
 * suhbat realtime modelda qoladi.
 *
 * MUHIM: bu `run_task` EMAS. run_task to'liq agentni (barcha skilllar,
 * brauzer, fayl tizimi) ishga tushiradi va 15-25 soniya oladi. Bu esa
 * modelga to'g'ridan-to'g'ri bitta chaqiruv — hech qanday tool halqasi
 * yo'q, shuning uchun tez.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { PROJECT_DIR } = require('../../core/paths');
let _env = null;
function env(k, def) {
  if (process.env[k] !== undefined) return process.env[k];
  if (_env === null) { try { _env = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) { _env = ''; } }
  const m = _env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const FAST_MODEL = env('DEEP_THINK_FAST_MODEL', 'grok-4-1-fast-reasoning');
const COMPLEX_MODEL = env('DEEP_THINK_COMPLEX_MODEL', 'gpt-5.6-sol');
const TIMEOUT_MS = Math.max(30000, parseInt(env('DEEP_THINK_TIMEOUT_MS'), 10) || 240000);
const MAX_TOKENS = parseInt(env('DEEP_THINK_MAX_TOKENS'), 10) || 1200;

// Javob OG'ZAKI o'qiladi — shuning uchun markdown (sarlavha, **qalin**,
// raqamli ro'yxat) mutlaqo yaramaydi: ular ovozda "yulduzcha yulduzcha"
// bo'lib eshitiladi yoki g'alati pauzalar hosil qiladi. Model buni
// bilishi shart, aks holda odatdagi chiroyli formatlangan matn qaytaradi.
const SYSTEM_PROMPT =
  "You are Jarvis, an English-speaking personal assistant. Your answer will be spoken aloud, so:\n" +
  "- Use no markdown, headings, bullets, tables, or code fences.\n" +
  "- Write natural spoken English. If sequencing is needed, say first, second, and finally.\n" +
  "- Be concise: at most four to six sentences unless the user explicitly requests detail.\n" +
  "- Be specific and actionable; include concrete numbers or steps when useful.\n" +
  "- Start with the answer, not a preamble such as 'good question' or 'let's examine it'.\n" +
  "- Reply only in English.";

const GROK_VOICE_TIMEOUT_MS = parseInt(env('GROK_VOICE_TIMEOUT_MS'), 10) || 14000;
let grokSkipUntil = 0;

function isComplexReasoningRequest(question) {
  const text = String(question || '').toLowerCase();
  return text.length > 700 || /\b(architecture|architect|strategy|tradeoffs?|design (?:a|an|the)?|multi[ -]?step|roadmap|migration|root cause|debug(?:ging)?|security review|implementation plan|system design|comprehensive|in[- ]depth|chuqur|arxitektura|strategiya|taqqosla|reja(?:si|lashtir)?|ko'p bosqich|muammoni tahlil)\b/i.test(text);
}

function reasoningProviders(question) {
  const fast = {
    name: 'grok-fast', endpoint: env('AZURE_OPENAI_ENDPOINT'), key: env('AZURE_OPENAI_KEY'), model: FAST_MODEL
  };
  const complex = {
    name: 'gpt-sol', endpoint: env('AZURE_OPENAI_ENDPOINT'), key: env('AZURE_OPENAI_KEY'), model: COMPLEX_MODEL
  };
  return isComplexReasoningRequest(question) ? [complex, fast] : [fast, complex];
}

function requestExpert(question, context, provider) {
  return new Promise((resolve, reject) => {
    const KEY = provider.key;
    const BASE = String(provider.endpoint || '').replace(/\/$/, '').replace(/\/api\/projects\/[^/]+$/, '').replace(/\/openai\/v1$/, '');
    if (!KEY || !BASE) return reject(new Error(provider.name + ' endpoint/key yo\'q'));

    const instructions = context
      ? SYSTEM_PROMPT + '\n\nSuhbat konteksti (foydalanuvchi haqida ma\'lum bo\'lgan narsalar):\n' + String(context).slice(0, 4000)
      : SYSTEM_PROMPT;
    const payload = JSON.stringify({
      model: provider.model,
      instructions,
      input: String(question).slice(0, 8000),
      max_output_tokens: MAX_TOKENS
    });
    const url = new URL(BASE + '/openai/v1/responses');
    const req = https.request(url, {
      method: 'POST',
      headers: { 'api-key': KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.error) return reject(new Error(p.error.message));
          const txt = extractOutputText(p);
          if (!txt) return reject(new Error('bo\'sh javob'));
          resolve(stripMarkdown(txt));
        } catch (e) { reject(new Error('javobni o\'qib bo\'lmadi: ' + String(d).slice(0, 150))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('deep-think timeout')); });
    req.write(payload); req.end();
  });
}

async function askExpert(question, context) {
  let lastError;
  // Murakkab so'rovlar avval kuchli grok'ka (daqiqalik limit ichida); band/yo'q bo'lsa eski zanjir.
  if (isComplexReasoningRequest(question)) {
    try {
      const grok = require('../../core/grok');
      if (grok.available() && Date.now() >= grokSkipUntil) {
        const system = context ? SYSTEM_PROMPT + '\n\nSuhbat konteksti:\n' + String(context).slice(0, 4000) : SYSTEM_PROMPT;
        // Ovozda kutayotgan odam bor: grok kechiksa (o'lchangan 10-46 s) tez tushib ketamiz.
        return stripMarkdown(await grok.chat({ system, user: String(question).slice(0, 8000), maxTokens: 3500, timeoutMs: GROK_VOICE_TIMEOUT_MS, maxWaitMs: 2000 }));
      }
    } catch (error) {
      lastError = error;
      if (/timeout/i.test(error.message)) grokSkipUntil = Date.now() + 180000; // sekin turibdi — 3 daqiqa o'tkazib yuboramiz
    }
  }
  for (const provider of reasoningProviders(question)) {
    try { return await requestExpert(question, context, provider); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('reasoning provider sozlanmagan');
}

function extractOutputText(response) {
  if (!response || !Array.isArray(response.output)) return '';
  return response.output
    .filter(item => item && item.type === 'message' && Array.isArray(item.content))
    .flatMap(item => item.content)
    .filter(item => item && item.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim();
}

// Yo'riqnomaga qaramay model ba'zan markdown qo'shib yuboradi — ovozda
// g'alati eshitilmasligi uchun qo'shimcha, ishonchli tozalash.
function stripMarkdown(s) {
  return String(s)
    .replace(/^#{1,6}\s*/gm, '')        // sarlavhalar
    .replace(/\*\*(.+?)\*\*/g, '$1')    // qalin
    .replace(/\*(.+?)\*/g, '$1')        // kursiv
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')      // ro'yxat belgilari
    .replace(/^\s*\d+[.)]\s+/gm, '')    // raqamli ro'yxat
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  if (!input.question) { console.log(JSON.stringify({ status: 'error', message: 'question kerak' })); return; }
  const provider = reasoningProviders(input.question)[0];
  askExpert(input.question, input.context)
    .then(answer => console.log(JSON.stringify({ status: 'ok', model: provider.model, answer })))
    .catch(e => console.log(JSON.stringify({ status: 'error', message: e.message })));
}

if (require.main === module) main();

module.exports = {
  askExpert, extractOutputText, stripMarkdown, isComplexReasoningRequest,
  reasoningProviders, FAST_MODEL, COMPLEX_MODEL
};
