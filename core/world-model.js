'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const normalized = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(bounds[key]);
    if (Number.isFinite(value)) normalized[key] = value;
  }
  return Object.keys(normalized).length === 4 ? normalized : null;
}

function normalizeSnapshot(snapshot = {}, now = Date.now()) {
  const browser = snapshot.browser && typeof snapshot.browser === 'object'
    ? {
        name: cleanText(snapshot.browser.name, 80),
        url: cleanText(snapshot.browser.url, 1000),
        title: cleanText(snapshot.browser.title, 300)
      }
    : null;
  const focus = snapshot.focus && typeof snapshot.focus === 'object'
    ? {
        role: cleanText(snapshot.focus.role, 80),
        title: cleanText(snapshot.focus.title, 300),
        value: cleanText(snapshot.focus.value, 500),
        description: cleanText(snapshot.focus.description, 300)
      }
    : null;
  return {
    capturedAt: Number(snapshot.capturedAt) || now,
    source: cleanText(snapshot.source || 'macos-context', 80),
    app: cleanText(snapshot.app, 120),
    bundleId: cleanText(snapshot.bundleId, 200),
    pid: Number(snapshot.pid) || null,
    window: {
      title: cleanText(snapshot.window?.title, 500),
      bounds: normalizeBounds(snapshot.window?.bounds)
    },
    browser,
    focus,
    screen: snapshot.screen && typeof snapshot.screen === 'object'
      ? { summary: cleanText(snapshot.screen.summary, 1000), imagePath: cleanText(snapshot.screen.imagePath, 1000) }
      : null
  };
}

function semanticView(snapshot) {
  if (!snapshot) return null;
  return {
    app: snapshot.app || '', bundleId: snapshot.bundleId || '',
    windowTitle: snapshot.window?.title || '', browserUrl: snapshot.browser?.url || '',
    browserTitle: snapshot.browser?.title || '', focusRole: snapshot.focus?.role || '',
    focusTitle: snapshot.focus?.title || '', focusValue: snapshot.focus?.value || ''
  };
}

function semanticHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(semanticView(snapshot))).digest('hex').slice(0, 20);
}

function diffSnapshots(before, after) {
  const left = semanticView(before) || {};
  const right = semanticView(after) || {};
  const changed = {};
  for (const key of Object.keys(right)) {
    if ((left[key] || '') !== (right[key] || '')) changed[key] = { before: left[key] || '', after: right[key] || '' };
  }
  return {
    changed: Object.keys(changed).length > 0,
    contextChanged: ['app', 'bundleId', 'windowTitle', 'browserUrl'].some(key => changed[key]),
    fields: changed
  };
}

function includesExpected(actual, expected) {
  if (expected === undefined || expected === null || expected === '') return true;
  return cleanText(actual, 2000).toLocaleLowerCase().includes(cleanText(expected, 2000).toLocaleLowerCase());
}

function verifyExpectation(before, after, expected = {}) {
  const checks = [];
  const add = (name, ok, actual, wanted) => checks.push({ name, ok: Boolean(ok), actual: actual ?? null, expected: wanted ?? null });
  if (expected.app) add('app', includesExpected(after?.app, expected.app), after?.app, expected.app);
  if (expected.windowTitle) add('windowTitle', includesExpected(after?.window?.title, expected.windowTitle), after?.window?.title, expected.windowTitle);
  if (expected.url) add('url', includesExpected(after?.browser?.url, expected.url), after?.browser?.url, expected.url);
  if (expected.focusRole) add('focusRole', includesExpected(after?.focus?.role, expected.focusRole), after?.focus?.role, expected.focusRole);
  if (expected.focusValue) add('focusValue', includesExpected(after?.focus?.value, expected.focusValue), after?.focus?.value, expected.focusValue);
  if (expected.changed === true) add('changed', diffSnapshots(before, after).changed, semanticHash(after), 'different semantic state');
  const ok = checks.length > 0 && checks.every(check => check.ok);
  return { ok, checks, diff: diffSnapshots(before, after), beforeHash: before ? semanticHash(before) : null, afterHash: after ? semanticHash(after) : null };
}

class WorldModel {
  constructor(options = {}) {
    this.file = options.file || null;
    this.maxEvents = options.maxEvents || 250;
    this.now = options.now || Date.now;
    this.state = { version: 1, current: null, previous: null, events: [] };
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === 1) this.state = { ...this.state, ...parsed, events: Array.isArray(parsed.events) ? parsed.events : [] };
    } catch (_) {}
  }

  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _withLock(work) {
    if (!this.file) return work();
    const lock = `${this.file}.lock`;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
        } catch (_) {}
        if (Date.now() >= deadline) throw new Error('World model lock timeout');
        Atomics.wait(sleeper, 0, 0, 10);
      }
    }
    try { return work(); }
    finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {} }
  }

  observe(snapshot, metadata = {}) {
    // Screen monitor va desktop-control alohida processlarda ishlaydi.
    // Har mutatsiyadan oldin diskdagi eng yangi eventlarni qayta yuklash
    // stale process boshqa process yozgan tarixni bosib yubormasligi uchun.
    return this._withLock(() => {
      this._load();
      const next = normalizeSnapshot(snapshot, this.now());
      const previous = this.state.current;
      const diff = diffSnapshots(previous, next);
      this.state.previous = previous;
      this.state.current = next;
      if (!previous || diff.changed || metadata.forceEvent) {
        this.state.events.push({ id: semanticHash(next) + '-' + next.capturedAt, type: metadata.type || 'context.observed', at: next.capturedAt, diff, snapshot: next });
        this.state.events = this.state.events.slice(-this.maxEvents);
      }
      this._persist();
      return { snapshot: next, diff, hash: semanticHash(next) };
    });
  }

  current() { this._load(); return this.state.current; }
  history(limit = 20) { this._load(); return this.state.events.slice(-Math.max(1, limit)); }

  verify(before, after, expected) {
    return this._withLock(() => {
      this._load();
      const result = verifyExpectation(before, after, expected);
      this.state.events.push({ id: 'verify-' + this.now(), type: 'action.verified', at: this.now(), verification: result });
      this.state.events = this.state.events.slice(-this.maxEvents);
      this._persist();
      return result;
    });
  }
}

module.exports = { WorldModel, normalizeSnapshot, semanticHash, diffSnapshots, verifyExpectation };