#!/usr/bin/env node
'use strict';

/**
 * JARVIS sozlash ustasi: .env ni yaratadi va kerakli kalitlarni bosqichma-bosqich so'raydi.
 *  - har kalit nima ekani va qayerdan olinishi tushuntiriladi;
 *  - kiritilgan kalit darhol tekshiriladi (Azure OpenAI, Azure Speech, Telegram);
 *  - allaqachon to'ldirilgan qiymatlar qayta so'ralmaydi (--reconfigure bilan hammasi qayta so'raladi);
 *  - interaktiv bo'lmasa (TTY yo'q) faqat nima yetishmayotganini aytadi.
 * Sirlar terminalda ko'rinmaydi va faqat .env (0600) ga yoziladi.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');

const c = { g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };

function parse(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) { const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) map.set(m[1], m[2].trim().replace(/^["']|["']$/g, '')); }
  return map;
}
function setKey(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => `${key}=${value}`) : text.replace(/\n*$/, '\n') + `${key}=${value}\n`;
}

// ── Tekshiruvlar (request — sinov uchun almashtiriladi) ──────────────────
function httpRequest({ method = 'GET', url, headers = {}, body, timeoutMs = 12000 }) {
  return new Promise(resolve => {
    let payload = body ? JSON.stringify(body) : null;
    let target;
    try { target = new URL(url); } catch (_) { return resolve({ status: 0, error: 'noto‘g‘ri URL' }); }
    const req = https.request(target, { method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let data = ''; res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const baseUrl = endpoint => String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/api\/projects\/[^/]+$/, '').replace(/\/openai\/v1$/, '');

// ok: true (ishlaydi) | false (aniq xato) | null (aniqlab bo'lmadi, masalan tarmoq yo'q)
async function validateAzureOpenAI({ endpoint, key, deployment }, request = httpRequest) {
  if (!/^https:\/\/.+/i.test(String(endpoint || ''))) return { ok: false, message: 'endpoint https:// bilan boshlanishi kerak' };
  // JARVIS missiyalari ham shu yo'ldan foydalanadi (core/llm.js): {endpoint}/openai/v1/responses, api-key sarlavhasi.
  const res = await request({ method: 'POST', url: baseUrl(endpoint) + '/openai/v1/responses', headers: { 'api-key': key },
    body: { model: deployment, input: 'ping', max_output_tokens: 16 } });
  if (res.status === 0) return { ok: null, message: 'tekshirib bo‘lmadi (' + (res.error || 'tarmoq') + ')' };
  if (res.status === 200) return { ok: true, message: `Azure OpenAI ishlayapti (${deployment})` };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'kalit yoki endpoint noto‘g‘ri (' + res.status + ')' };
  if (res.status === 404) return { ok: false, message: `"${deployment}" deployment topilmadi — Azure'dagi nomni tekshiring` };
  if (res.status === 400 || res.status === 429) return { ok: true, message: 'kalit qabul qilindi (' + res.status + ')' };
  return { ok: null, message: 'kutilmagan javob: ' + res.status };
}

async function validateSpeech({ key, region }, request = httpRequest) {
  if (!key || !region) return { ok: false, message: 'kalit va region kerak' };
  const res = await request({ method: 'POST', url: `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' } });
  if (res.status === 0) return { ok: null, message: 'tekshirib bo‘lmadi (' + (res.error || 'tarmoq') + ')' };
  if (res.status === 200) return { ok: true, message: 'Azure Speech ishlayapti' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Speech kaliti yoki region noto‘g‘ri' };
  return { ok: null, message: 'kutilmagan javob: ' + res.status };
}

async function validateTelegram(token, request = httpRequest) {
  const res = await request({ url: `https://api.telegram.org/bot${token}/getMe` });
  if (res.status === 0) return { ok: null, message: 'tekshirib bo‘lmadi (' + (res.error || 'tarmoq') + ')' };
  try { const j = JSON.parse(res.body); if (j.ok) return { ok: true, message: 'bot: @' + j.result.username, username: j.result.username }; } catch (_) {}
  return { ok: false, message: 'Telegram token noto‘g‘ri' };
}

// ── So'rovlar ─────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'llm', title: '1/4  Azure OpenAI — JARVIS ning "miyasi" (agent, missiyalar)',
    help: 'Azure AI Foundry → sizning project → "Endpoints and keys". Model deployment: masalan gpt-5-mini.',
    fields: [
      { key: 'AZURE_OPENAI_ENDPOINT', label: 'Endpoint (https://….services.ai.azure.com)', required: true },
      { key: 'AZURE_OPENAI_KEY', label: 'API key', secret: true, required: true },
      { key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Model deployment nomi', def: 'gpt-5-mini' }] },
  { id: 'voice', title: '2/4  Azure Voice Live — ovozli suhbat',
    help: 'Odatda yuqoridagi bilan bir xil resurs. Realtime model deploymenti (gpt-realtime) kerak. Enter = yuqoridagi qiymat.',
    fields: [
      { key: 'AZURE_VOICELIVE_ENDPOINT', label: 'Voice Live endpoint', copyFrom: 'AZURE_OPENAI_ENDPOINT' },
      { key: 'AZURE_VOICELIVE_KEY', label: 'Voice Live key', secret: true, copyFrom: 'AZURE_OPENAI_KEY' },
      { key: 'AZURE_VOICELIVE_MODEL', label: 'Realtime deployment nomi', def: 'gpt-realtime' }] },
  { id: 'speech', title: '3/4  Azure Speech — eshitish va gapirish (STT/TTS)',
    help: 'Azure portal → Speech service → "Keys and Endpoint". Region masalan swedencentral, eastus.',
    fields: [
      { key: 'AZURE_SPEECH_KEY', label: 'Speech key', secret: true, required: true },
      { key: 'AZURE_SPEECH_REGION', label: 'Speech region', required: true }] },
  { id: 'telegram', title: '4/4  Telegram (ixtiyoriy) — telefondan masofadan boshqarish',
    help: '@BotFather → /newbot → token. Enter = o‘tkazib yuborish (keyinroq qo‘shish mumkin).',
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', secret: true, optional: true },
      { key: 'TELEGRAM_OWNER_IDS', label: 'Sizning Telegram ID (bo‘sh qoldirsangiz, botga /start yozib juftlashtirasiz)', optional: true }] }
];

function ask(rl, prompt, secret) {
  return new Promise(resolve => {
    if (secret) rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, answer => { if (secret) { rl._writeToOutput = s => process.stdout.write(s); process.stdout.write('\n'); } resolve(answer.trim()); });
  });
}

async function runWizard({ envPath = ENV, reconfigure = false, interactive = process.stdin.isTTY, request = httpRequest, io = { ask, log: console.log } } = {}) {
  if (!fs.existsSync(envPath)) { fs.copyFileSync(path.join(ROOT, '.env.example'), envPath); io.log(c.g('✅ .env yaratildi')); }
  try { fs.chmodSync(envPath, 0o600); } catch (_) {}
  let text = fs.readFileSync(envPath, 'utf8');
  const save = () => fs.writeFileSync(envPath, text, { mode: 0o600 });
  const val = k => parse(text).get(k) || '';

  if (!val('OPENCLAW_GATEWAY_TOKEN')) { text = setKey(text, 'OPENCLAW_GATEWAY_TOKEN', require('crypto').randomBytes(24).toString('hex')); save(); io.log(c.g('✅ Gateway tokeni avtomatik yaratildi')); }

  const missing = SECTIONS.flatMap(s => s.fields).filter(f => f.required && !val(f.key));
  if (!interactive) {
    if (missing.length) { io.log(c.y('⚠️  .env da to‘ldirilmagan: ' + missing.map(f => f.key).join(', ') + '\n   nano .env   — keyin: ./install.sh')); return { ok: false, missing: missing.map(f => f.key) }; }
    return { ok: true, missing: [] };
  }

  const failed = [];
  const rl = io.ask === ask ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  try {
    for (const section of SECTIONS) {
      // Bo'lim bir marta ham to'ldirilmagan bo'lsa (yoki --reconfigure), undagi HAMMA maydon so'raladi —
      // oldindan yozilgan standartlar (deployment nomi, region) ham ko'rsatiladi va Enter bilan qabul qilinadi.
      const trigger = f => (f.required || f.copyFrom || f.optional) && !val(f.key);
      if (!reconfigure && !section.fields.some(trigger)) continue;
      io.log('\n' + c.b(section.title)); io.log(c.d('   ' + section.help));
      for (let attempt = 1; attempt <= 3; attempt++) {
        for (const f of section.fields) {
          const current = val(f.key);
          const fallback = current || f.def || (f.copyFrom ? val(f.copyFrom) : '');
          const shown = f.secret
            ? (current ? ' [Enter = saqlangan]' : (f.copyFrom && fallback ? ' [Enter = yuqoridagi]' : (f.optional ? ' [Enter = o‘tkazish]' : '')))
            : (fallback ? ` [${fallback}]` : (f.optional ? ' [Enter = o‘tkazish]' : ''));
          let answer = await io.ask(rl, `   ${f.label}${shown}: `, f.secret);
          if (!answer) answer = fallback;
          while (!answer && f.required) { io.log(c.y('   Bu majburiy.')); answer = await io.ask(rl, `   ${f.label}: `, f.secret); }
          text = setKey(text, f.key, answer || '');
        }
        save();
        let result = null;
        if (section.id === 'llm') result = await validateAzureOpenAI({ endpoint: val('AZURE_OPENAI_ENDPOINT'), key: val('AZURE_OPENAI_KEY'), deployment: val('AZURE_OPENAI_DEPLOYMENT') || 'gpt-5-mini' }, request);
        if (section.id === 'speech') result = await validateSpeech({ key: val('AZURE_SPEECH_KEY'), region: val('AZURE_SPEECH_REGION') }, request);
        if (section.id === 'telegram' && val('TELEGRAM_BOT_TOKEN')) result = await validateTelegram(val('TELEGRAM_BOT_TOKEN'), request);
        if (section.id === 'voice') { text = setKey(text, 'AZURE_VOICELIVE_API_KEY', val('AZURE_VOICELIVE_KEY')); save(); }
        if (section.id === 'telegram' && val('TELEGRAM_OWNER_IDS')) { text = setKey(text, 'TELEGRAM_CHAT_ID', val('TELEGRAM_OWNER_IDS').split(/[,\s;]+/)[0]); save(); }
        if (!result) break;
        if (result.ok === true) { io.log('   ' + c.g('✅ ' + result.message)); break; }
        if (result.ok === null) { io.log('   ' + c.y('⚠️  ' + result.message + ' — keyinroq tekshiriladi')); break; }
        io.log('   ' + c.r('❌ ' + result.message));
        if (attempt === 3) { failed.push(section.title.replace(/^\S+\s+/, '')); break; }
        const again = await io.ask(rl, '   Qayta kiritasizmi? [Y/n]: ');
        if (/^n/i.test(again)) { failed.push(section.title.replace(/^\S+\s+/, '')); break; }
      }
    }

    if (reconfigure || !parse(text).has('JARVIS_CONFIRM_MODE') || !val('JARVIS_CONFIRM_MODE')) {
      io.log('\n' + c.b('Xavfsizlik: JARVIS qachon tasdiq so‘rasin?'));
      io.log('   1) payments — faqat pul/to‘lov uchun so‘raydi (tavsiya)\n   2) off      — hech qachon so‘ramaydi (to‘liq avtonom; to‘lov va o‘chirish ham!)\n   3) strict   — xat yuborish, o‘chirish, ariza va boshqa xavfli ishlarda ham so‘raydi');
      const a = await io.ask(rl, '   Tanlang [1]: ');
      text = setKey(text, 'JARVIS_CONFIRM_MODE', { '2': 'off', '3': 'strict' }[a] || 'payments'); save();
    }
  } finally { if (rl) rl.close(); }
  const stillMissing = SECTIONS.flatMap(s => s.fields).filter(f => f.required && !val(f.key)).map(f => f.key);
  if (stillMissing.length) io.log(c.y('\n⚠️  Hali bo‘sh: ' + stillMissing.join(', ')));
  else if (failed.length) io.log(c.y('\n⚠️  .env to‘ldirildi, lekin tekshiruvdan o‘tmadi: ' + failed.join('; ') + '\n   Tuzatish: ./install.sh --reconfigure (yoki .env ni tahrirlab ./jarvis restart)'));
  else io.log(c.g('\n✅ .env tayyor'));
  return { ok: !stillMissing.length, missing: stillMissing, failed };
}

if (require.main === module) {
  runWizard({ reconfigure: process.argv.includes('--reconfigure') }).then(r => { if (!r.ok) process.exitCode = 3; }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { parse, setKey, validateAzureOpenAI, validateSpeech, validateTelegram, runWizard, baseUrl, SECTIONS };
