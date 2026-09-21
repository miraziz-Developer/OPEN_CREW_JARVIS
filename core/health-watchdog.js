'use strict';

const { execFile } = require('child_process');

// O'zini-o'zi tiklash: har tekshiruv {name, ok, heal?} qaytaradi. Sog'lom bo'lmasa
// heal() chaqiriladi (cooldown bilan), ko'p urinishdan keyin BIR marta xabar beriladi.
class HealthWatchdog {
  constructor({ checks = [], notify = () => {}, cooldownMs = 120000, maxHeals = 3, now = Date.now, intervalMs = 30000 } = {}) {
    this.checks = checks; this.notify = notify; this.cooldownMs = cooldownMs;
    this.maxHeals = maxHeals; this.now = now; this.intervalMs = intervalMs;
    this.state = new Map(); this.timer = null;
  }
  async runOnce() {
    const report = [];
    for (const check of this.checks) {
      const st = this.state.get(check.name) || { heals: 0, lastHeal: -Infinity, notified: false };
      this.state.set(check.name, st);
      let ok = false;
      try { ok = Boolean(await check.probe()); } catch (_) {}
      if (ok) { st.heals = 0; st.notified = false; report.push({ name: check.name, ok: true }); continue; }
      let action = 'none';
      if (check.heal && st.heals < this.maxHeals && this.now() - st.lastHeal >= this.cooldownMs) {
        st.lastHeal = this.now(); st.heals++; action = 'healed';
        try { await check.heal(); } catch (_) { action = 'heal-failed'; }
      } else if (st.heals >= this.maxHeals && !st.notified) {
        st.notified = true; action = 'notified';
        try { this.notify(`⚠️ ${check.name} keeps failing after ${st.heals} restarts — needs you.`); } catch (_) {}
      }
      report.push({ name: check.name, ok: false, action });
    }
    return report;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.runOnce().catch(() => {}); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

const kickstart = label => () => new Promise(resolve =>
  execFile('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], () => resolve()));

module.exports = { HealthWatchdog, kickstart };
