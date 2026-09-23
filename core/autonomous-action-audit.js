'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { PROJECT_DIR } = require('./paths');

const SECRET_VALUE = /(?:password|passcode|secret|token|credential|authorization)\s*[:=]\s*\S+/gi;

function clean(value, max = 500) {
  return String(value || '').replace(SECRET_VALUE, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, max);
}

function envValue(key, projectDir = PROJECT_DIR) {
  // Jarayon muhiti .env dan ustun (testlar Telegram'ni bo'sh qiymat bilan o'chiradi — haqiqiy chatga xabar ketmasin).
  if (process.env[key] !== undefined) return String(process.env[key]).trim();
  try {
    const contents = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    const match = contents.match(new RegExp('^' + key + '\\s*=\\s*(.*)$', 'm'));
    return match ? match[1].trim() : '';
  } catch (_) { return ''; }
}

function sendTelegramNotification(text, options = {}) {
  const token = options.token || envValue('TELEGRAM_BOT_TOKEN', options.projectDir);
  const chatId = options.chatId || envValue('TELEGRAM_CHAT_ID', options.projectDir);
  if (!token || !chatId) return Promise.resolve(false);
  const payload = JSON.stringify({ chat_id: chatId, text: clean(text, 1000) });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode >= 200 && response.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(payload); req.end();
  });
}

async function recordHighRiskCompletion(action, context = {}, options = {}) {
  if (!action?.alwaysConfirm) return null;
  const file = options.file || path.join(options.projectDir || PROJECT_DIR, '.run', 'autonomous-actions.log');
  const description = clean(action.description || action.id || action.category);
  const event = {
    timestamp: new Date().toISOString(), event: 'high-risk-action-completed', category: action.category,
    action: { kind: clean(action.kind, 80), id: clean(action.id, 160), description },
    context: { source: clean(context.source || 'unknown', 80), taskId: clean(context.taskId, 160), requestId: clean(context.requestId, 160) },
    outcome: 'success'
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  } catch (_) {}
  const notify = options.notifyTelegram || sendTelegramNotification;
  try { await notify('✅ Bajarildi: ' + description, options); } catch (_) {}
  return event;
}

module.exports = { clean, envValue, sendTelegramNotification, recordHighRiskCompletion };