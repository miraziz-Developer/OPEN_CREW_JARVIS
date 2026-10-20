#!/usr/bin/env node
'use strict';

/**
 * Switches the JARVIS "brain":  node scripts/set-brain.js gemini | local | cloud
 *   local — the OpenClaw agent and JARVIS calls run on local models (via the brain service: free, one model in RAM at a time)
 *   cloud — Azure OpenAI (restores the previous configuration)
 * After switching: ./jarvis restart
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OC = path.join(ROOT, 'openclaw.json');
const SAVED = path.join(ROOT, '.run', 'brain-cloud-model.json');
const BRAIN_URL = `http://127.0.0.1:${process.env.BRAIN_PORT || 11435}`;

const LOCAL_PROVIDER = {
  baseUrl: BRAIN_URL,          // not Ollama directly but the brain arbiter: one model in RAM at a time
  api: 'ollama',               // native API, so tool calls work correctly (not /v1)
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
  // Only the tools a local model needs, to keep the prompt short (reading long text on a Mac is slow: ~54-174 tokens/s).
  // JARVIS skills (memory, desktop-control, phone-control, gmail...) are called through exec, so exec is enough.
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
    // The compact SOUL.local.md (added by agent-bridge) instead of the large SOUL.md/AGENTS.md: a prompt about half as long.
    defaults.contextInjection = 'never';
  } else if (mode === 'gemini') {
    defaults.model = { primary: 'ollama/qwen3.5:9b', fallbacks: [] }; // routed to Gemini through the brain server
    delete defaults.contextInjection;
  } else if (mode === 'cloud') {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(savedPath, 'utf8')); } catch (_) {}
    defaults.model = previous && previous.primary ? previous : { primary: 'azure-openai/gpt-5-mini', fallbacks: [] };
    delete defaults.contextInjection;
  } else {
    throw new Error('mode: gemini | local | cloud');
  }
  if (write) fs.writeFileSync(ocPath, JSON.stringify(config, null, 2) + '\n');
  return config;
}

if (require.main === module) {
  const mode = String(process.argv[2] || '').toLowerCase();
  try {
    apply(mode);
    setEnv('JARVIS_BRAIN', mode);
    if (mode === 'gemini') {
      setEnv('DEFAULT_MODEL', 'gemini-3.8-flash');
      setEnv('VISION_MODEL', 'gemini-3.8-flash');
      setEnv('AGENT_FAST_MODEL', 'gemini-3.8-flash');
      setEnv('AGENT_STRONG_MODEL', 'gemini-3.8-pro');
    }
    try { execFileSync('openclaw', ['config', 'validate'], { env: { ...process.env, OPENCLAW_CONFIG_PATH: OC, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || 'x' }, stdio: 'ignore' }); }
    catch (_) { console.error('⚠️  openclaw config validate reported an error; check openclaw.json'); process.exitCode = 1; }
    if (mode === 'gemini') {
      console.log('✅ Gemini brain (Gemini 3.8 Flash & Pro: no local RAM load, free and fast). Next: ./jarvis restart');
    } else if (mode === 'local') {
      console.log('✅ Local brain: Qwen 3.5 9B (agent), Gemma 4 (audio), Ternary Bonsai 2 27B (hard tasks). Next: ./jarvis restart');
    } else {
      console.log('✅ Cloud brain (Azure). Next: ./jarvis restart');
    }
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}

module.exports = { apply, LOCAL_PROVIDER, LOCAL_TOOLS };
