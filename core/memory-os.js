'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LAYERS = new Set(['working', 'episodic', 'semantic', 'procedural', 'user_profile']);
const DEFAULT_TTL = { working: 24 * 3600e3, episodic: 365 * 24 * 3600e3 };
const SECRET_PATTERNS = [
  /\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/gi,
  /\b(?:bearer\s+)[a-z0-9._~+\/-]{16,}/gi,
  /\b(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g
];

function clean(value, max = 4000) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value))); }
function normalizeKey(value) { return clean(value, 300).toLocaleLowerCase(); }

function redactSensitive(value) {
  let text = String(value || '');
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, match => {
      redacted = true;
      const label = /password|passwd/i.test(match) ? 'PASSWORD' : 'SECRET';
      return `[REDACTED_${label}]`;
    });
  }
  return { text, redacted };
}

function tokenize(value) {
  return new Set(normalizeKey(value).split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length > 2));
}

function lexicalScore(query, record) {
  const wanted = tokenize(query);
  if (!wanted.size) return 0;
  const available = tokenize(`${record.title} ${record.content} ${(record.tags || []).join(' ')}`);
  let hits = 0;
  for (const token of wanted) if (available.has(token)) hits++;
  return hits / wanted.size;
}

class MemoryOS {
  constructor(options = {}) {
    this.file = options.file || null;
    this.now = options.now || Date.now;
    this.maxRecords = options.maxRecords || 5000;
    this.state = { version: 1, records: [], entities: {}, relations: [], migrations: {} };
    this._cleanStaleTemps();
    this._load();
  }

