'use strict';
// Testlar hech qachon haqiqiy .env, kalit yoki Postgres'ga tayanmasligi kerak.
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
// Testlar hech qachon haqiqiy Telegram'ga yubormasligi kerak (avval har `npm test` chatga 'Bajarildi: system:empty_trash' yuborardi).
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_OWNER_IDS']) if (process.env[key] === undefined) process.env[key] = '';
