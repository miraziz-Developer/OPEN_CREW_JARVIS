'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Hech qachon doimiy ruxsat bilan qoplanmaydi: pul, butunlay o'chirish, parol/kalit, tizim va ruxsat o'zgarishi.
const NEVER_STANDING = /\b(?:purchase|buy|pay(?:ment)?|transfer|wire|checkout|bank|card|invoice|delet|remov|erase|wipe|format|reset|sudo|password|passcode|secret|token|credential|api\s*key|permission|shutdown|restart|trade|crypto)/i;

const SCOPES = Object.freeze({
  'job-applications': /\b(?:apply(?:ing)?\s+(?:to|for|on)|easy\s+apply|submit(?:ting)?\s+(?:an?\s+|the\s+|your\s+)?(?:job\s+)?(?:application|form|resume|cv)s?)\b/i,
  'recruiter-messages': /\b(?:inmail|connection\s+requests?|(?:message|contact|email|write\s+to|dm)\s+(?:the\s+)?(?:hr|recruiters?|hiring\s+managers?))\b/i,
  'external-messages': /\b(?:send|email|message|post|publish|share|reply)\b/i
});

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dayOf(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Doimiy ruxsatlar: "shu turdagi tashqi amallarga kuniga N tagacha, D kun davomida so'rama". Muddatli, kunlik limitli,
 * bekor qilinadigan; xavfli toifalar (NEVER_STANDING) hech qachon qoplanmaydi.
 */
class StandingApprovals {
  constructor(options = {}) {
    this.file = options.file;
    this.now = options.now || Date.now;
  }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return { rules: [] }; }
  }

  list() {
    const at = this.now();
    return this._read().rules.filter(rule => rule.expiresAt > at && !rule.revoked);
  }

  grant({ scopes, perDay = 10, days = 7, note = '' } = {}) {
    const valid = (Array.isArray(scopes) ? scopes : [scopes]).filter(scope => Object.hasOwn(SCOPES, scope));
    if (!valid.length) throw new Error(`Noma'lum ruxsat turi. Mumkin: ${Object.keys(SCOPES).join(', ')}`);
    const state = this._read();
    const rule = {
      id: crypto.randomBytes(3).toString('hex'), scopes: valid,
      perDay: Math.max(1, Math.min(200, Math.floor(Number(perDay)) || 10)),
      expiresAt: this.now() + Math.max(1, Math.min(60, Number(days) || 7)) * 86400000,
      note: String(note).slice(0, 200), createdAt: this.now(), usage: { day: dayOf(this.now()), count: 0 }, revoked: false
    };
    state.rules.push(rule);
    atomicWrite(this.file, state);
    return rule;
  }

  revoke(idOrAll) {
    const state = this._read();
    let count = 0;
    for (const rule of state.rules) if (!rule.revoked && (idOrAll === 'all' || rule.id === idOrAll)) { rule.revoked = true; count += 1; }
    atomicWrite(this.file, state);
    return count;
  }

  // Aniq turlar ("job-applications", "recruiter-messages") ustun; umumiy "external-messages" faqat aniq tur topilmasa.
  scopesFor(text, assessment = {}) {
    const specific = ['job-applications', 'recruiter-messages'].filter(scope => SCOPES[scope].test(text));
    if (specific.length) return specific;
    return assessment.category === 'external-communication' && SCOPES['external-messages'].test(text) ? ['external-messages'] : [];
  }

  // Mos qoida bo'lsa va bugungi limit tugamagan bo'lsa, bitta ishlatishni hisoblab qoidani qaytaradi.
  consume(text, assessment = {}) {
    if (NEVER_STANDING.test(String(text))) return null;
    if (['payment', 'irreversible-delete', 'credential-or-permission-change', 'system-impact'].includes(assessment.category)) return null;
    const scopes = this.scopesFor(text, assessment);
    if (!scopes.length) return null;
    const state = this._read();
    const at = this.now();
    const today = dayOf(at);
    const rule = state.rules.find(r => !r.revoked && r.expiresAt > at && scopes.every(scope => r.scopes.includes(scope))
      && (r.usage.day !== today || r.usage.count < r.perDay));
    if (!rule) return null;
    if (rule.usage.day !== today) rule.usage = { day: today, count: 0 };
    rule.usage.count += 1;
    atomicWrite(this.file, state);
    return rule;
  }
}

module.exports = { StandingApprovals, SCOPES, NEVER_STANDING };