  // Qulagan jarayondan qolgan eskirgan vaqtinchalik fayllar (masalan .json.<pid>.<hex>.tmp) katta joy egallaydi.
  _cleanStaleTemps() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      const prefix = path.basename(this.file) + '.';
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
        const full = path.join(dir, name);
        if (Date.now() - fs.statSync(full).mtimeMs > 3600000) fs.rmSync(full, { force: true });
      }
    } catch (_) {}
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version === 1) this.state = { ...this.state, ...parsed };
    } catch (_) {}
  }

  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_) {}
  }

  _withLock(work) {
    if (!this.file) return work();
    const lock = `${this.file}.lock`;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 8000;
    while (true) {
      try { fs.mkdirSync(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch (_) {}
        if (Date.now() >= deadline) throw new Error('Memory OS lock timeout');
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    try { this._load(); return work(); }
    finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {} }
  }

  remember(input = {}) {
    return this._withLock(() => {
      const now = this.now();
      const layer = LAYERS.has(input.layer) ? input.layer : 'episodic';
      const titleRedaction = redactSensitive(clean(input.title, 300));
      const contentRedaction = redactSensitive(clean(input.content, 8000));
      if (!titleRedaction.text && !contentRedaction.text) throw new Error('Memory title yoki content kerak');
      const requestedId = clean(input.id, 300);
      const existingById = requestedId && this.state.records.find(record => record.id === requestedId);
      if (existingById) {
        existingById.layer = layer;
        existingById.title = titleRedaction.text;
        existingById.content = contentRedaction.text;
        existingById.tags = [...new Set((input.tags || existingById.tags || []).map(tag => clean(tag, 80)).filter(Boolean))];
        existingById.source = clean(input.source || existingById.source || 'jarvis', 120);
        existingById.confidence = clamp(input.confidence ?? existingById.confidence ?? 0.7);
        existingById.privacy = input.privacy || existingById.privacy || 'private';
        existingById.redacted = Boolean(existingById.redacted || titleRedaction.redacted || contentRedaction.redacted);
        existingById.updatedAt = now;
        existingById.status = 'active';
        this._persist();
        return { status: 'updated', record: existingById };
      }
      const fact = input.fact && input.fact.subject && input.fact.predicate
        ? { subject: clean(input.fact.subject, 200), predicate: clean(input.fact.predicate, 120), object: clean(input.fact.object, 1000) }
        : null;
      const duplicate = fact && this.state.records.find(record => record.status === 'active' && record.fact
        && normalizeKey(record.fact.subject) === normalizeKey(fact.subject)
        && normalizeKey(record.fact.predicate) === normalizeKey(fact.predicate)
        && normalizeKey(record.fact.object) === normalizeKey(fact.object));
      if (duplicate) {
        duplicate.confidence = clamp(Math.max(duplicate.confidence, Number(input.confidence) || 0.7) + 0.05);
        duplicate.updatedAt = now;
        duplicate.evidenceCount = (duplicate.evidenceCount || 1) + 1;
        this._persist();
        return { status: 'reinforced', record: duplicate };
      }
      const id = requestedId || crypto.randomUUID();
      const ttl = input.ttlMs === null ? null : (Number(input.ttlMs) || DEFAULT_TTL[layer] || null);
      const record = {
        id, layer, title: titleRedaction.text, content: contentRedaction.text,
        tags: [...new Set((input.tags || []).map(tag => clean(tag, 80)).filter(Boolean))],
        source: clean(input.source || 'jarvis', 120), confidence: clamp(input.confidence ?? 0.7),
        privacy: input.privacy || (titleRedaction.redacted || contentRedaction.redacted ? 'sensitive' : 'private'),
        redacted: titleRedaction.redacted || contentRedaction.redacted,
        createdAt: Number(input.createdAt) || now, updatedAt: now,
        expiresAt: ttl ? now + ttl : null, status: 'active', evidenceCount: 1, fact
      };
      if (fact) {
        for (const old of this.state.records) {
          const contradicts = old.status === 'active' && old.fact
            && normalizeKey(old.fact.subject) === normalizeKey(fact.subject)
            && normalizeKey(old.fact.predicate) === normalizeKey(fact.predicate)
            && normalizeKey(old.fact.object) !== normalizeKey(fact.object);
          if (contradicts) { old.status = 'superseded'; old.supersededBy = id; old.updatedAt = now; }
        }
      }
      this.state.records.push(record);
      this._indexEntities(record, input.entities || []);
      this.state.records = this.state.records.slice(-this.maxRecords);
      this._persist();
      return { status: 'ok', record };
    });
  }

  _indexEntities(record, entities) {
    const normalized = entities.map(entity => typeof entity === 'string' ? { name: entity, type: 'unknown' } : entity);
    if (record.fact) normalized.push({ name: record.fact.subject, type: 'subject' });
    for (const entity of normalized) {
      const name = clean(entity.name, 200);
      if (!name) continue;
      const id = normalizeKey(`${entity.type || 'unknown'}:${name}`);
      const current = this.state.entities[id] || { id, name, type: clean(entity.type || 'unknown', 80), memoryIds: [] };
      if (!current.memoryIds.includes(record.id)) current.memoryIds.push(record.id);
      current.updatedAt = record.updatedAt;
      this.state.entities[id] = current;
    }
    const ids = normalized.map(entity => normalizeKey(`${entity.type || 'unknown'}:${entity.name}`)).filter(Boolean);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}|related_to|${ids[j]}`;
      if (!this.state.relations.some(relation => relation.key === key)) this.state.relations.push({ key, from: ids[i], type: 'related_to', to: ids[j], memoryId: record.id });
    }
  }

  retrieve(query, options = {}) {
    this._load();
    const now = this.now();
    const layers = options.layers ? new Set(options.layers) : null;
    return this.state.records
      .filter(record => record.status === 'active' && (!record.expiresAt || record.expiresAt > now) && (!layers || layers.has(record.layer)))
      .map(record => {
        const lexical = lexicalScore(query, record);
        const ageDays = Math.max(0, now - record.updatedAt) / 86400000;
        const recency = Math.exp(-ageDays / (record.layer === 'working' ? 1 : 90));
        return { ...record, score: lexical * 0.65 + record.confidence * 0.25 + recency * 0.1 };
      })
      .filter(record => !query || lexicalScore(query, record) > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, options.limit || 5));
  }

  purgeExpired() {
    return this._withLock(() => {
      const now = this.now();
      let purged = 0;
      for (const record of this.state.records) if (record.status === 'active' && record.expiresAt && record.expiresAt <= now) { record.status = 'expired'; record.updatedAt = now; purged++; }
      this._persist();
      return { status: 'ok', purged };
    });
  }

  migrateLegacy({ memoryDir, profileFile } = {}) {
    return this._withLock(() => {
      if (this.state.migrations.legacyMarkdownV1) return { status: 'ok', skipped: true };
      const imports = [];
      if (memoryDir && fs.existsSync(memoryDir)) {
        for (const file of fs.readdirSync(memoryDir).filter(name => name.endsWith('.md'))) {
          const raw = fs.readFileSync(path.join(memoryDir, file), 'utf8');
          for (const block of raw.split(/^---$/m).map(value => value.trim())) {
            const match = block.match(/^##\s+([^—\n]+)\s+—\s+(.+)$/m);
            if (match) imports.push({ id: `legacy:${file}:${crypto.createHash('sha1').update(block).digest('hex')}`, layer: 'episodic', title: match[2], content: block, source: 'legacy-markdown', createdAt: Date.parse(file.slice(0, 10)) || this.now() });
          }
        }
      }
      if (profileFile && fs.existsSync(profileFile)) imports.push({ id: 'legacy:user-profile', layer: 'user_profile', title: 'Legacy user profile', content: fs.readFileSync(profileFile, 'utf8'), source: 'legacy-profile', confidence: 0.75 });
      const existing = new Set(this.state.records.map(record => record.id));
      for (const item of imports) if (!existing.has(item.id)) {
        const redacted = redactSensitive(clean(item.content, 8000));
        this.state.records.push({ ...item, content: redacted.text, tags: ['legacy'], confidence: item.confidence || 0.6, privacy: redacted.redacted ? 'sensitive' : 'private', redacted: redacted.redacted, createdAt: item.createdAt || this.now(), updatedAt: this.now(), expiresAt: null, status: 'active', evidenceCount: 1, fact: null });
      }
      this.state.migrations.legacyMarkdownV1 = { at: this.now(), imported: imports.length };
      this.state.records = this.state.records.slice(-this.maxRecords);
      this._persist();
      return { status: 'ok', imported: imports.length };
    });
  }

  snapshot() { this._load(); return JSON.parse(JSON.stringify(this.state)); }
}

module.exports = { MemoryOS, LAYERS, redactSensitive, lexicalScore };