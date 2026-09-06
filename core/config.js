'use strict';

const fs = require('fs');

const PLACEHOLDER = /^(?:\.{3}|changeme|replace[-_ ]?me|your[-_ ])/i;

const CONFIG_SCHEMA = Object.freeze({
  AZURE_SPEECH_KEY: { type: 'secret', required: true },
  AZURE_SPEECH_REGION: { type: 'string', required: true },
  AZURE_SPEECH_VOICE: { type: 'string', default: 'uz-UZ-SardorNeural' },
  AZURE_SPEECH_LANGUAGE: { type: 'string', default: 'uz-UZ' },
  AZURE_OPENAI_ENDPOINT: { type: 'url', required: true },
  AZURE_OPENAI_KEY: { type: 'secret', required: true },
  AZURE_OPENAI_DEPLOYMENT: { type: 'string', required: true },
  OPENCLAW_GATEWAY_TOKEN: { type: 'secret', required: true },
  AZURE_OPENAI_VISION_DEPLOYMENT: { type: 'string', default: 'gpt-4.1' },
  AZURE_REALTIME_DEPLOYMENT: { type: 'string', default: 'gpt-realtime-2.1' },
  AZURE_REALTIME_VOICE: { type: 'string', default: 'cedar' },
  JARVIS_VOICE_STYLE: { type: 'enum', default: 'cinematic-uzbek', values: ['cinematic-uzbek', 'default'] },
  UZBEK_SPEECH_NORMALIZATION: { type: 'boolean', default: true },
  REALTIME_ENABLED: { type: 'boolean', default: true },
  REALTIME_IDLE_MS: { type: 'integer', default: 20000, min: 5000, max: 300000 },
  REALTIME_MAX_RESPONSE_TOKENS: { type: 'integer', default: 512, min: 64, max: 4096 },
  REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS: { type: 'integer', default: 256, min: 64, max: 1024 },
  REALTIME_WAKE_PREROLL_MS: { type: 'integer', default: 1800, min: 400, max: 5000 },
  REALTIME_INPUT_GAIN: { type: 'number', default: 3, min: 1, max: 8 },
  REALTIME_FAILURE_LIMIT: { type: 'integer', default: 3, min: 1, max: 20 },
  REALTIME_COOLDOWN_MS: { type: 'integer', default: 120000, min: 1000, max: 3600000 },
  ENERGY_MIN_STT: { type: 'number', default: 120, min: 1, max: 10000 },
  VOICE_ACTIVITY_THRESHOLD: { type: 'number', default: 150, min: 1, max: 10000 },
  MIC_MUTE_GRACE_MS: { type: 'integer', default: 1500, min: 0, max: 10000 },
  DUPLEX_ECHO_THRESHOLD: { type: 'number', default: 0.72, min: 0.1, max: 0.99 },
  DUPLEX_BARGE_IN_RMS: { type: 'number', default: 650, min: 10, max: 10000 },
  DUPLEX_NOISE_FLOOR: { type: 'number', default: 80, min: 0, max: 5000 },
  DUPLEX_NOISE_MULTIPLIER: { type: 'number', default: 2.4, min: 1, max: 10 },
  DUPLEX_HANGOVER_MS: { type: 'integer', default: 650, min: 0, max: 5000 },
  DUPLEX_MAX_ECHO_LAG_MS: { type: 'integer', default: 180, min: 0, max: 1000 },
  HOTWORD_COOLDOWN_MS: { type: 'integer', default: 3000, min: 500, max: 60000 },
  COMMAND_DEDUP_MS: { type: 'integer', default: 5000, min: 500, max: 60000 },
  RESPONSE_DEDUP_MS: { type: 'integer', default: 15000, min: 1000, max: 120000 },
  OPENWAKEWORD_ENABLED: { type: 'boolean', default: true },
  OPENWAKEWORD_THRESHOLD: { type: 'number', default: 0.55, min: 0.01, max: 0.99 },
  OPENWAKEWORD_INPUT_GAIN: { type: 'number', default: 2, min: 1, max: 4 },
  WAKEWORD_THRESHOLD: { type: 'number', default: 0.35, min: 0.01, max: 0.99 },
  CLAP_TRIGGER_ENABLED: { type: 'boolean', default: false },
  CLAP_SPIKE_RATIO: { type: 'number', default: 4, min: 1.1, max: 30 },
  CLAP_ABS_FLOOR: { type: 'number', default: 250, min: 1, max: 10000 },
  PROACTIVE_ENABLED: { type: 'boolean', default: false },
  PROACTIVE_INTERVAL_MIN: { type: 'integer', default: 30, min: 1, max: 1440 },
  PROACTIVE_CONTEXT_MEMORY: { type: 'integer', default: 10, min: 1, max: 100 },
  URGENT_CHECK_ENABLED: { type: 'boolean', default: true },
  URGENT_CHECK_INTERVAL_MIN: { type: 'integer', default: 3, min: 1, max: 1440 },
  DAILY_TASKS_ENABLED: { type: 'boolean', default: true },
  DAILY_TASK_LEAD_MIN: { type: 'integer', default: 0, min: 0, max: 1440 },
  DAILY_REPORT_ENABLED: { type: 'boolean', default: true },
  DAILY_REPORT_HOUR: { type: 'integer', default: 22, min: 0, max: 23 },
  PROJECTS_ENABLED: { type: 'boolean', default: true },
  PROJECT_STEP_MAX_ATTEMPTS: { type: 'integer', default: 2, min: 1, max: 10 },
  FAST_ACTION_LEARN_ENABLED: { type: 'boolean', default: true },
  FAST_ACTION_LEARN_INTERVAL_MIN: { type: 'integer', default: 720, min: 5, max: 10080 },
  EMBED_INDEX_ENABLED: { type: 'boolean', default: true },
  EMBED_INDEX_INTERVAL_MIN: { type: 'integer', default: 15, min: 1, max: 1440 },
  SCREEN_MONITOR_ENABLED: { type: 'boolean', default: true },
  SCREEN_MONITOR_INTERVAL: { type: 'integer', default: 20000, min: 1000, max: 3600000 },
  SCREEN_MONITOR_THRESHOLD: { type: 'number', default: 15, min: 0, max: 100 },
  SCREEN_MONITOR_VISION_COOLDOWN: { type: 'integer', default: 120000, min: 1000, max: 86400000 },
  DASHBOARD_PORT: { type: 'integer', default: 7890, min: 1024, max: 65535 },
  RUN_TASK_TIMEOUT_MS: { type: 'integer', default: 180000, min: 1000, max: 3600000 },
  MEMORY_MAX_ENTRIES: { type: 'integer', default: 500, min: 10, max: 100000 },
  LOG_LEVEL: { type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'] },
  JARVIS_LANG: { type: 'string', default: 'uz-UZ' },
  JARVIS_NAME: { type: 'string', default: 'Jarvis' },
  TIMEZONE: { type: 'string', default: 'Asia/Kuala_Lumpur' }
});

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = unquote(match[2]);
  }
  return result;
}

