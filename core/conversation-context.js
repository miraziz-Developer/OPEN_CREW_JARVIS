'use strict';

const REFERENTIAL = /\b(?:it|that|this|them|there|same|previous|last|o['‘’]?sha|shu|uni|unga|undan|ularni|avvalgi|oldingi)\b/i;
const ENTITY_PATTERNS = Object.freeze({
  project: /\b(?:project|loyiha)\s+(?:named\s+|called\s+)?["“]?([\p{L}\p{N}_.-][\p{L}\p{N} _.-]{1,80})/iu,
  person: /\b(?:with|to|from|call|email|message|person|odam|bilan|uchun)\s+([A-ZÀ-Ž][\p{L}'-]{1,40}(?:\s+[A-ZÀ-Ž][\p{L}'-]{1,40})?)/u,
  document: /\b([\p{L}\p{N}_-]{2,80}\.(?:md|txt|pdf|docx?|xlsx?|pptx?|js|ts|json|csv))\b/iu,
  app: /\b(?:Safari|Chrome|Telegram|Spotify|VS\s*Code|Cursor|Notion|Obsidian|Terminal|Finder|Calendar|Mail|Notes|Reminders|Music)\b/i,
  task: /\b(?:task|vazifa|job|ish)\s+["“]?([^,.!?]{2,100})/iu
});

function clean(value, max = 120) {
  return String(value || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractEntities(text, world = {}) {
  const source = String(text || '');
  const entities = {};
  for (const [type, pattern] of Object.entries(ENTITY_PATTERNS)) {
    const match = source.match(pattern);
    if (match) entities[type] = clean(match[1] || match[0]);
  }
  if (!entities.app && world.app) entities.app = clean(world.app);
  if (!entities.document && world.window?.title) entities.document = clean(world.window.title);
  if (world.browser?.url) entities.url = clean(world.browser.url, 500);
  return entities;
}

class ConversationContext {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    // A user commonly pauses after a spoken answer before asking a follow-up.
    // Keep entity/reference context aligned with the live-session follow-up
    // window rather than discarding it after the old 20-second idle timeout.
    this.windowMs = options.windowMs || 60000;
    this.maxTurns = options.maxTurns || 8;
    this.reset();
  }

  reset() {
    this.state = { lastActivityAt: 0, turns: [], entities: {}, lastReferencedObject: null };
  }

  isActive(at = this.now()) {
    return Boolean(this.state.lastActivityAt && at - this.state.lastActivityAt <= this.windowMs);
  }

  observe(role, text, options = {}) {
    const at = Number(options.at) || this.now();
    if (this.state.lastActivityAt && at - this.state.lastActivityAt > this.windowMs) this.reset();
    const cleanText = clean(text, 500);
    if (!cleanText) return this.snapshot();
    const found = extractEntities(cleanText, options.world);
    this.state.entities = { ...this.state.entities, ...found };
    const values = Object.values(found);
    if (values.length) this.state.lastReferencedObject = values.at(-1);
    this.state.turns.push({ role: clean(role, 20) || 'user', text: cleanText, at });
    this.state.turns = this.state.turns.slice(-this.maxTurns);
    this.state.lastActivityAt = at;
    return this.snapshot();
  }

  resolve(text) {
    const referential = REFERENTIAL.test(String(text || ''));
    const active = this.isActive();
    const candidates = Object.entries(this.state.entities).filter(([, value]) => value);
    return {
      active,
      referential,
      resolved: referential && active && candidates.length > 0,
      ambiguous: referential && (!active || candidates.length === 0),
      entities: Object.fromEntries(candidates),
      lastReferencedObject: this.state.lastReferencedObject
    };
  }

  grounding(text) {
    const result = this.resolve(text);
    if (!result.resolved) return '';
    const facts = Object.entries(result.entities).map(([key, value]) => `${key}: ${value}`).join('; ');
    return `ACTIVE CONVERSATION CONTEXT (${this.windowMs / 1000}s window): ${facts}; last referenced object: ${result.lastReferencedObject || 'unknown'}.`;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ ...this.state, active: this.isActive(), windowMs: this.windowMs }));
  }
}

module.exports = { ConversationContext, extractEntities };