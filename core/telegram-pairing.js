'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Telegram egasini xavfsiz ulash: TELEGRAM_CHAT_ID yo'q bo'lsa bot bir martalik 6 xonali kod hosil qiladi
 * (faqat mahalliy faylga yoziladi). Egasi Telegramdan shaxsiy chatda `/pair KOD` yozadi. Kod muddatli, noto'g'ri
 * urinishlar cheklangan, guruh/bot xabarlari hisobga olinmaydi.
 */
function createPairing({ file, envFile, now = Date.now, ttlMs = 15 * 60 * 1000, maxAttempts = 5, lockMs = 10 * 60 * 1000 } = {}) {
  function read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  }

  function ensureCode() {
    const current = read();
    if (current && current.expiresAt > now() && current.code) return current;
    const state = { code: String(crypto.randomInt(100000, 1000000)), expiresAt: now() + ttlMs, attempts: 0, lockedUntil: current?.lockedUntil || 0 };
    write(state);
    return state;
  }

  function saveOwner(ownerId) {
    let env = '';
    try { env = fs.readFileSync(envFile, 'utf8'); } catch (_) {}
    const line = `TELEGRAM_CHAT_ID=${ownerId}`;
    env = /^TELEGRAM_CHAT_ID=.*$/m.test(env) ? env.replace(/^TELEGRAM_CHAT_ID=.*$/m, line) : env.replace(/\n?$/, '\n') + line + '\n';
    fs.writeFileSync(envFile, env, { mode: 0o600 });
  }

  function attempt(message) {
    const text = String(message?.text || '').trim();
    const match = /^\/(?:pair|start)(?:@\w+)?\s+(\d{6})$/i.exec(text);
    if (!match || message?.chat?.type !== 'private' || message?.from?.is_bot || !Number.isSafeInteger(message?.from?.id) || message.from.id <= 0) {
      return { ok: false, reason: 'ignored' };
    }
    const state = ensureCode();
    if (state.lockedUntil > now()) return { ok: false, reason: 'locked' };
    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(String(state.code));
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) && String(message.chat.id) === String(message.from.id)) {
      saveOwner(message.from.id);
      try { fs.rmSync(file, { force: true }); } catch (_) {}
      return { ok: true, ownerId: String(message.from.id) };
    }
    state.attempts += 1;
    if (state.attempts >= maxAttempts) { state.lockedUntil = now() + lockMs; state.attempts = 0; state.code = String(crypto.randomInt(100000, 1000000)); state.expiresAt = now() + ttlMs; }
    write(state);
    return { ok: false, reason: 'bad-code' };
  }

  return { ensureCode, attempt };
}

module.exports = { createPairing };
