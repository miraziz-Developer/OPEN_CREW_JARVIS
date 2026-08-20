'use strict';

const { EventEmitter } = require('events');

function timeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function validateShape(value, schema = {}) {
  if (!schema || typeof schema !== 'object') return;
  for (const key of schema.required || []) {
    if (value?.[key] === undefined || value?.[key] === null || value?.[key] === '') throw new Error(`input.${key} required`);
  }
  for (const [key, type] of Object.entries(schema.properties || {})) {
    if (value?.[key] !== undefined && typeof value[key] !== type) throw new Error(`input.${key} must be ${type}`);
  }
}

class SkillPlatform extends EventEmitter {
  constructor(options = {}) {
    super();
    this.now = options.now || Date.now;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 15000;
    this.failureThreshold = options.failureThreshold || 3;
    this.cooldownMs = options.cooldownMs || 60000;
    this.skills = new Map();
  }

  register(manifest, loader) {
    if (!manifest?.id || !manifest?.version || !manifest?.actions || typeof loader !== 'function') {
      throw new Error('Skill manifest requires id, version, actions and loader');
    }
    if (this.skills.has(manifest.id)) throw new Error(`Duplicate skill: ${manifest.id}`);
    this.skills.set(manifest.id, {
      manifest: JSON.parse(JSON.stringify(manifest)), loader, module: null,
      health: { failures: 0, circuitOpenUntil: 0, calls: 0, successes: 0, lastError: null }
    });
    return this;
  }

  list() {
    return [...this.skills.values()].map(({ manifest, health }) => ({ ...manifest, health: { ...health } }));
  }

  async invoke(skillId, action, input = {}, context = {}) {
    const entry = this.skills.get(skillId);
    if (!entry) throw new Error(`Unknown skill: ${skillId}`);
    const spec = entry.manifest.actions[action];
    if (!spec) throw new Error(`Unknown action: ${skillId}.${action}`);
    const now = this.now();
    if (entry.health.circuitOpenUntil > now) throw new Error(`Skill circuit open: ${skillId}`);
    const granted = new Set(context.permissions || []);
    const missing = (spec.permissions || entry.manifest.permissions || []).filter(p => !granted.has(p));
    if (missing.length) throw new Error(`Missing permissions: ${missing.join(', ')}`);
    validateShape(input, spec.input);
    entry.health.calls++;
    this.emit('skill.started', { skillId, action, at: now });
    try {
      if (!entry.module) entry.module = await entry.loader();
      const handler = entry.module[action];
      if (typeof handler !== 'function') throw new Error(`Handler missing: ${skillId}.${action}`);
      const result = await timeout(handler(input, context), spec.timeoutMs || this.defaultTimeoutMs, `${skillId}.${action}`);
      if (result?.status === 'error') throw new Error(result.message || `${skillId}.${action} failed`);
      entry.health.failures = 0;
      entry.health.successes++;
      entry.health.lastError = null;
      this.emit('skill.completed', { skillId, action, at: this.now() });
      return result;
    } catch (error) {
      entry.health.failures++;
      entry.health.lastError = String(error.message || error).slice(0, 300);
      if (entry.health.failures >= this.failureThreshold) entry.health.circuitOpenUntil = this.now() + this.cooldownMs;
      this.emit('skill.failed', { skillId, action, error: entry.health.lastError, at: this.now() });
      throw error;
    }
  }
}

class ProviderPool extends EventEmitter {
  constructor(providers = [], options = {}) {
    super();
    this.providers = providers.map((provider, index) => ({
      ...provider, priority: provider.priority ?? index,
      health: { failures: 0, circuitOpenUntil: 0, calls: 0, successes: 0, lastError: null }
    })).sort((a, b) => a.priority - b.priority);
    this.now = options.now || Date.now;
    this.timeoutMs = options.timeoutMs || 30000;
    this.failureThreshold = options.failureThreshold || 2;
    this.cooldownMs = options.cooldownMs || 120000;
  }

  snapshot() {
    return this.providers.map(({ id, priority, health }) => ({ id, priority, health: { ...health } }));
  }

  async invoke(request, context = {}) {
    const errors = [];
    for (const provider of this.providers) {
      if (provider.health.circuitOpenUntil > this.now()) continue;
      provider.health.calls++;
      try {
        const value = await timeout(provider.invoke(request, context), provider.timeoutMs || this.timeoutMs, provider.id);
        if (value === null || value === undefined || value === '') throw new Error('empty response');
        provider.health.failures = 0;
        provider.health.successes++;
        provider.health.lastError = null;
        this.emit('provider.selected', { provider: provider.id });
        return { provider: provider.id, value };
      } catch (error) {
        provider.health.failures++;
        provider.health.lastError = String(error.message || error).slice(0, 300);
        if (provider.health.failures >= this.failureThreshold) provider.health.circuitOpenUntil = this.now() + this.cooldownMs;
        errors.push(`${provider.id}: ${provider.health.lastError}`);
        this.emit('provider.failed', { provider: provider.id, error: provider.health.lastError });
      }
    }
    throw new Error(`All providers failed: ${errors.join(' | ') || 'no healthy provider'}`);
  }
}

module.exports = { SkillPlatform, ProviderPool, validateShape };