function readEnvFile(filePath) {
  return parseEnv(fs.readFileSync(filePath, 'utf8'));
}

function convert(name, raw, rule) {
  if (rule.type === 'string' || rule.type === 'secret') return String(raw);
  if (rule.type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(raw)) return true;
    if (/^(false|0|no|off)$/i.test(raw)) return false;
    throw new Error('boolean true/false bo‘lishi kerak');
  }
  if (rule.type === 'integer' || rule.type === 'number') {
    const value = rule.type === 'integer' ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(value) || (rule.type === 'integer' && !/^-?\d+$/.test(String(raw)))) throw new Error(`to‘g‘ri ${rule.type} emas`);
    if (rule.min !== undefined && value < rule.min) throw new Error(`minimum ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) throw new Error(`maximum ${rule.max}`);
    return value;
  }
  if (rule.type === 'url') {
    const value = new URL(String(raw));
    if (!['http:', 'https:'].includes(value.protocol)) throw new Error('faqat http/https URL');
    return value.toString().replace(/\/$/, '');
  }
  if (rule.type === 'enum') {
    if (!rule.values.includes(raw)) throw new Error(`ruxsat etilgan qiymatlar: ${rule.values.join(', ')}`);
    return raw;
  }
  throw new Error(`${name} uchun noma’lum schema turi`);
}

function validateConfig(input, options = {}) {
  const schema = options.schema || CONFIG_SCHEMA;
  const values = {};
  const errors = [];
  const warnings = [];
  const source = { ...input };

  for (const [name, rule] of Object.entries(schema)) {
    const raw = source[name];
    const missing = raw === undefined || String(raw).trim() === '' || PLACEHOLDER.test(String(raw).trim());
    if (missing) {
      if (rule.required) errors.push({ key: name, code: 'required', message: `${name} majburiy va haqiqiy qiymat bo‘lishi kerak` });
      else if (Object.prototype.hasOwnProperty.call(rule, 'default')) values[name] = rule.default;
      continue;
    }
    try { values[name] = convert(name, raw, rule); }
    catch (error) { errors.push({ key: name, code: 'invalid', message: `${name}: ${error.message}` }); }
  }

  for (const name of Object.keys(source)) {
    if (!schema[name] && options.warnUnknown) warnings.push({ key: name, code: 'unknown', message: `${name} schema’da yo‘q` });
  }
  if (values.REALTIME_ENABLED && !values.AZURE_REALTIME_DEPLOYMENT) {
    errors.push({ key: 'AZURE_REALTIME_DEPLOYMENT', code: 'conditional', message: 'Realtime yoqilganida deployment kerak' });
  }
  return { ok: errors.length === 0, values, errors, warnings };
}

function redactConfig(values, schema = CONFIG_SCHEMA) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, schema[key]?.type === 'secret' ? '<redacted>' : value]));
}

module.exports = { CONFIG_SCHEMA, parseEnv, readEnvFile, validateConfig, redactConfig };