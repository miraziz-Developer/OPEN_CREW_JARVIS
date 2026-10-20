#!/usr/bin/env node
'use strict';

/**
 * JARVIS setup wizard: creates .env and asks for the required keys step by step.
 *  - explains what each key is and where to get it;
 *  - validates every key as soon as it is entered (Azure OpenAI, Gemini, Azure Speech, Telegram);
 *  - never re-asks values that are already set (--reconfigure asks for everything again);
 *  - without a TTY it only reports what is missing.
 * Secrets are never echoed and are written only to .env (0600).
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

// ── Validation (`request` is injectable for tests) ─────────────────────
function httpRequest({ method = 'GET', url, headers = {}, body, timeoutMs = 12000 }) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : null;
    let target;
    try { target = new URL(url); } catch (_) { return resolve({ status: 0, error: 'invalid URL' }); }
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
const unreachable = res => ({ ok: null, message: 'could not verify (' + (res.error || 'network') + ')' });

// ok: true (works) | false (definitely wrong) | null (could not tell, e.g. no network)
async function validateAzureOpenAI({ endpoint, key, deployment }, request = httpRequest) {
  if (!/^https:\/\/.+/i.test(String(endpoint || ''))) return { ok: false, message: 'the endpoint must start with https://' };
  // JARVIS missions use the same route (core/llm.js): {endpoint}/openai/v1/responses with an api-key header.
  const res = await request({ method: 'POST', url: baseUrl(endpoint) + '/openai/v1/responses', headers: { 'api-key': key },
    body: { model: deployment, input: 'ping', max_output_tokens: 16 } });
  if (res.status === 0) return unreachable(res);
  if (res.status === 200) return { ok: true, message: `Azure OpenAI works (${deployment})` };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'wrong key or endpoint (' + res.status + ')' };
  if (res.status === 404) return { ok: false, message: `deployment "${deployment}" not found; check the name in Azure` };
  if (res.status === 400 || res.status === 429) return { ok: true, message: 'key accepted (' + res.status + ')' };
  return { ok: null, message: 'unexpected response: ' + res.status };
}

async function validateGemini(key, request = httpRequest) {
  const res = await request({ url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}` });
  if (res.status === 0) return unreachable(res);
  if (res.status === 200) return { ok: true, message: 'Gemini API key works' };
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, message: 'Gemini API key rejected (' + res.status + ')' };
  return { ok: null, message: 'unexpected response: ' + res.status };
}

async function validateSpeech({ key, region }, request = httpRequest) {
  if (!key || !region) return { ok: false, message: 'key and region are required' };
  const res = await request({ method: 'POST', url: `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' } });
  if (res.status === 0) return unreachable(res);
  if (res.status === 200) return { ok: true, message: 'Azure Speech works' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'wrong Speech key or region' };
  return { ok: null, message: 'unexpected response: ' + res.status };
}

async function validateTelegram(token, request = httpRequest) {
  const res = await request({ url: `https://api.telegram.org/bot${token}/getMe` });
  if (res.status === 0) return unreachable(res);
  try { const j = JSON.parse(res.body); if (j.ok) return { ok: true, message: 'bot: @' + j.result.username, username: j.result.username }; } catch (_) {}
  return { ok: false, message: 'wrong Telegram token' };
}

// ── Questions ─────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'llm', title: '1/5  Azure OpenAI — the JARVIS "brain" (agent, missions)',
    help: 'Azure AI Foundry → your project → "Endpoints and keys". Model deployment, e.g. gpt-5-mini.',
    fields: [
      { key: 'AZURE_OPENAI_ENDPOINT', label: 'Endpoint (https://….services.ai.azure.com)', required: true },
      { key: 'AZURE_OPENAI_KEY', label: 'API key', secret: true, required: true },
      { key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Model deployment name', def: 'gpt-5-mini' }] },
  { id: 'gemini', title: '2/5  Google Gemini (recommended) — fastest realtime voice, vision and speech-to-text',
    help: 'Free key at https://aistudio.google.com/apikey. Enter = skip (Azure Voice Live is used instead).',
    fields: [
      { key: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true }] },
  { id: 'voice', title: '3/5  Azure Voice Live — realtime voice fallback',
    help: 'Usually the same resource as above, with a realtime model deployment (gpt-realtime). Enter = the value above.',
    fields: [
      { key: 'AZURE_VOICELIVE_ENDPOINT', label: 'Voice Live endpoint', copyFrom: 'AZURE_OPENAI_ENDPOINT' },
      { key: 'AZURE_VOICELIVE_KEY', label: 'Voice Live key', secret: true, copyFrom: 'AZURE_OPENAI_KEY' },
      { key: 'AZURE_VOICELIVE_MODEL', label: 'Realtime deployment name', def: 'gpt-realtime' }] },
  { id: 'speech', title: '4/5  Azure Speech — listening and speaking (STT/TTS)',
    help: 'Azure portal → Speech service → "Keys and Endpoint". Region, e.g. swedencentral or eastus.',
    fields: [
      { key: 'AZURE_SPEECH_KEY', label: 'Speech key', secret: true, required: true },
      { key: 'AZURE_SPEECH_REGION', label: 'Speech region', required: true }] },
  { id: 'telegram', title: '5/5  Telegram (optional) — remote control from your phone',
    help: '@BotFather → /newbot → token. Enter = skip (you can add it later).',
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', secret: true, optional: true },
      { key: 'TELEGRAM_OWNER_IDS', label: 'Your Telegram user ID (leave empty to pair later with /pair <code>)', optional: true }] }
];

function ask(rl, prompt, secret) {
  return new Promise(resolve => {
    if (secret) rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, answer => { if (secret) { rl._writeToOutput = s => process.stdout.write(s); process.stdout.write('\n'); } resolve(answer.trim()); });
  });
}

async function validateSection(section, val, request) {
  if (section.id === 'llm') return validateAzureOpenAI({ endpoint: val('AZURE_OPENAI_ENDPOINT'), key: val('AZURE_OPENAI_KEY'), deployment: val('AZURE_OPENAI_DEPLOYMENT') || 'gpt-5-mini' }, request);
  if (section.id === 'gemini' && val('GEMINI_API_KEY')) return validateGemini(val('GEMINI_API_KEY'), request);
  if (section.id === 'speech') return validateSpeech({ key: val('AZURE_SPEECH_KEY'), region: val('AZURE_SPEECH_REGION') }, request);
  if (section.id === 'telegram' && val('TELEGRAM_BOT_TOKEN')) return validateTelegram(val('TELEGRAM_BOT_TOKEN'), request);
  return null;
}

async function runWizard({ envPath = ENV, reconfigure = false, interactive = process.stdin.isTTY, request = httpRequest, io = { ask, log: console.log } } = {}) {
  if (!fs.existsSync(envPath)) { fs.copyFileSync(path.join(ROOT, '.env.example'), envPath); io.log(c.g('✅ .env created')); }
  try { fs.chmodSync(envPath, 0o600); } catch (_) {}
  let text = fs.readFileSync(envPath, 'utf8');
  const save = () => fs.writeFileSync(envPath, text, { mode: 0o600 });
  const val = k => parse(text).get(k) || '';

  if (!val('OPENCLAW_GATEWAY_TOKEN')) { text = setKey(text, 'OPENCLAW_GATEWAY_TOKEN', require('crypto').randomBytes(24).toString('hex')); save(); io.log(c.g('✅ Gateway token generated')); }

  const missing = SECTIONS.flatMap(s => s.fields).filter(f => f.required && !val(f.key));
  if (!interactive) {
    if (missing.length) { io.log(c.y('⚠️  Not filled in .env: ' + missing.map(f => f.key).join(', ') + '\n   nano .env   then: ./install.sh')); return { ok: false, missing: missing.map(f => f.key) }; }
    return { ok: true, missing: [] };
  }

  const failed = [];
  const rl = io.ask === ask ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  try {
    for (const section of SECTIONS) {
      // A section that was never filled in (or --reconfigure) asks for EVERY field, showing the
      // prefilled defaults (deployment name, region) so Enter accepts them.
      const trigger = f => (f.required || f.copyFrom || f.optional) && !val(f.key);
      if (!reconfigure && !section.fields.some(trigger)) continue;
      io.log('\n' + c.b(section.title)); io.log(c.d('   ' + section.help));
      for (let attempt = 1; attempt <= 3; attempt++) {
        for (const f of section.fields) {
          const current = val(f.key);
          const fallback = current || f.def || (f.copyFrom ? val(f.copyFrom) : '');
          const shown = f.secret
            ? (current ? ' [Enter = saved]' : (f.copyFrom && fallback ? ' [Enter = value above]' : (f.optional ? ' [Enter = skip]' : '')))
            : (fallback ? ` [${fallback}]` : (f.optional ? ' [Enter = skip]' : ''));
          let answer = await io.ask(rl, `   ${f.label}${shown}: `, f.secret);
          if (!answer) answer = fallback;
          while (!answer && f.required) { io.log(c.y('   This is required.')); answer = await io.ask(rl, `   ${f.label}: `, f.secret); }
          text = setKey(text, f.key, answer || '');
        }
        save();
        if (section.id === 'voice') { text = setKey(text, 'AZURE_VOICELIVE_API_KEY', val('AZURE_VOICELIVE_KEY')); save(); }
        if (section.id === 'telegram' && val('TELEGRAM_OWNER_IDS')) { text = setKey(text, 'TELEGRAM_CHAT_ID', val('TELEGRAM_OWNER_IDS').split(/[,\s;]+/)[0]); save(); }
        const result = await validateSection(section, val, request);
        if (!result) break;
        if (result.ok === true) { io.log('   ' + c.g('✅ ' + result.message)); break; }
        if (result.ok === null) { io.log('   ' + c.y('⚠️  ' + result.message + '; it will be checked later')); break; }
        io.log('   ' + c.r('❌ ' + result.message));
        if (attempt === 3) { failed.push(section.title.replace(/^\S+\s+/, '')); break; }
        const again = await io.ask(rl, '   Try again? [Y/n]: ');
        if (/^n/i.test(again)) { failed.push(section.title.replace(/^\S+\s+/, '')); break; }
      }
    }

    if (reconfigure || !parse(text).has('JARVIS_CONFIRM_MODE') || !val('JARVIS_CONFIRM_MODE')) {
      io.log('\n' + c.b('Safety: when should JARVIS ask for confirmation?'));
      io.log('   1) payments — only for money and payments (recommended)\n   2) off      — never (fully autonomous, including payments and deletion!)\n   3) strict   — also for sending email, deleting files, submitting forms and other risky actions');
      const a = await io.ask(rl, '   Choose [1]: ');
      text = setKey(text, 'JARVIS_CONFIRM_MODE', { '2': 'off', '3': 'strict' }[a] || 'payments'); save();
    }
  } finally { if (rl) rl.close(); }
  const stillMissing = SECTIONS.flatMap(s => s.fields).filter(f => f.required && !val(f.key)).map(f => f.key);
  if (stillMissing.length) io.log(c.y('\n⚠️  Still empty: ' + stillMissing.join(', ')));
  else if (failed.length) io.log(c.y('\n⚠️  .env is filled in but did not pass validation: ' + failed.join('; ') + '\n   Fix: ./install.sh --reconfigure (or edit .env and run ./jarvis restart)'));
  else io.log(c.g('\n✅ .env ready'));
  return { ok: !stillMissing.length, missing: stillMissing, failed };
}

if (require.main === module) {
  runWizard({ reconfigure: process.argv.includes('--reconfigure') }).then(r => { if (!r.ok) process.exitCode = 3; }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { parse, setKey, validateAzureOpenAI, validateGemini, validateSpeech, validateTelegram, runWizard, baseUrl, SECTIONS };
