'use strict';
// Testlar hech qachon haqiqiy .env, kalit yoki Postgres'ga tayanmasligi kerak.
for (const [key, value] of Object.entries({
  OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
  AZURE_OPENAI_KEY: 'test-azure-key',
  JARVIS_CONFIRM_MODE: 'strict' // kod yo'llari to'liq sinaladi; standart (off) alohida testda tekshiriladi
})) if (!process.env[key]) process.env[key] = value;
// Testlar hech qachon haqiqiy Telegram'ga yubormasligi kerak (avval har `npm test` chatga 'Bajarildi: system:empty_trash' yuborardi).
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_OWNER_IDS']) if (process.env[key] === undefined) process.env[key] = '';
