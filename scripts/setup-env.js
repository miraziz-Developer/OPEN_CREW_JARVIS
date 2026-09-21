#!/usr/bin/env node
'use strict';

// .env yaratadi (.env.example dan) va faqat yetishmayotgan asosiy sirlarni so'raydi.
// Interaktiv bo'lmasa — shunchaki fayl yaratadi va nima to'ldirish kerakligini aytadi.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const REQUIRED = [
  ['AZURE_VOICELIVE_ENDPOINT', 'Azure Voice Live endpoint (https://…services.ai.azure.com)', false],
  ['AZURE_VOICELIVE_KEY', 'Azure Voice Live key', true],
  ['AZURE_OPENAI_ENDPOINT', 'Azure OpenAI endpoint', false],
  ['AZURE_OPENAI_KEY', 'Azure OpenAI key', true],
  ['AZURE_SPEECH_KEY', 'Azure Speech key', true],
  ['AZURE_SPEECH_REGION', 'Azure Speech region (masalan swedencentral)', false],
  ['TELEGRAM_BOT_TOKEN', 'Telegram bot token (@BotFather) — ixtiyoriy, Enter = o‘tkazish', true],
  ['TELEGRAM_OWNER_IDS', 'Telegram egalari ID lari, vergul bilan — ixtiyoriy', false]
];

function parse(text) {
  const map = new Map();
  for (const line of text.split('\n')) { const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) map.set(m[1], m[2]); }
  return map;
}
function setKey(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => `${key}=${value}`) : text.replace(/\n*$/, '\n') + `${key}=${value}\n`;
}
function ask(rl, prompt, hidden) {
  return new Promise(resolve => {
    if (hidden) { rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); }; }
    rl.question(prompt, answer => { if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

async function main() {
  if (!fs.existsSync(ENV)) { fs.copyFileSync(path.join(ROOT, '.env.example'), ENV); console.log('✅ .env yaratildi'); }
  fs.chmodSync(ENV, 0o600);
  let text = fs.readFileSync(ENV, 'utf8');
  const current = parse(text);
  const missing = REQUIRED.filter(([k]) => !current.get(k));
  if (!missing.length) { console.log('✅ .env to‘liq'); return; }
  if (!process.stdin.isTTY) {
    console.log('⚠️  .env da to‘ldirilmagan: ' + missing.map(m => m[0]).join(', ') + '\n   nano .env  — keyin: bash install.sh');
    process.exitCode = 3; return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  for (const [key, label, hidden] of missing) {
    const value = await ask(rl, `${label}: `, hidden);
    if (value) {
      text = setKey(text, key, value);
      if (key === 'AZURE_VOICELIVE_KEY') text = setKey(text, 'AZURE_VOICELIVE_API_KEY', value);
      if (key === 'TELEGRAM_OWNER_IDS' && !current.get('TELEGRAM_CHAT_ID')) text = setKey(text, 'TELEGRAM_CHAT_ID', value.split(/[,\s;]+/)[0]);
    }
  }
  rl.close();
  fs.writeFileSync(ENV, text, { mode: 0o600 });
  const left = REQUIRED.filter(([k]) => !parse(text).get(k) && !/TELEGRAM/.test(k));
  console.log(left.length ? '⚠️  Hali bo‘sh: ' + left.map(m => m[0]).join(', ') : '✅ .env tayyor');
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { parse, setKey };
