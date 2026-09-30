#!/usr/bin/env node
'use strict';

/**
 * JARVIS "miyasi"ni almashtirish:  node scripts/set-brain.js local | cloud
 *   local — OpenClaw agenti va JARVIS chaqiruvlari lokal modellarda (Brain xizmati orqali, bepul, RAM'da bittadan)
 *   cloud — Azure OpenAI (avvalgi sozlama tiklanadi)
 * O'zgarishdan keyin: ./jarvis restart
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OC = path.join(ROOT, 'openclaw.json');
const SAVED = path.join(ROOT, '.run', 'brain-cloud-model.json');
const BRAIN_URL = `http://127.0.0.1:${process.env.BRAIN_PORT || 11435}`;

const LOCAL_PROVIDER = {
  baseUrl: BRAIN_URL,          // Ollama emas, Brain hakami: RAM'da bir vaqtda bitta model
  api: 'ollama',               // native API — asbob chaqirish to'g'ri ishlaydi (/v1 emas)
  apiKey: 'ollama-local',
  timeoutSeconds: 300,
  models: [
    { id: 'qwen3.5:9b', name: 'Qwen 3.5 9B (local)', input: ['text', 'image'], contextWindow: 32768, params: { num_ctx: 32768, keep_alive: '5m' } },
    { id: 'gemma4:e2b', name: 'Gemma 4 E2B (local, audio)', input: ['text', 'image'], contextWindow: 32768, params: { num_ctx: 32768, keep_alive: '5m' } }
  ]
};

const LOCAL_TOOLS = ['exec', 'process', 'read', 'write', 'edit', 'web_fetch', 'web_search', 'image'];

function setEnv(key, value) {
  const file = path.join(ROOT, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : text.replace(/\n*$/, '\n') + `${key}=${value}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function apply(mode, { ocPath = OC, savedPath = SAVED, write = true } = {}) {
  const config = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers.ollama = LOCAL_PROVIDER;
  // Lokal model uchun faqat kerakli asboblar: ko'rsatma qisqa bo'lsin (Mac'da uzun matnni o'qish sekin — ~54-174 token/s).
  // JARVIS skill'lari (memory, desktop-control, phone-control, gmail...) exec orqali chaqiriladi, shuning uchun exec yetarli.
  config.tools = config.tools || {};
  config.tools.byProvider = config.tools.byProvider || {};
  config.tools.byProvider.ollama = { allow: LOCAL_TOOLS };
  const defaults = config.agents.defaults;
  if (mode === 'local') {
    if (!String(defaults.model?.primary || '').startsWith('ollama/')) {
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, JSON.stringify(defaults.model || {}, null, 2));
    }
    defaults.model = { primary: 'ollama/qwen3.5:9b', fallbacks: [] };
  } else if (mode === 'cloud') {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(savedPath, 'utf8')); } catch (_) {}
    defaults.model = previous && previous.primary ? previous : { primary: 'azure-openai/gpt-5-mini', fallbacks: [] };
  } else {
    throw new Error('rejim: local | cloud');
  }
  if (write) fs.writeFileSync(ocPath, JSON.stringify(config, null, 2) + '\n');
  return config;
}

if (require.main === module) {
  const mode = String(process.argv[2] || '').toLowerCase();
  try {
    apply(mode);
    setEnv('JARVIS_BRAIN', mode);
    try { execFileSync('openclaw', ['config', 'validate'], { env: { ...process.env, OPENCLAW_CONFIG_PATH: OC, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || 'x' }, stdio: 'ignore' }); }
    catch (_) { console.error('⚠️  openclaw config validate xato berdi — openclaw.json ni tekshiring'); process.exitCode = 1; }
    console.log(mode === 'local' ? '✅ Lokal miya: Qwen 3.5 9B (agent), Gemma 4 (audio), Bonsai 27B (qiyin). Endi: ./jarvis restart'
      : '✅ Bulut miya (Azure). Endi: ./jarvis restart');
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}

module.exports = { apply, LOCAL_PROVIDER, LOCAL_TOOLS };
