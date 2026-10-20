'use strict';
// Tests must never rely on a real .env, keys or Postgres.
for (const [key, value] of Object.entries({
  JARVIS_TEST: '1',
  OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
  AZURE_OPENAI_KEY: 'test-azure-key',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini',
  AGENT_FAST_MODEL: 'gpt-6-astra',
  AGENT_STRONG_MODEL: 'gpt-6-sol',
  AGENT_STRONG_FALLBACK_MODELS: 'gpt-6-astra,gpt-5.6-sol,gpt-5-mini',
  DEEP_THINK_FAST_MODEL: 'gpt-6-astra',
  DEEP_THINK_COMPLEX_MODEL: 'gpt-6-sol',
  JARVIS_CONFIRM_MODE: 'strict' // kod yo'llari to'liq sinaladi; standart (off) alohida testda tekshiriladi
})) process.env[key] = value;
// Tests must never send to real Telegram (every `npm test` used to post 'Bajarildi: system:empty_trash' to the chat).
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_OWNER_IDS']) if (process.env[key] === undefined) process.env[key] = '';
