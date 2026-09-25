'use strict';

const fs = require('fs');
const { EMAIL } = require('./gmail-task-notifier');

const PLACEHOLDER = /^(?:\.{3}|changeme|replace[-_ ]?me|your[-_ ])/i;

const CONFIG_SCHEMA = Object.freeze({
  AZURE_SPEECH_KEY: { type: 'secret', required: true },
  AZURE_SPEECH_REGION: { type: 'string', required: true },
  AZURE_SPEECH_VOICE: { type: 'string', default: 'en-US-GuyNeural' },
  AZURE_SPEECH_LANGUAGE: { type: 'string', default: 'en-US' },
  AZURE_SPEECH_RATE_PERCENT: { type: 'number', default: -12, min: -40, max: 30 },
  AZURE_SPEECH_PITCH_PERCENT: { type: 'number', default: -12, min: -30, max: 30 },
  AZURE_OPENAI_ENDPOINT: { type: 'url', required: true },
  AZURE_OPENAI_KEY: { type: 'secret', required: true },
  AZURE_OPENAI_DEPLOYMENT: { type: 'string', required: true },
  // Foundry project reasoning tiers. Fast answers use Grok; demanding
  // planning/architecture questions use GPT-5.6 Sol.
  DEEP_THINK_FAST_MODEL: { type: 'string', default: 'grok-4-1-fast-reasoning' },
  DEEP_THINK_COMPLEX_MODEL: { type: 'string', default: 'gpt-5.6-sol' },
  OPENCLAW_AGENT_TIMEOUT_MS: { type: 'integer', default: 300000, min: 30000, max: 900000 },
  DEEP_THINK_TIMEOUT_MS: { type: 'integer', default: 240000, min: 30000, max: 900000 },
  AGENT_LONG_TASK_NOTICE_MS: { type: 'integer', default: 270000, min: 10000, max: 870000 },
  AGENT_PERSISTENT_RETRY_MS: { type: 'integer', default: 300000, min: 60000, max: 3600000 },
  AGENT_PERSISTENT_RECOVERY_WINDOW_MS: { type: 'integer', default: 2592000000, min: 1800000, max: 2592000000 },
  AGENT_PERSISTENT_PROGRESS_MS: { type: 'integer', default: 180000, min: 60000, max: 3600000 },
  AGENT_PERSISTENT_RUNNER_SCAN_MS: { type: 'integer', default: 30000, min: 10000, max: 300000 },
  AGENT_PERSISTENT_STALE_RUNNING_MS: { type: 'integer', default: 600000, min: 300000, max: 3600000 },
  SELF_HEAL_ENABLED: { type: 'boolean', default: true },
  SELF_HEAL_MAX_ATTEMPTS: { type: 'integer', default: 2, min: 1, max: 3 },
  SELF_HEAL_TIMEOUT_MS: { type: 'integer', default: 180000, min: 30000, max: 900000 },
  SELF_HEAL_INTERPRETER_PATH: { type: 'string', default: '' }, // bo'sh = avtomatik topiladi (.venv-interpreter, keyin PATH)
  GMAIL_TASK_NOTIFICATIONS_ENABLED: { type: 'boolean', default: false },
  GMAIL_OWNER_RECIPIENT: { type: 'string' },
  GMAIL_TASK_PROGRESS_MS: { type: 'integer', default: 21600000, min: 60000, max: 604800000 },
  VOICE_AGENT_HANDOFF_MS: { type: 'integer', default: 60000, min: 30000, max: 300000 },
  DEEP_THINK_MAX_TOKENS: { type: 'integer', default: 1200, min: 64, max: 32768 },
  AZURE_TERRA_ENDPOINT: { type: 'url' },
  AZURE_TERRA_KEY: { type: 'secret' },
  AZURE_TERRA_DEPLOYMENT: { type: 'string', default: 'gpt-5.6-terra' },
  OPENCLAW_GATEWAY_TOKEN: { type: 'secret', required: true },
  AZURE_OPENAI_VISION_DEPLOYMENT: { type: 'string', default: 'gpt-4.1' },
  AZURE_VOICELIVE_ENDPOINT: { type: 'url' },
  AZURE_VOICELIVE_KEY: { type: 'secret' },
  AZURE_VOICELIVE_MODEL: { type: 'string', default: 'gpt-realtime' },
  AZURE_VOICELIVE_VOICE: { type: 'string', default: 'en-US-OnyxTurboMultilingualNeural' },
  AZURE_VOICELIVE_API_VERSION: { type: 'string', default: '2026-04-10' },
  AZURE_REALTIME_ENDPOINT: { type: 'websocket-url' },
  AZURE_REALTIME_KEY: { type: 'secret' },
  AZURE_REALTIME_DEPLOYMENT: { type: 'string', default: 'gpt-realtime-1.5' },
  AZURE_REALTIME_VOICE: { type: 'string', default: 'cedar' },
  AZURE_TRANSCRIBE_ENDPOINT: { type: 'url' },
  AZURE_TRANSCRIBE_KEY: { type: 'secret' },
  AZURE_TRANSCRIBE_DEPLOYMENT: { type: 'string', default: 'gpt-live-transcribe' },
  AZURE_EMBEDDING_ENDPOINT: { type: 'url' },
  AZURE_EMBEDDING_KEY: { type: 'secret' },
  AZURE_EMBEDDING_DEPLOYMENT: { type: 'string', default: 'text-embedding-3-large-2' },
  AZURE_EMBEDDING_API_DEPLOYMENT: { type: 'string', default: '' },
  AZURE_RERANK_ENDPOINT: { type: 'url' },
  AZURE_RERANK_KEY: { type: 'secret' },
  AZURE_RERANK_DEPLOYMENT: { type: 'string', default: 'Cohere-rerank-v4.0-pro' },
  JARVIS_VOICE_STYLE: { type: 'enum', default: 'cinematic-robot', values: ['cinematic-robot', 'default'] },
  // Empty lets the provider detect the spoken language. Deployments that need
  // a fixed locale can still set an explicit BCP-47 language in .env.
  REALTIME_TRANSCRIPTION_LANGUAGE: { type: 'string', default: '' },
  REALTIME_ENABLED: { type: 'boolean', default: true },
  REALTIME_IDLE_MS: { type: 'integer', default: 20000, min: 5000, max: 300000 },
  REALTIME_MAX_RESPONSE_TOKENS: { type: 'integer', default: 500, min: 64, max: 4096 }, // past: hisob juda uzun gapirardi; qisqalik ko'rsatmasini qattiqroq ushlab turish uchun pasaytirildi
  REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS: { type: 'integer', default: 256, min: 64, max: 1024 },
  // Low-latency conversational profile. Keep enough margin for natural
  // intra-sentence pauses while releasing a completed turn promptly.
  REALTIME_VAD_SILENCE_MS: { type: 'integer', default: 180, min: 120, max: 2000 },
  REALTIME_NORMAL_DUPLEX_HANGOVER_MS: { type: 'integer', default: 330, min: 270, max: 5000 },
  REALTIME_PLAYBACK_PREBUFFER_MS: { type: 'integer', default: 40, min: 0, max: 1000 },
  REALTIME_PLAYBACK_MAX_WAIT_MS: { type: 'integer', default: 80, min: 0, max: 2000 },
  REALTIME_BARGE_IN_CONFIRM_MS: { type: 'integer', default: 420, min: 100, max: 1000 },
  REALTIME_BARGE_IN_MAX_GAP_MS: { type: 'integer', default: 80, min: 0, max: 300 },
  REALTIME_WAKE_PREROLL_MS: { type: 'integer', default: 1800, min: 400, max: 5000 },
  REALTIME_INPUT_GAIN: { type: 'number', default: 3, min: 1, max: 8 },
  REALTIME_FAILURE_LIMIT: { type: 'integer', default: 3, min: 1, max: 20 },
  REALTIME_COOLDOWN_MS: { type: 'integer', default: 120000, min: 1000, max: 3600000 },
  ENERGY_MIN_STT: { type: 'number', default: 120, min: 1, max: 10000 },
  VOICE_ACTIVITY_THRESHOLD: { type: 'number', default: 150, min: 1, max: 10000 },
  MIC_FILTER_ENABLED: { type: 'boolean', default: true },
  MIC_HIGHPASS_HZ: { type: 'number', default: 80, min: 20, max: 500 },
  MIC_LOWPASS_HZ: { type: 'number', default: 7600, min: 3000, max: 7900 },
  MIC_MUTE_GRACE_MS: { type: 'integer', default: 650, min: 0, max: 10000 },
  DUPLEX_ECHO_THRESHOLD: { type: 'number', default: 0.72, min: 0.1, max: 0.99 },
  DUPLEX_BARGE_IN_RMS: { type: 'number', default: 900, min: 10, max: 10000 },
  DUPLEX_NOISE_FLOOR: { type: 'number', default: 80, min: 0, max: 5000 },
  DUPLEX_NOISE_MULTIPLIER: { type: 'number', default: 2.4, min: 1, max: 10 },
  DUPLEX_HANGOVER_MS: { type: 'integer', default: 900, min: 0, max: 5000 },
  DUPLEX_MAX_ECHO_LAG_MS: { type: 'integer', default: 180, min: 0, max: 1000 },
  HOTWORD_COOLDOWN_MS: { type: 'integer', default: 3000, min: 500, max: 60000 },
  COMMAND_DEDUP_MS: { type: 'integer', default: 5000, min: 500, max: 60000 },
  RESPONSE_DEDUP_MS: { type: 'integer', default: 15000, min: 1000, max: 120000 },
  CONVERSATION_FOLLOWUP_MS: { type: 'integer', default: 60000, min: 5000, max: 120000 },
  ACTION_CONFIRMATION_TTL_MS: { type: 'integer', default: 30000, min: 5000, max: 120000 },
  JARVIS_FULL_AUTONOMY: { type: 'boolean', default: false },
  TELEGRAM_OWNER_IDS: { type: 'string', default: '' },
  JARVIS_ALWAYS_LISTEN: { type: 'boolean', default: true },
  MISSION_DAILY_TOKEN_BUDGET: { type: 'integer', default: 3000000, min: 0 },
  DAILY_VOICE_MINUTES_ALERT: { type: 'integer', default: 240, min: 0 },
  MISSION_AUTONOMY: { type: 'string', default: 'routine' },
  JARVIS_NATIVE_AEC: { type: 'boolean', default: true },
  REALTIME_NATIVE_BARGE_IN_RMS: { type: 'integer', default: 450, min: 50, max: 8000 },
  TURN_JOURNAL_MAX_BYTES: { type: 'integer', default: 8388608, min: 65536, max: 1073741824 },
  TURN_JOURNAL_RETENTION_FILES: { type: 'integer', default: 5, min: 1, max: 30 },
  JARVIS_PRIVACY_MODE: { type: 'boolean', default: false },
  JARVIS_FOCUS_MODE: { type: 'boolean', default: false },
  JARVIS_MEETING_MODE: { type: 'boolean', default: false },
  OPENWAKEWORD_ENABLED: { type: 'boolean', default: true },
  OPENWAKEWORD_RESTART_BASE_MS: { type: 'integer', default: 2000, min: 1000, max: 60000 },
  OPENWAKEWORD_RESTART_MAX_MS: { type: 'integer', default: 30000, min: 1000, max: 300000 },
  OPENWAKEWORD_MODELS: { type: 'string', default: 'hey_jarvis' },
  OPENWAKEWORD_THRESHOLD: { type: 'number', default: 0.18, min: 0.01, max: 0.99 },
  // >1 intentionally disables the single-frame strong-score bypass while
  // retaining temporal confirmation for production custom models.
  OPENWAKEWORD_STRONG_THRESHOLD: { type: 'number', default: 0.55, min: 0.01, max: 2 },
  OPENWAKEWORD_CONFIRM_THRESHOLD: { type: 'number', default: 0.06, min: 0.01, max: 0.99 },
  OPENWAKEWORD_CONFIRM_WINDOW_FRAMES: { type: 'integer', default: 4, min: 2, max: 10 },
  OPENWAKEWORD_DIAGNOSTIC_FLOOR: { type: 'number', default: 0.03, min: 0.001, max: 0.99 },
  OPENWAKEWORD_INPUT_GAIN: { type: 'number', default: 3, min: 1, max: 6 },
  // Local whisper.cpp is opt-in and only supplements wake-word detection.
  // Azure Realtime remains the authoritative STT/VAD path during a conversation.
  WHISPER_WAKE_ENABLED: { type: 'boolean', default: false },
  WHISPER_WAKE_BINARY: { type: 'string' },
  WHISPER_WAKE_MODEL: { type: 'string' },
  WHISPER_WAKE_LANGUAGE: { type: 'string', default: 'en' },
  WHISPER_WAKE_WINDOW_MS: { type: 'integer', default: 3000, min: 1000, max: 10000 },
  WHISPER_WAKE_INTERVAL_MS: { type: 'integer', default: 1500, min: 500, max: 10000 },
  WHISPER_WAKE_COOLDOWN_MS: { type: 'integer', default: 5000, min: 1000, max: 60000 },
  WHISPER_WAKE_TIMEOUT_MS: { type: 'integer', default: 15000, min: 1000, max: 60000 },
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
  TURN_STALE_TIMEOUT_MS: { type: 'integer', default: 600000, min: 30000, max: 86400000 },
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
  if (rule.type === 'websocket-url') {
    const value = new URL(String(raw));
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(value.protocol)) throw new Error('faqat http/https/ws/wss URL');
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
  const voiceLivePartial = Boolean(values.AZURE_VOICELIVE_ENDPOINT) !== Boolean(values.AZURE_VOICELIVE_KEY);
  const realtimePartial = Boolean(values.AZURE_REALTIME_ENDPOINT) !== Boolean(values.AZURE_REALTIME_KEY);
  const terraPartial = Boolean(values.AZURE_TERRA_ENDPOINT) !== Boolean(values.AZURE_TERRA_KEY);
  if (voiceLivePartial) errors.push({ key: 'AZURE_VOICELIVE_ENDPOINT', code: 'conditional', message: 'Voice Live endpoint va key birga berilishi kerak' });
  if (realtimePartial) errors.push({ key: 'AZURE_REALTIME_ENDPOINT', code: 'conditional', message: 'Realtime endpoint va key birga berilishi kerak' });
  if (terraPartial) errors.push({ key: 'AZURE_TERRA_ENDPOINT', code: 'conditional', message: 'Terra endpoint va key birga berilishi kerak' });
  if (values.WHISPER_WAKE_ENABLED && (!values.WHISPER_WAKE_BINARY || !values.WHISPER_WAKE_MODEL)) {
    errors.push({ key: 'WHISPER_WAKE_BINARY', code: 'conditional', message: 'WHISPER_WAKE_ENABLED=true uchun binary va model path berilishi kerak' });
  }
  if (values.GMAIL_TASK_NOTIFICATIONS_ENABLED && !EMAIL.test(values.GMAIL_OWNER_RECIPIENT || '')) {
    errors.push({ key: 'GMAIL_OWNER_RECIPIENT', code: 'conditional', message: 'GMAIL_TASK_NOTIFICATIONS_ENABLED=true uchun owner email berilishi kerak' });
  }
  if (values.REALTIME_ENABLED && !values.AZURE_VOICELIVE_ENDPOINT && !values.AZURE_REALTIME_ENDPOINT) {
    warnings.push({ key: 'REALTIME_ENABLED', code: 'fallback', message: 'Voice provider sozlanmagan; Speech TTS fallback ishlatiladi' });
  }
  return { ok: errors.length === 0, values, errors, warnings };
}

function redactConfig(values, schema = CONFIG_SCHEMA) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, schema[key]?.type === 'secret' ? '<redacted>' : value]));
}

module.exports = { CONFIG_SCHEMA, parseEnv, readEnvFile, validateConfig, redactConfig };