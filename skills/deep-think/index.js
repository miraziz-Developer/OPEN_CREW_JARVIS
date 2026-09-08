#!/usr/bin/env node
/**
 * DEEP THINK — jiddiy savollarni primary reasoning modelga yo'naltiradi.
 *
 * Nega kerak: jonli suhbatda barcha savol-javobga `gpt-realtime-2.1`
 * javob berardi. U ovoz uchun optimallashtirilgan — fikrlash uchun emas.
 * Kuchli Responses API modeli rejalashtirish, coding va murakkab savollarga
 * javob beradi. Oddiy suhbat realtime modelda qoladi: u qisqa gaplarda
 * past latency va tabiiy audio uchun optimallashtirilgan.
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
  if (_env === null) { try { _env = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) { _env = ''; } }
  const m = _env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const MODEL = env('DEEP_THINK_MODEL', env('AZURE_OPENAI_DEPLOYMENT', 'gpt-6-astra'));
const TIMEOUT_MS = parseInt(env('DEEP_THINK_TIMEOUT_MS'), 10) || 90000;
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

function askExpert(question, context) {
  return new Promise((resolve, reject) => {
    const KEY = env('AZURE_OPENAI_KEY');
    const BASE = (env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '').replace(/\/openai\/v1$/, '');
    if (!KEY || !BASE) return reject(new Error('AZURE_OPENAI_KEY/ENDPOINT yo\'q'));

    const instructions = context
      ? SYSTEM_PROMPT + '\n\nSuhbat konteksti (foydalanuvchi haqida ma\'lum bo\'lgan narsalar):\n' + String(context).slice(0, 4000)
      : SYSTEM_PROMPT;
    const payload = JSON.stringify({
      model: MODEL,
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
  askExpert(input.question, input.context)
    .then(answer => console.log(JSON.stringify({ status: 'ok', model: MODEL, answer })))
    .catch(e => console.log(JSON.stringify({ status: 'error', message: e.message })));
}

if (require.main === module) main();

module.exports = { askExpert, extractOutputText, stripMarkdown, MODEL };
