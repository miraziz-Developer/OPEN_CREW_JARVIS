'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('./paths');

/**
 * Daily usage meter (LLM tokens, voice seconds). Several processes (daemon, runner) write to it, so each
 * day is an append-only JSONL: small lines are appended atomically and totals are computed on read.
 */
function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class UsageMeter {
  constructor(options = {}) {
    this.dir = options.dir || path.join(PROJECT_DIR, '.run', 'usage');
    this.now = options.now || Date.now;
  }

  _file(day) { return path.join(this.dir, `${day}.jsonl`); }

  add(kind, amount) {
    const value = Number(amount);
    if (!kind || !Number.isFinite(value) || value <= 0) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this._file(dayKey(this.now())), JSON.stringify({ at: this.now(), kind, amount: value }) + '\n', { mode: 0o600 });
    } catch (_) {}
  }

  totals(day = dayKey(this.now())) {
    const totals = {};
    let text = '';
    try { text = fs.readFileSync(this._file(day), 'utf8'); } catch (_) { return totals; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const row = JSON.parse(line); totals[row.kind] = (totals[row.kind] || 0) + row.amount; } catch (_) {}
    }
    return totals;
  }

  // Warn once a day: true only on the first call.
  once(key) {
    const marker = path.join(this.dir, `${dayKey(this.now())}.${String(key).replace(/[^\w.-]/g, '_')}.flag`);
    if (fs.existsSync(marker)) return false;
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(marker, '1', { mode: 0o600 }); } catch (_) {}
    return true;
  }
}

let shared = null;
function sharedMeter() { return shared || (shared = new UsageMeter()); }

module.exports = { UsageMeter, sharedMeter, dayKey };
