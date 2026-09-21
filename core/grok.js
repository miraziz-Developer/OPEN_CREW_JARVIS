'use strict';

const https = require('https');
const { execFile } = require('child_process');
const { env } = require('./llm-env');

// Kuchli fikrlovchi model (grok-4.6). Limiti daqiqasiga ~50 000 token, shuning uchun:
//  - faqat "qiyin" joylarda ishlatiladi (missiya rejasi, yakuniy tekshiruv, chuqur tahlil);
//  - har chaqiruv oldin token "byudjet"ini band qiladi (siljuvchi 60 s oyna, xavfsiz 45 000);
//  - joy bo'lmasa qisqa kutadi, bo'lmasa xato beradi — chaqiruvchi arzon modelga o'tadi;
//  - 429 kelsa Retry-After gacha jim turadi.
class BudgetError extends Error { constructor(msg) { super(msg); this.name = 'GrokBudgetError'; } }

class TokenWindow {
  constructor({ limit = 45000, windowMs = 60000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { limit, windowMs, now, sleep });
    this.entries = []; this.blockedUntil = 0;
  }
  _prune() { const cut = this.now() - this.windowMs; this.entries = this.entries.filter(e => e.at > cut); }
  used() { this._prune(); return this.entries.reduce((s, e) => s + e.n, 0); }
  async acquire(estimate, maxWaitMs = 8000) {
    const need = Math.min(estimate, this.limit);
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      this._prune();
      const blocked = this.blockedUntil - this.now();
      if (blocked <= 0 && this.used() + need <= this.limit) {
        const entry = { at: this.now(), n: need };
        this.entries.push(entry);
        return entry;
      }
      let wait = blocked > 0 ? blocked : 0;
      if (wait <= 0) { // eng eski yozuv chiqib ketguncha
        let sum = this.used();
        for (const e of this.entries) { sum -= e.n; if (sum + need <= this.limit) { wait = e.at + this.windowMs - this.now() + 5; break; } }
        if (wait <= 0) wait = 250;
      }
      if (this.now() + wait > deadline) throw new BudgetError(`Grok budget busy (${this.used()}/${this.limit} tokens in last minute)`);
      await this.sleep(wait);
    }
  }
  block(ms) { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
}

// Autentifikatsiya xatosidan keyin 10 daqiqa urinmaymiz (har chaqiruvda az/HTTP sarflamaslik uchun).
let authDownUntil = 0;
const shared = new TokenWindow({ limit: parseInt(env('GROK_TPM'), 10) || 45000 });

function config() {
  const endpoint = String(env('GROK_ENDPOINT') || '').replace(/\/$/, '');
  return { endpoint, key: env('GROK_KEY'), model: env('GROK_DEPLOYMENT') || 'grok-4.6' };
}
// Kalit bo'lmasa — Entra ID (az login) tokeni; ~1 soat amal qiladi, keshlanadi.
let tokenCache = { token: '', exp: 0 };
function entraToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 300000) return Promise.resolve(tokenCache.token);
  return new Promise((resolve, reject) => execFile('az', ['account', 'get-access-token', '--scope', 'https://ai.azure.com/.default', '-o', 'json'], { timeout: 20000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } }, (err, out) => {
    if (err) return reject(new Error('Entra token olinmadi (az login kerak)'));
    try { const j = JSON.parse(out); tokenCache = { token: j.accessToken, exp: Date.parse(j.expiresOn.replace(' ', 'T')) || Date.now() + 3300000 }; resolve(tokenCache.token); }
    catch (_) { reject(new Error('az javobi o‘qilmadi')); }
  }));
}
const authHeaders = async key => key ? { 'api-key': key } : { Authorization: 'Bearer ' + await entraToken() };
function available() { const c = config(); if (Date.now() < authDownUntil) return false; return Boolean(c.endpoint && (c.key || env('GROK_AUTH') === 'entra') && env('GROK_ENABLED') !== 'false'); }

const estimateTokens = (text, maxOut) => Math.ceil(String(text || '').length / 3) + maxOut;

function post(url, key, payload, timeoutMs) {
  return authHeaders(key).then(auth => postWith(url, auth, payload, timeoutMs));
}
function postWith(url, auth, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(new URL(url), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('grok timeout')); });
    req.write(body); req.end();
  });
}

async function chat({ system = '', user = '', maxTokens = 3000, timeoutMs = 120000, maxWaitMs = 8000 } = {}, { window = shared, transport = post } = {}) {
  const c = config();
  if (!available() && !c.key) throw new Error('Grok sozlanmagan (GROK_ENDPOINT + GROK_KEY yoki GROK_AUTH=entra)');
  const input = String(user).slice(0, 60000);
  if (!c.key && env('GROK_AUTH') === 'entra') { try { await entraToken(); } catch (e) { authDownUntil = Date.now() + 600000; throw e; } }
  const entry = await window.acquire(estimateTokens(system + input, maxTokens), maxWaitMs);
  const res = await transport(`${c.endpoint}/chat/completions`, c.key, {
    model: c.model, max_completion_tokens: maxTokens,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: input }]
  }, timeoutMs);
  if (res.status === 429) {
    const wait = (parseFloat(res.headers['retry-after']) || 20) * 1000;
    window.block(wait);
    throw new BudgetError(`Grok 429 — ${Math.round(wait / 1000)}s kutish`);
  }
  if (res.status === 401 || res.status === 403) { authDownUntil = Date.now() + 600000; throw new Error('Grok auth rad etildi (' + res.status + ')'); }
  let parsed;
  try { parsed = JSON.parse(res.data); } catch (_) { throw new Error('Grok javobi o‘qilmadi: ' + String(res.data).slice(0, 120)); }
  if (parsed.error) throw new Error(parsed.error.message || 'Grok xatosi');
  const total = parsed.usage?.total_tokens;
  if (total) entry.n = total; // haqiqiy sarfga tuzatamiz
  try { const m = require('./usage-meter').sharedMeter(); m.add('llm_tokens', total); m.add('grok_tokens', total); } catch (_) {}
  const text = parsed.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error('bo‘sh Grok javobi');
  return String(text).trim();
}

module.exports = { chat, available, TokenWindow, BudgetError, estimateTokens, status: () => ({ used: shared.used(), limit: shared.limit, available: available() }) };
