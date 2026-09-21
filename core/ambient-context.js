'use strict';

const fs = require('fs');
const path = require('path');

// Ekran/ilova kontekstini kuzatadi: hozirgi ilova + oxirgi o'zgarishlar.
// Ovozli sessiya boshida "Sen nima ko'ryapsan" degan bilim beradi.
class AmbientContext {
  constructor({ file, collect, intervalMs = 5000, historySize = 8, now = Date.now } = {}) {
    this.file = file; this.collect = collect; this.intervalMs = intervalMs;
    this.historySize = historySize; this.now = now;
    this.current = null; this.history = []; this.timer = null; this.failures = 0;
  }
  tick() {
    let ctx;
    try { ctx = this.collect(); this.failures = 0; } catch (_) { this.failures++; return null; }
    const key = `${ctx.app}|${ctx.window?.title || ''}|${ctx.browser?.url || ''}`;
    if (!this.current || this.current.key !== key) {
      this.current = { key, app: ctx.app, title: String(ctx.window?.title || '').slice(0, 120), url: String(ctx.browser?.url || '').slice(0, 160), since: this.now() };
      this.history.push(this.current);
      if (this.history.length > this.historySize) this.history.shift();
      this._persist();
    }
    return this.current;
  }
  _persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ current: this.current, history: this.history }), { mode: 0o600 });
    } catch (_) {}
  }
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => { if (this.failures < 5 || this.now() % 6 === 0) this.tick(); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

// Sessiya ko'rsatmasi uchun blok (faylni o'qiydi — ovoz jarayoni va daemon alohida bo'lishi mumkin).
function ambientBlock(file, now = Date.now()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.current || now - data.current.since > 6 * 3600000) return '';
    const cur = data.current;
    const recent = (data.history || []).slice(-4, -1).map(h => h.app).filter(Boolean);
    const where = [cur.app, cur.title && `"${cur.title}"`, cur.url].filter(Boolean).join(' — ');
    return `\n\nWHAT THE USER IS DOING (ambient; use silently when they say "this", "here", "that page"; never read it out unprompted): ${where}.` +
      (recent.length ? ` Before that: ${recent.join(' → ')}.` : '') + '\n';
  } catch (_) { return ''; }
}

module.exports = { AmbientContext, ambientBlock };
