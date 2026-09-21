'use strict';
// Testlar hech qachon haqiqiy .env, kalit yoki Postgres'ga tayanmasligi kerak.
for (const [key, value] of Object.entries({
  OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
  AZURE_OPENAI_KEY: 'test-azure-key',
  JARVIS_CONFIRM_MODE: 'strict' // kod yo'llari to'liq sinaladi; standart (off) alohida testda tekshiriladi
})) if (!process.env[key]) process.env[key] = value;
